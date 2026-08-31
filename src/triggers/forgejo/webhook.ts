import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ForgejoRepositoryHookRecord } from "../../db/types.js";
import { isDatabaseUnavailableError } from "../../db/errors.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import {
  decryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import type { ForgejoDirectory } from "../../providers/forgejo/instances.js";

export const MAX_WEBHOOK_BYTES = 1_048_576;
export const MAX_HEADER_LENGTH = 128;
export const FORGEJO_DELIVERY_PATTERN = /^[0-9a-f-]{36}$/u;
export const FORGEJO_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/u;

const ADMITTED_HOOK_STATUSES = new Set(["pending_verification", "active", "manual_pending"]);
const ADMITTED_WEBHOOK_SECRET_STATUSES = new Set(["active", "rotating"]);

export interface ForgejoVerifiedDelivery {
  connectionId: string;
  organizationId: string;
  repositoryId: number;
  deliveryId: string;
  event: string;
  eventType: string;
  signatureHash: string;
  rawBody: Uint8Array;
  receivedAt: Date;
}

export type AcceptVerifiedForgejoDelivery = (
  delivery: ForgejoVerifiedDelivery,
) => Promise<
  | { status: "accepted" }
  | { status: "duplicate" }
  | { status: "conflict" }
  | { status: "unavailable" }
>;

export interface ForgejoIngressOptions {
  directory: ForgejoDirectory;
  secrets: SecretEncryptionKeySource;
  accept?: AcceptVerifiedForgejoDelivery;
  now?: () => Date;
}

export function verifyForgejoSignature(
  secret: string,
  body: Uint8Array,
  signature: string,
): boolean {
  if (!FORGEJO_SIGNATURE_PATTERN.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return constantTimeEqual(signature, expected);
}

export function hashForgejoSignature(signature: string): string {
  return createHash("sha256").update(signature).digest("hex");
}

export async function handleForgejoIngress(
  request: Request,
  connectionId: string,
  options: ForgejoIngressOptions,
): Promise<Response> {
  const headers = readForgejoHeaders(request);
  if (headers instanceof Response) return headers;
  const body = await readBoundedRequestBody(request, MAX_WEBHOOK_BYTES);
  if (body instanceof Response) return body;
  try {
    const connection = await options.directory.findConnectionById(connectionId);
    if (connection === undefined || !isAdmittedConnection(connection.status)) {
      return jsonError("unauthorized", 401);
    }
    const secrets = (await options.directory.listWebhookSecretsForConnection(connectionId)).filter(
      (secret) => ADMITTED_WEBHOOK_SECRET_STATUSES.has(secret.status),
    );
    if (secrets.length === 0) return jsonError("unavailable", 503);
    let signatureVerified = false;
    for (const secretRow of secrets) {
      const secret = decryptSecret(
        options.secrets,
        {
          alg: "aes-256-gcm",
          keyId: secretRow.keyId,
          nonce: secretRow.nonce,
          ciphertext: secretRow.ciphertext,
          aadVersion: 1,
        },
        {
          organizationId: secretRow.organizationId,
          credentialId: secretRow.id,
          kind: "webhook_secret",
        },
      );
      if (verifyForgejoSignature(secret, body, headers.signature)) {
        signatureVerified = true;
        break;
      }
    }
    if (!signatureVerified) {
      return jsonError("unauthorized", 401);
    }
    const repositoryId = repositoryIdFromBody(body);
    if (repositoryId === undefined) return jsonError("malformed", 400);
    const repositories = await options.directory.listRepositoriesForConnection(connectionId);
    const enrolled = repositories.find((row) => row.repositoryId === repositoryId && row.enrolled);
    if (enrolled === undefined) return jsonError("unconfigured", 400);
    const hook = await options.directory.findRepositoryHook(connectionId, repositoryId);
    if (hook === undefined || !ADMITTED_HOOK_STATUSES.has(hook.status)) {
      return jsonError("unconfigured", 400);
    }
    const receivedAt = options.now?.() ?? new Date();
    await recordForgejoHookDelivery(options.directory, hook, receivedAt);
    const delivery: ForgejoVerifiedDelivery = {
      connectionId,
      organizationId: connection.organizationId,
      repositoryId,
      deliveryId: headers.deliveryId,
      event: headers.event,
      eventType: headers.eventType,
      signatureHash: hashForgejoSignature(headers.signature),
      rawBody: body,
      receivedAt,
    };
    if (options.accept === undefined) return jsonError("unavailable", 503);
    return ackForgejoAcceptance(await options.accept(delivery));
  } catch (error) {
    if (isDatabaseUnavailableError(error)) return jsonError("unavailable", 503);
    return jsonError("unavailable", 503);
  }
}

async function recordForgejoHookDelivery(
  directory: ForgejoDirectory,
  hook: ForgejoRepositoryHookRecord,
  receivedAt: Date,
): Promise<void> {
  if (hook.status === "pending_verification" || hook.status === "manual_pending") {
    await directory.upsertRepositoryHook({ ...hook, status: "active", lastVerifiedAt: receivedAt });
    return;
  }
  if (hook.lastVerifiedAt === null) {
    await directory.upsertRepositoryHook({ ...hook, lastVerifiedAt: receivedAt });
  }
}

function ackForgejoAcceptance(
  accepted: Awaited<ReturnType<AcceptVerifiedForgejoDelivery>>,
): Response {
  if (accepted.status === "accepted" || accepted.status === "duplicate") {
    return new Response("OK", { status: 200 });
  }
  if (accepted.status === "conflict") {
    return Response.json({ error: "forgejo_delivery_conflict" }, { status: 409 });
  }
  return jsonError("unavailable", 503);
}

export function readForgejoHeaders(
  request: Request,
): { deliveryId: string; event: string; eventType: string; signature: string } | Response {
  const deliveryId = request.headers.get("x-forgejo-delivery");
  const event = request.headers.get("x-forgejo-event");
  const eventType = request.headers.get("x-forgejo-event-type");
  const signature = request.headers.get("x-forgejo-signature");
  if (deliveryId === null || event === null || eventType === null || signature === null) {
    return jsonError("malformed", 400);
  }
  if (
    deliveryId.length > MAX_HEADER_LENGTH ||
    event.length > MAX_HEADER_LENGTH ||
    eventType.length > MAX_HEADER_LENGTH ||
    signature.length > MAX_HEADER_LENGTH
  ) {
    return jsonError("malformed", 400);
  }
  if (
    !FORGEJO_DELIVERY_PATTERN.test(deliveryId) ||
    event.length === 0 ||
    eventType.length === 0 ||
    !FORGEJO_SIGNATURE_PATTERN.test(signature)
  ) {
    return jsonError("malformed", 400);
  }
  return { deliveryId, event, eventType, signature };
}

function isAdmittedConnection(status: string): boolean {
  return status === "active" || status === "degraded";
}

function repositoryIdFromBody(body: Uint8Array): number | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const root: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) root[key] = value;
    const repository = root["repository"];
    if (typeof repository !== "object" || repository === null || Array.isArray(repository)) {
      return undefined;
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(repository)) fields[key] = value;
    const id = fields["id"];
    return typeof id === "number" && Number.isInteger(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}
