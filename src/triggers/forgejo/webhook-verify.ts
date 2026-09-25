import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { reportFailure } from "../../failures/index.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import type { ForgejoCredentials } from "../../providers/forgejo/client.js";
import {
  ForgeWebhookPayloadSchema,
  normalizeForgejoEventType,
  readForgeEventIdentity,
} from "./events.js";
import type { NormalizedForgejoEvent } from "./events.js";

const MAX_WEBHOOK_BYTES = 1_048_576;
const MAX_HEADER_LENGTH = 128;

// stand-in secret when no connection was found, so the HMAC still runs and an unknown
// connection id takes the same time as a known one. Otherwise the timing gap is an
// oracle for which connection ids exist.
const DUMMY_WEBHOOK_SECRET = "forgejo-webhook-timing-decoy";

/** What a connection must tell the endpoint before its deliveries can be trusted. */
export interface ForgejoWebhookConnection {
  id: string;
  webhookSecret: string;
  /** Compared against a delivery's sender.id to drop the connection's own writes. Not
   * accountLogin: a rename would let the connection's own writes re-trigger workflows. */
  accountId: number;
  /** Every other Forgejo connection's account id on the same org/instance, so a
   * sibling bot's own writes get dropped too. */
  siblingAccountIds?: readonly number[];
  /** Reused by enrichment instead of a second findConnection lookup. */
  credentials: ForgejoCredentials;
}

export interface VerifiedForgejoWebhook {
  connection: ForgejoWebhookConnection;
  deliveryId: string;
  eventType: string;
  signatureHash: string;
  event: NormalizedForgejoEvent | undefined;
  payload: unknown;
}

/**
 * Unlike GitHub, a Forgejo body carries no tenant id, so the connection id travels in
 * the URL and its secret is what the signature is checked against. That means the
 * connection lookup happens before authentication, so it's kept cheap and sits behind
 * the body-size limit.
 */
export async function verifyForgejoRequest(
  request: Request,
  options: {
    /** Returning undefined is answered exactly like a bad signature, so this never
     * becomes an oracle for which connection ids exist. */
    findConnection(connectionId: string): Promise<ForgejoWebhookConnection | undefined>;
  },
): Promise<VerifiedForgejoWebhook | Response> {
  const connectionId = readConnectionId(request);
  const signature = readSignature(request);
  if (connectionId === undefined || signature === undefined) {
    reportForgejoRejection("signature_evidence_missing", 401);
    return unauthorized();
  }

  // Bounded before the lookup, so an oversized body costs no database work.
  const body = await readBoundedRequestBody(request, MAX_WEBHOOK_BYTES);
  if (body instanceof Response) return body;

  const connection = await options.findConnection(connectionId);
  // an unknown connection answers exactly like a bad signature, and runs the HMAC
  // against a decoy secret so this path costs the same as the real check below.
  if (connection === undefined) {
    verifyForgejoSignature(DUMMY_WEBHOOK_SECRET, body, signature);
    reportForgejoRejection("connection_unknown", 401);
    return unauthorized();
  }

  if (!verifyForgejoSignature(connection.webhookSecret, body, signature)) {
    reportForgejoRejection("signature_verification_failed", 401, connection.webhookSecret);
    return unauthorized();
  }

  const rawEventType =
    request.headers.get("X-Forgejo-Event") ?? request.headers.get("X-Gitea-Event");
  const deliveryId =
    request.headers.get("X-Forgejo-Delivery") ?? request.headers.get("X-Gitea-Delivery");
  if (!usableHeader(rawEventType) || !usableHeader(deliveryId)) {
    reportForgejoRejection("required_headers_missing", 400, connection.webhookSecret);
    return new Response("Bad Request", { status: 400 });
  }
  // a review delivery's header names one of three verdict-specific events; this lets
  // a trigger be written against "forgejo.pull_request_review" instead.
  const eventType = normalizeForgejoEventType(rawEventType);

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "forgejo.webhook.parse",
        component: "triggers",
        provider: "forgejo",
        status: 400,
      },
      { status: 400, scrubValues: [connection.webhookSecret] },
    );
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const parsed = ForgeWebhookPayloadSchema.safeParse(rawJson);
  if (!parsed.success) {
    reportForgejoRejection("invalid_payload", 400, connection.webhookSecret);
    return Response.json(
      { error: "invalid webhook payload", issues: parsed.error.format() },
      { status: 400 },
    );
  }

  const identity = readForgeEventIdentity(parsed.data, eventType);
  return {
    connection,
    deliveryId,
    eventType,
    signatureHash: hashForgejoSignature(signature),
    event:
      identity === undefined
        ? undefined
        : {
            id: deliveryId,
            type: eventType,
            repo: identity.repo,
            repositoryId: identity.repositoryId,
            connectionId: connection.id,
            payload: parsed.data,
            createdAt: new Date().toISOString(),
          },
    payload: parsed.data,
  };
}

const CONNECTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The connection id is the segment after `events` in the delivery URL, anchored on that
 * segment so a trailing slash can't resolve wrong. Shape checked here: the column is a
 * uuid, so a malformed id would raise 22P02 and surface as a 500 instead of the 401 an
 * unknown id gets, leaking the exact distinction findConnection is written to avoid.
 */
function readConnectionId(request: Request): string | undefined {
  const segments = new URL(request.url).pathname.split("/").filter((part) => part.length > 0);
  const marker = segments.lastIndexOf("events");
  if (marker === -1 || segments.length !== marker + 2) return undefined;
  const candidate = segments[marker + 1];
  return candidate !== undefined && CONNECTION_ID_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * Forgejo sends the same signature under several names: `X-Hub-Signature-256` carries
 * GitHub's `sha256=` prefix, while `X-Forgejo-Signature` and `X-Gitea-Signature` carry
 * bare hex. All three are the same HMAC, so any one of them is enough.
 */
function readSignature(request: Request): string | undefined {
  const candidate =
    request.headers.get("X-Hub-Signature-256") ??
    request.headers.get("X-Forgejo-Signature") ??
    request.headers.get("X-Gitea-Signature");
  return candidate === null || candidate.length === 0 ? undefined : candidate;
}

function usableHeader(value: string | null): value is string {
  return value !== null && value.length > 0 && value.length <= MAX_HEADER_LENGTH;
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function reportForgejoRejection(reason: string, status: number, secret?: string): void {
  reportFailure(
    Object.assign(new Error("Forgejo webhook request rejected"), { code: reason }),
    { operation: "forgejo.webhook.verify", component: "triggers", provider: "forgejo", status },
    {
      status,
      kind: status === 401 ? "authentication" : "validation",
      scrubValues: secret === undefined ? [] : [secret],
    },
  );
}

/** Verify the HMAC-SHA256 over the exact raw request body. */
export function verifyForgejoSignature(
  secret: string,
  body: string | Uint8Array,
  signature: string,
): boolean {
  const normalized = canonicalForgejoSignature(signature);
  if (normalized === undefined) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(normalized, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A verified signature's spelling is not evidence; its normalized bytes are. */
function canonicalForgejoSignature(signature: string): string | undefined {
  const unprefixed = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  return /^[a-f0-9]{64}$/iu.test(unprefixed) ? unprefixed.toLowerCase() : undefined;
}

/**
 * Hashed on the canonical lowercase hex, not the raw header, so two callers signing
 * under different case/prefix spellings hash identically. Only called after
 * verifyForgejoSignature already proved this string canonicalizes.
 */
export function hashForgejoSignature(signature: string): string {
  const canonical = canonicalForgejoSignature(signature);
  if (canonical === undefined) {
    throw new Error("hashForgejoSignature called with a signature that never verified");
  }
  return createHash("sha256").update(canonical).digest("hex");
}
