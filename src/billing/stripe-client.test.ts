import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, beforeEach, describe, it } from "vitest";
import type { CreateCheckoutSessionInput } from "./stripe-billing-client.js";
import { createStripeBillingClient } from "./stripe-client.js";

interface StripeRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: URLSearchParams;
}

/** Stripe's API as far as Checkout creation can observe it: it records each request. */
class LocalStripe {
  readonly requests: StripeRequest[] = [];
  private readonly server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      this.requests.push({
        path: request.url ?? "",
        headers: request.headers,
        body: new URLSearchParams(body),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `cs_test_${this.requests.length}`,
          object: "checkout.session",
          url: "https://checkout.stripe.test/c/pay",
        }),
      );
    });
  });

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("server has no port");
    return `http://127.0.0.1:${address.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
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
      url: "https://checkout.stripe.test/c/pay",
    });

    const [request] = stripe.requests;
    assert.equal(request?.path, "/v1/checkout/sessions");
    assert.equal(request?.body.get("allow_promotion_codes"), "true");
    assert.equal(request?.body.get("client_reference_id"), "org-acme");
  });

  it("collapses identical checkout attempts and keys a changed checkout afresh", async () => {
    const client = createStripeBillingClient("sk_test_local", { apiBaseUrl });

    await client.createCheckoutSession(CHECKOUT);
    await client.createCheckoutSession(CHECKOUT);
    await client.createCheckoutSession({ ...CHECKOUT, quantity: 4 });

    const [first, retry, changed] = stripe.requests.map(
      (request) => request.headers["idempotency-key"],
    );
    assert.equal(typeof first, "string");
    assert.equal(retry, first);
    // Stripe refuses a reused key whose parameters differ for 24 hours, so a checkout whose
    // request changed (a seat added, a new Checkout option shipped) must not reuse the old key.
    assert.notEqual(changed, first);
  });
});
