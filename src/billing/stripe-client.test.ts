import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { CreateCheckoutSessionInput } from "./stripe-billing-client.js";
import { createStripeBillingClient } from "./stripe-client.js";

interface CheckoutSession {
  id: string;
  object: "checkout.session";
  customer: string;
  status: "open" | "expired";
  url: string;
  params: URLSearchParams;
}

/**
 * Stripe's Checkout Sessions API as far as Hub can observe it. A create replays its first
 * response for a reused idempotency key, as Stripe does, and refuses a reused key whose
 * parameters differ.
 */
class LocalStripe {
  private readonly sessions: CheckoutSession[] = [];
  private readonly replays = new Map<string, { body: string; session: CheckoutSession }>();
  private readonly server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => this.handle(request, body, response));
  });

  get checkoutSessions(): readonly CheckoutSession[] {
    return this.sessions;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("server has no port");
    return `http://127.0.0.1:${address.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private handle(request: IncomingMessage, body: string, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://stripe.test");
    if (request.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const key = String(request.headers["idempotency-key"]);
      const replay = this.replays.get(key);
      if (replay !== undefined && replay.body !== body) {
        return send(response, 400, { error: { type: "idempotency_error" } });
      }
      if (replay !== undefined) return send(response, 200, view(replay.session));
      const params = new URLSearchParams(body);
      const id = `cs_test_${this.sessions.length + 1}`;
      const session: CheckoutSession = {
        id,
        object: "checkout.session",
        customer: params.get("customer") ?? "",
        status: "open",
        url: `https://checkout.stripe.test/c/pay/${id}`,
        params,
      };
      this.sessions.push(session);
      this.replays.set(key, { body, session });
      return send(response, 200, view(session));
    }
    if (request.method === "GET" && url.pathname === "/v1/checkout/sessions") {
      const data = this.sessions
        .filter((session) => session.customer === url.searchParams.get("customer"))
        .filter((session) => session.status === url.searchParams.get("status"))
        .map(view);
      return send(response, 200, { object: "list", data, has_more: false });
    }
    const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/u.exec(url.pathname);
    const session = this.sessions.find((candidate) => candidate.id === expire?.[1]);
    if (request.method === "POST" && session?.status === "open") {
      session.status = "expired";
      return send(response, 200, view(session));
    }
    send(response, 400, { error: { type: "invalid_request_error" } });
  }
}

function view({ params: _params, ...session }: CheckoutSession) {
  return session;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const CHECKOUT: CreateCheckoutSessionInput = {
  organizationId: "org-acme",
  customerId: "cus_acme",
  priceId: "price_team",
  quantity: 3,
  successUrl: "https://hub.test/billing?checkout=success",
  cancelUrl: "https://hub.test/billing",
};

describe("Stripe billing client", () => {
  let stripe: LocalStripe;
  let apiBaseUrl: string;

  beforeEach(async () => {
    stripe = new LocalStripe();
    apiBaseUrl = await stripe.start();
  });

  afterEach(() => stripe.stop());

  it("lets the customer enter a promotion code in Checkout", async () => {
    const client = createStripeBillingClient("sk_test_local", { apiBaseUrl });

    assert.deepEqual(await client.createCheckoutSession(CHECKOUT), {
      url: "https://checkout.stripe.test/c/pay/cs_test_1",
    });

    const [session] = stripe.checkoutSessions;
    assert.equal(session?.params.get("allow_promotion_codes"), "true");
    assert.equal(session?.params.get("client_reference_id"), "org-acme");
  });

  it("reuses the open Checkout link for an identical retry", async () => {
    const client = createStripeBillingClient("sk_test_local", { apiBaseUrl });

    const first = await client.createCheckoutSession(CHECKOUT);
    const retry = await client.createCheckoutSession(CHECKOUT);

    assert.deepEqual(retry, first);
    assert.deepEqual(
      stripe.checkoutSessions.map(({ id, status }) => ({ id, status })),
      [{ id: "cs_test_1", status: "open" }],
    );
  });

  it("leaves only the newest Checkout link payable when the checkout changes", async () => {
    const client = createStripeBillingClient("sk_test_local", { apiBaseUrl });

    await client.createCheckoutSession(CHECKOUT);
    await client.createCheckoutSession({ ...CHECKOUT, quantity: 4 });
    const plan = await client.createCheckoutSession({ ...CHECKOUT, priceId: "price_business" });

    assert.deepEqual(plan, { url: "https://checkout.stripe.test/c/pay/cs_test_3" });
    assert.deepEqual(
      stripe.checkoutSessions.map(({ id, status }) => ({ id, status })),
      [
        { id: "cs_test_1", status: "expired" },
        { id: "cs_test_2", status: "expired" },
        { id: "cs_test_3", status: "open" },
      ],
    );
  });
});
