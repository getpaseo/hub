import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { WebhookPayloadSchema } from "../../auth/github-events.js";
import type { WebhookPayload } from "../../auth/github-events.js";
import type { ProviderEventAcceptance } from "../../db/types.js";
import { reportFailure } from "../../failures/index.js";
import type { InboundEvent, InboundSink } from "../../inbound/index.js";
import { logger } from "../../logger.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import { logProviderEventIntake } from "../audit.js";

const MAX_WEBHOOK_BYTES = 1_048_576;
const MAX_HEADER_LENGTH = 128;

/** The inbound event kind a verified GitHub delivery is queued under. */
export const GITHUB_WEBHOOK_EVENT = "github.webhook";

export interface WebhookSourceOptions {
  /** Holds a verified delivery until `process` accepts it. */
  inbound: InboundSink;
  accept(input: {
    installationId: number;
    repositoryId?: number;
    deliveryId: string;
    signatureHash: string;
    source: string;
    repo?: string | null;
    payload: unknown;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
  applyLifecycle(input: {
    installationId: number;
    event: "installation" | "installation_repositories";
    deliveryId: string;
    signatureHash: string;
    source: string;
    payload: unknown;
    receivedAt: Date;
  }): Promise<void>;
  synchronizePush?(input: {
    installationId: number;
    repositoryId: number;
    deliveryId: string;
    payload: unknown;
  }): Promise<void>;
}

export interface WebhookEndpoint extends TriggerSource {
  /** Verifies a delivery and queues it. Answers before Postgres is touched. */
  handle(request: Request): Promise<Response>;
  /** The `github.webhook` processor: records the receipt and dispatches matching triggers. */
  process(event: InboundEvent): Promise<void>;
}

const VerifiedWebhookSchema = z.object({
  body: WebhookPayloadSchema,
  deliveryId: z.string(),
  eventType: z.string(),
  signatureHash: z.string(),
});

type VerifiedWebhook = z.infer<typeof VerifiedWebhookSchema>;

/**
 * A verified delivery as GitHub sent it, which is what the queue holds. The payload schema turns
 * unreadable fields into `undefined`, which is not JSON, so `process` applies it after the queue.
 */
interface QueuedWebhook {
  body: unknown;
  deliveryId: string;
  eventType: string;
  signatureHash: string;
}

/**
 * @param secret the App's webhook secret, or `undefined` when event triggers are not set up.
 * Without a secret there is nothing to check a signature against, so every delivery is refused
 * rather than trusted — an unconfigured endpoint must not become an unauthenticated one.
 */
export function createWebhookSource(
  secret: string | undefined,
  options: WebhookSourceOptions,
): WebhookEndpoint {
  const handlers = new Set<TriggerHandler>();

  async function handle(request: Request): Promise<Response> {
    const verified = await verifyDelivery(request, secret);
    if (verified instanceof Response) return verified;
    try {
      const queued = await options.inbound.enqueue({
        kind: GITHUB_WEBHOOK_EVENT,
        id: `github:${verified.deliveryId}`,
        receivedAt: new Date().toISOString(),
        payload: verified,
      });
      if (queued.status === "queued" || queued.status === "duplicate") {
        return new Response("OK", { status: 200 });
      }
      return Response.json({ error: "inbound_unavailable" }, { status: 503 });
    } catch (error) {
      reportFailure(
        error,
        {
          operation: "github.webhook.handle",
          component: "triggers",
          provider: "github",
          status: 500,
        },
        { status: 500, scrubValues: secret === undefined ? [] : [secret] },
      );
      return Response.json({ error: "webhook_processing_failed" }, { status: 500 });
    }
  }

  async function process(event: InboundEvent): Promise<void> {
    const queued = VerifiedWebhookSchema.safeParse(event.payload);
    if (!queued.success) {
      reportFailure(new Error("queued GitHub webhook is malformed"), {
        operation: "github.webhook.process",
        component: "triggers",
        provider: "github",
      });
      return;
    }
    await processVerifiedWebhook(queued.data, new Date(event.receivedAt), options, handlers);
  }

  return {
    handle,
    process,
    async start(nextHandler: TriggerHandler): Promise<void> {
      handlers.add(nextHandler);
    },
    async stop(): Promise<void> {
      handlers.clear();
    },
  };
}

/**
 * The GitHub endpoint of an instance without a database. Signatures are still checked, so an
 * unsigned request learns nothing, and a signed one is told the database is unavailable.
 */
export function createDatabaseUnavailableWebhook(
  secret: string | undefined,
): Pick<WebhookEndpoint, "handle"> {
  return {
    async handle(request) {
      const verified = await verifyDelivery(request, secret);
      if (verified instanceof Response) return verified;
      return Response.json({ error: "database_unavailable" }, { status: 503 });
    },
  };
}

async function verifyDelivery(
  request: Request,
  secret: string | undefined,
): Promise<QueuedWebhook | Response> {
  if (secret === undefined) {
    reportGitHubRejection("webhook_secret_unconfigured", 503);
    return new Response("Service Unavailable", { status: 503 });
  }
  return verifyWebhookRequest(request, secret);
}

async function processVerifiedWebhook(
  verified: VerifiedWebhook,
  receivedAt: Date,
  options: WebhookSourceOptions,
  handlers: Set<TriggerHandler>,
): Promise<void> {
  const { body, deliveryId, eventType, signatureHash } = verified;
  const installationId = body.installation?.id;
  if (typeof installationId !== "number") return;

  if (eventType === "installation" || eventType === "installation_repositories") {
    await handleLifecycle(options, verified, installationId, eventType, receivedAt);
    return;
  }

  const event = normalizeWebhookEvent({ body, deliveryId, eventType, receivedAt });
  if (event === undefined) {
    logger.info({ deliveryId, eventType }, "skipping webhook event without repo or installation");
    const acceptance = await options.accept({
      installationId,
      deliveryId,
      signatureHash,
      source: `github.${eventType}`,
      payload: body,
      receivedAt,
      dropReason: "no_trigger_for_source",
    });
    logProviderEventIntake({
      provider: "github",
      source: `github.${eventType}`,
      deliveryId,
      acceptance,
    });
    return;
  }

  const acceptance = await options.accept({
    installationId: event.installationId,
    repositoryId: event.repositoryId,
    deliveryId,
    signatureHash,
    source: `github.${eventType}`,
    repo: event.repo,
    payload: event,
    receivedAt,
    ...(handlers.size === 0 ? { dropReason: "configuration_unavailable" } : {}),
  });
  logProviderEventIntake({
    provider: "github",
    source: `github.${eventType}`,
    deliveryId,
    repository: event.repo,
    resourceId: String(event.repositoryId),
    acceptance,
  });
  if (eventType === "push" && options.synchronizePush !== undefined) {
    await options.synchronizePush({
      installationId: event.installationId,
      repositoryId: event.repositoryId,
      deliveryId,
      payload: body,
    });
  }

  if (acceptance.status !== "accepted") return;

  await dispatchWebhook(handlers, acceptance.events);
}

async function verifyWebhookRequest(
  request: Request,
  secret: string,
): Promise<QueuedWebhook | Response> {
  const signature = request.headers.get("X-Hub-Signature-256") ?? undefined;

  if (signature === undefined) {
    reportGitHubRejection("signature_header_missing", 401, secret);
    return new Response("Unauthorized", { status: 401 });
  }

  const captured = await readBoundedRequestBody(request, MAX_WEBHOOK_BYTES);
  if (captured instanceof Response) return captured;

  if (!verifySignature(secret, captured, signature)) {
    reportGitHubRejection("signature_verification_failed", 401, secret, signature);
    return new Response("Unauthorized", { status: 401 });
  }

  const signatureHash = hashWebhookSignature(signature);
  const eventType = request.headers.get("X-GitHub-Event") ?? undefined;
  const deliveryId = request.headers.get("X-GitHub-Delivery") ?? undefined;

  if (
    eventType === undefined ||
    deliveryId === undefined ||
    eventType.length > MAX_HEADER_LENGTH ||
    deliveryId.length > MAX_HEADER_LENGTH ||
    eventType.length === 0 ||
    deliveryId.length === 0
  ) {
    reportGitHubRejection("required_headers_missing", 400, secret, signature);
    return new Response("Bad Request", { status: 400 });
  }

  let rawJson: unknown;

  try {
    rawJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(captured));
  } catch (error) {
    reportFailure(
      error,
      { operation: "github.webhook.parse", component: "triggers", provider: "github", status: 400 },
      { status: 400, scrubValues: [secret, signature] },
    );
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsedBody = WebhookPayloadSchema.safeParse(rawJson);

  if (!parsedBody.success) {
    reportGitHubRejection("invalid_payload", 400, secret, signature);
    return Response.json(
      { error: "invalid webhook payload", issues: parsedBody.error.format() },
      { status: 400 },
    );
  }

  if (typeof parsedBody.data.installation?.id !== "number") {
    reportGitHubRejection("installation_id_missing", 400, secret, signature);
    return new Response("Bad Request", { status: 400 });
  }

  return { body: rawJson, deliveryId, eventType, signatureHash };
}

/** A refused delivery is an unsigned one (401), an unconfigured endpoint (503), or malformed. */
function rejectionKind(status: number): "authentication" | "conflict" | "validation" {
  if (status === 401) return "authentication";
  if (status === 503) return "conflict";
  return "validation";
}

function reportGitHubRejection(
  reason: string,
  status: number,
  secret?: string,
  signature?: string,
): void {
  reportFailure(
    Object.assign(new Error("GitHub webhook request rejected"), { code: reason }),
    { operation: "github.webhook.verify", component: "triggers", provider: "github", status },
    {
      status,
      kind: rejectionKind(status),
      scrubValues: [
        ...(secret === undefined ? [] : [secret]),
        ...(signature === undefined ? [] : [signature]),
      ],
    },
  );
}

async function handleLifecycle(
  options: WebhookSourceOptions,
  webhook: VerifiedWebhook,
  installationId: number,
  eventType: "installation" | "installation_repositories",
  receivedAt: Date,
): Promise<void> {
  await options.applyLifecycle({
    installationId,
    event: eventType,
    deliveryId: webhook.deliveryId,
    signatureHash: webhook.signatureHash,
    source: `github.${webhook.eventType}`,
    payload: webhook.body,
    receivedAt,
  });
  logger.info(
    {
      provider: "github",
      source: `github.${webhook.eventType}`,
      deliveryId: webhook.deliveryId,
      installationId,
    },
    "provider lifecycle event accepted",
  );
}

async function dispatchWebhook(
  handlers: Set<TriggerHandler>,
  triggers: readonly Parameters<TriggerHandler>[0][],
): Promise<void> {
  await Promise.all(
    triggers.flatMap((trigger) => Array.from(handlers, (handler) => handler(trigger))),
  );
}

export function verifySignature(
  secret: string,
  payload: string | Uint8Array,
  signature: string,
): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");

  if (expected.length !== signature.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function hashWebhookSignature(signature: string): string {
  return createHash("sha256").update(signature).digest("hex");
}

export function normalizeWebhookEvent(options: {
  body: WebhookPayload;
  deliveryId: string;
  eventType: string;
  receivedAt: Date;
}): NormalizedGitHubEvent | undefined {
  const repo = options.body.repository?.full_name;
  const repositoryId = options.body.repository?.id;
  const installationId = options.body.installation?.id;

  if (typeof repo !== "string" || repo.length === 0) {
    return undefined;
  }

  if (typeof installationId !== "number") {
    return undefined;
  }

  if (typeof repositoryId !== "number") {
    return undefined;
  }

  return {
    id: options.deliveryId,
    type: options.eventType,
    repo,
    repositoryId,
    installationId,
    payload: options.body,
    createdAt: options.receivedAt.toISOString(),
  };
}
