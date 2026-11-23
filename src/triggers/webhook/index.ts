import type { EntitlementsService } from "../../entitlements/service.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import type { TriggerProvider } from "../index.js";

export { WebhookRepository } from "./internal/repository.js";

export interface WebhookEndpoint {
  triggerId: string;
  endpointId: string;
  hasSecret: boolean;
}

export type WebhookSecretAction = "create" | "rotate";

export interface WebhookMetadata {
  contentType: string;
  receivedAt: string;
}

export interface WebhookDelivery extends WebhookMetadata {
  body: string;
}

export type WebhookAcceptance =
  | { status: "accepted"; runId: string }
  | { status: "unauthorized" | "disabled" | "limit" | "rate_limited" };

export interface WebhookStore {
  list(organizationId: string): Promise<WebhookEndpoint[]>;
  rotate(
    organizationId: string,
    triggerId: string,
    action?: WebhookSecretAction,
  ): Promise<{ endpointId: string; secret: string } | undefined>;
  authenticate(endpointId: string, token: string): Promise<string | undefined>;
  accept(input: {
    endpointId: string;
    token: string;
    idempotencyKey: string | null;
    delivery: WebhookDelivery;
    hasExecutionHeadroom: boolean;
  }): Promise<WebhookAcceptance>;
}

const maxBodyBytes = 32 * 1024;
const endpointPattern = /^wh_[A-Za-z0-9_-]{32}$/u;
const bearerPattern = /^Bearer (whsec_[A-Za-z0-9_-]{43})$/iu;

export async function handleWebhookDelivery(
  request: Request,
  endpointId: string,
  store: WebhookStore,
  entitlements: EntitlementsService,
): Promise<Response> {
  const token = bearerPattern.exec(request.headers.get("authorization") ?? "")?.[1];
  if (token === undefined || !endpointPattern.test(endpointId)) return unauthorized();
  const organizationId = await store.authenticate(endpointId, token);
  if (organizationId === undefined) return unauthorized();

  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey !== null && !/^[!-~]{1,200}$/u.test(idempotencyKey)) {
    return Response.json({ error: "invalid_idempotency_key" }, { status: 400 });
  }
  const delivery = await readDelivery(request);
  if (delivery instanceof Response) return delivery;
  const { used, limit } = await entitlements.usage(organizationId, "executions.monthly");
  const result = await store.accept({
    endpointId,
    token,
    idempotencyKey,
    delivery,
    hasExecutionHeadroom: limit === null || used < limit,
  });
  return acceptanceResponse(result);
}

async function readDelivery(request: Request): Promise<WebhookDelivery | Response> {
  const bytes = await readBoundedRequestBody(request, maxBodyBytes);
  if (bytes instanceof Response) return bytes;
  const contentType =
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "text/plain";
  if (!/^[\w!#$&^.+-]{1,63}\/[\w!#$&^.+-]{1,127}$/u.test(contentType)) {
    return Response.json({ error: "invalid_content_type" }, { status: 400 });
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (contentType === "application/json" || contentType.endsWith("+json")) JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid_payload" }, { status: 400 });
  }

  if (body.includes("\u0000")) {
    return Response.json({ error: "invalid_payload" }, { status: 400 });
  }
  return { body, contentType, receivedAt: new Date().toISOString() };
}

function acceptanceResponse(result: WebhookAcceptance): Response {
  switch (result.status) {
    case "accepted":
      return Response.json(result, { status: 202 });
    case "unauthorized":
      return unauthorized();
    case "disabled":
      return Response.json({ error: "webhook_disabled" }, { status: 409 });
    case "limit":
      return Response.json({ error: "execution_limit_reached" }, { status: 403 });
    case "rate_limited":
      return Response.json(
        { error: "rate_limited" },
        { status: 429, headers: { "Retry-After": "60" } },
      );
  }
  throw new Error("Unknown webhook acceptance status");
}

function unauthorized(): Response {
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

export function createWebhookProvider(): TriggerProvider<"webhook", { event: WebhookMetadata }> {
  return {
    name: "webhook",
    eventNames: ["webhook.received"],
    async match() {
      // Authenticated intake creates the durable run and wakeup in a single transaction.
      return [];
    },
    async materializeContext({ triggerContext }) {
      return { webhook: triggerContext.event };
    },
  };
}
