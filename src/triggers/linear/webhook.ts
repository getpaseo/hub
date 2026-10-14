import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderEventAcceptance } from "../../db/types.js";
import { readBoundedRequestBody } from "../../http/request-body.js";
import { logger } from "../../logger.js";
import { logProviderEventIntake } from "../audit.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import {
  eventIssueId,
  eventProjectId,
  eventTeamId,
  hasExplicitNullLinearProject,
  normalizeLinearEvent,
} from "./events.js";
import type { LinearApiClient, LinearIssueDetails } from "../../providers/linear/client.js";

const MAX_WEBHOOK_BYTES = 1_048_576;
const MAX_TIMESTAMP_SKEW_MS = 60_000;
/** Linear opens its own session with the delegation; give its write time to land first. */
const DELEGATION_SESSION_CHECK_DELAY_MS = 5_000;
/** A session the app got this close to the delegation is the one Linear opened for it. */
const DELEGATION_SESSION_MATCH_WINDOW_MS = 10_000;
const DELEGATION_DELIVERY_PREFIX = "linear-delegation:";

export interface LinearWebhookSourceOptions {
  signingSecret: string;
  now?: () => number;
  canHydrateIssue?(linearOrganizationId: string): Promise<boolean>;
  /** The installed app's own Linear user, whose events are never a reason to start work. */
  appUserId?(linearOrganizationId: string): Promise<string | undefined>;
  resolveIssue?(input: {
    linearOrganizationId: string;
    issueId: string;
  }): Promise<LinearIssueDetails | undefined>;
  /**
   * Linear opens no session when an issue is delegated to an app that already has one on it.
   * With these, Hub opens it instead, so every delegation starts work.
   */
  delegatedSessions?: {
    canOpen(linearOrganizationId: string): Promise<boolean>;
    client: Pick<LinearApiClient, "readIssueAgentSessions" | "createAgentSessionOnIssue">;
    /** Runs the session check after the webhook is answered. Tests run it inline. */
    defer?: (task: () => Promise<void>) => void;
  };
  accept(input: {
    linearOrganizationId: string;
    projectId?: string;
    teamId?: string;
    deliveryId: string;
    signatureHash: string;
    source: string;
    payload: unknown;
    receivedAt: Date;
    dropReason?: ProviderEventDropReasonCode;
  }): Promise<ProviderEventAcceptance>;
}

export interface LinearWebhookEndpoint extends TriggerSource {
  handle(request: Request): Promise<Response>;
}

interface VerifiedLinearRequest {
  deliveryId: string;
  eventName: string | null;
  payload: unknown;
  signatureHash: string;
  receivedAt: Date;
}

export function createLinearWebhookSource(
  options: LinearWebhookSourceOptions,
): LinearWebhookEndpoint {
  const handlers = new Set<TriggerHandler>();
  // Sessions Hub opened itself. Linear may still announce one, with no creator to show it was
  // the app, so its own `created` event must not start a second run.
  const openedSessionIds = new Set<string>();
  return {
    async handle(request) {
      const verified = await verifyLinearRequest(request, options);
      if (verified instanceof Response) return verified;
      const response = await handoffLinearEvent(verified, handlers, options, openedSessionIds);
      if (response.status === 200) {
        await scheduleDelegatedSession(verified, handlers, options, openedSessionIds);
      }
      return response;
    },
    async start(handler) {
      handlers.add(handler);
    },
    async stop() {
      handlers.clear();
    },
  };
}

async function verifyLinearRequest(
  request: Request,
  options: Pick<LinearWebhookSourceOptions, "signingSecret" | "now">,
): Promise<VerifiedLinearRequest | Response> {
  const deliveryId = request.headers.get("linear-delivery");
  const signature = request.headers.get("linear-signature");
  if (deliveryId === null || signature === null) {
    logger.warn("rejecting Linear event because signature evidence is missing");
    return new Response("Unauthorized", { status: 401 });
  }
  const body = await readBoundedRequestBody(request, MAX_WEBHOOK_BYTES);
  if (body instanceof Response) return body;
  const normalizedSignature = canonicalLinearSignature(signature);
  if (
    normalizedSignature === undefined ||
    !verifyLinearSignature(options.signingSecret, body, normalizedSignature)
  ) {
    logger.warn("rejecting Linear event because signature verification failed");
    return new Response("Unauthorized", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    logger.warn("rejecting Linear event because payload is invalid JSON");
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const receivedAt = new Date(options.now?.() ?? Date.now());
  if (!verifyLinearWebhookTimestamp(payload, receivedAt.getTime())) {
    logger.warn("rejecting Linear event because its signed webhook timestamp is stale or invalid");
    return new Response("Unauthorized", { status: 401 });
  }
  return {
    deliveryId,
    eventName: request.headers.get("linear-event"),
    payload,
    signatureHash: createHash("sha256").update(normalizedSignature).digest("hex"),
    receivedAt,
  };
}

async function handoffLinearEvent(
  verified: VerifiedLinearRequest,
  handlers: Set<TriggerHandler>,
  options: LinearWebhookSourceOptions,
  /** `created` events for these sessions are ignored. */
  ignoredSessionIds: ReadonlySet<string>,
): Promise<Response> {
  try {
    let event = normalizeLinearEvent(verified.payload, verified.eventName);
    if (event === undefined) {
      logger.info({ deliveryId: verified.deliveryId }, "ignoring unsupported Linear event");
      return new Response("OK", { status: 200 });
    }
    if (await isAuthoredByApp(event, options)) {
      logger.info({ deliveryId: verified.deliveryId }, "ignoring Linear event authored by Paseo");
      return new Response("OK", { status: 200 });
    }
    if (
      event.type === "agent_session" &&
      event.action === "created" &&
      ignoredSessionIds.has(event.agentSession.id)
    ) {
      logger.info({ deliveryId: verified.deliveryId }, "ignoring Linear session Paseo opened");
      return new Response("OK", { status: 200 });
    }
    const hasCompleteTeamRoute =
      eventTeamId(event) !== undefined &&
      hasExplicitNullLinearProject(verified.payload, verified.eventName);
    // Issue webhooks carry their filter fields directly. Comment and Agent Session issue
    // relations can be compact even when they already identify a project or team.
    const needsIssueHydration =
      event.type !== "issue" || (eventProjectId(event) === undefined && !hasCompleteTeamRoute);
    if (needsIssueHydration && options.resolveIssue !== undefined) {
      const source = linearEventSource(event);
      if (
        options.canHydrateIssue !== undefined &&
        !(await options.canHydrateIssue(event.organizationId))
      ) {
        return await acceptAndDispatchLinearEvent(event, source, verified, handlers, options, true);
      }
      const issue = await options.resolveIssue({
        linearOrganizationId: event.organizationId,
        issueId: eventIssueId(event),
      });
      event = normalizeLinearEvent(verified.payload, verified.eventName, issue);
    }
    if (event === undefined) {
      logger.warn({ deliveryId: verified.deliveryId }, "Linear event issue hydration was invalid");
      return Response.json({ error: "invalid_linear_event" }, { status: 400 });
    }
    return await acceptAndDispatchLinearEvent(
      event,
      linearEventSource(event),
      verified,
      handlers,
      options,
    );
  } catch (error) {
    logger.error({ err: error, deliveryId: verified.deliveryId }, "Linear event handoff failed");
    return Response.json({ error: "event_handoff_unavailable" }, { status: 503 });
  }
}

async function acceptAndDispatchLinearEvent(
  event: NonNullable<ReturnType<typeof normalizeLinearEvent>>,
  source: "linear.issue" | "linear.comment" | "linear.agent_session",
  verified: VerifiedLinearRequest,
  handlers: Set<TriggerHandler>,
  options: LinearWebhookSourceOptions,
  preserveBindingDrop = false,
): Promise<Response> {
  const projectId = eventProjectId(event);
  const teamId = eventTeamId(event);
  const acceptance = await options.accept({
    linearOrganizationId: event.organizationId,
    ...(projectId === undefined ? {} : { projectId }),
    ...(teamId === undefined ? {} : { teamId }),
    deliveryId: verified.deliveryId,
    signatureHash: verified.signatureHash,
    source,
    payload: event,
    receivedAt: verified.receivedAt,
    ...(handlers.size === 0 && !preserveBindingDrop
      ? { dropReason: "configuration_unavailable" }
      : {}),
  });
  logProviderEventIntake({
    provider: "linear",
    source,
    deliveryId: verified.deliveryId,
    resourceId: projectId ?? teamId,
    acceptance,
  });
  const events = acceptance.status === "accepted" ? acceptance.events : [];
  await Promise.all(
    events.flatMap((acceptedEvent) => Array.from(handlers, (handler) => handler(acceptedEvent))),
  );
  return new Response("OK", { status: 200 });
}

interface LinearDelegation {
  organizationId: string;
  issueId: string;
  issue: Record<string, unknown>;
  actor: Record<string, unknown> | undefined;
  delegatedAt: string;
  delegateId: string;
  previousDelegateId: unknown;
}

/**
 * Delegating an issue to the app opens a Linear session, except when the app already has one on
 * the issue: then Linear only sets the delegate. After Linear has had time to open its own, Hub
 * opens the missing one and dispatches it as Linear would have, with the delegator as its actor.
 */
async function scheduleDelegatedSession(
  verified: VerifiedLinearRequest,
  handlers: Set<TriggerHandler>,
  options: LinearWebhookSourceOptions,
  openedSessionIds: Set<string>,
): Promise<void> {
  const delegatedSessions = options.delegatedSessions;
  if (delegatedSessions === undefined || options.appUserId === undefined) return;
  const delegation = readDelegation(verified.payload, verified.eventName);
  if (delegation === undefined) return;
  try {
    const appUserId = await options.appUserId(delegation.organizationId);
    if (
      appUserId === undefined ||
      delegation.delegateId !== appUserId ||
      delegation.previousDelegateId === appUserId ||
      delegation.actor?.["id"] === appUserId ||
      !(await delegatedSessions.canOpen(delegation.organizationId))
    ) {
      return;
    }
    const defer = delegatedSessions.defer ?? deferDelegatedSessionCheck;
    defer(() =>
      openDelegatedSession(
        delegation,
        appUserId,
        verified,
        handlers,
        options,
        delegatedSessions.client,
        openedSessionIds,
      ),
    );
  } catch (error) {
    logger.error(
      { err: error, deliveryId: verified.deliveryId },
      "Linear delegation session check failed",
    );
  }
}

function deferDelegatedSessionCheck(task: () => Promise<void>): void {
  setTimeout(() => void task(), DELEGATION_SESSION_CHECK_DELAY_MS);
}

async function openDelegatedSession(
  delegation: LinearDelegation,
  appUserId: string,
  verified: VerifiedLinearRequest,
  handlers: Set<TriggerHandler>,
  options: LinearWebhookSourceOptions,
  client: NonNullable<LinearWebhookSourceOptions["delegatedSessions"]>["client"],
  openedSessionIds: Set<string>,
): Promise<void> {
  try {
    const target = {
      linearOrganizationId: delegation.organizationId,
      issueId: delegation.issueId,
    };
    const delegatedAt = Date.parse(delegation.delegatedAt);
    const sessions = await client.readIssueAgentSessions(target);
    if (
      sessions.some(
        (session) =>
          session.appUserId === appUserId &&
          Date.parse(session.createdAt) >= delegatedAt - DELEGATION_SESSION_MATCH_WINDOW_MS,
      )
    ) {
      return;
    }
    const session = await client.createAgentSessionOnIssue(target);
    openedSessionIds.add(session.id);
    const deliveryId = `${DELEGATION_DELIVERY_PREFIX}${session.id}`;
    logger.info(
      { deliveryId: verified.deliveryId, agentSessionId: session.id },
      "opened the Linear session a delegation did not",
    );
    const response = await handoffLinearEvent(
      {
        deliveryId,
        eventName: "AgentSessionEvent",
        payload: {
          type: "AgentSessionEvent",
          action: "created",
          organizationId: delegation.organizationId,
          createdAt: session.createdAt,
          appUserId,
          agentSession: {
            id: session.id,
            appUserId,
            issueId: delegation.issueId,
            status: session.status,
            ...(session.url === undefined ? {} : { url: session.url }),
            createdAt: session.createdAt,
            ...(delegation.actor === undefined ? {} : { creator: delegation.actor }),
            issue: delegation.issue,
          },
        },
        signatureHash: createHash("sha256").update(deliveryId).digest("hex"),
        receivedAt: new Date(options.now?.() ?? Date.now()),
      },
      handlers,
      options,
      new Set(),
    );
    if (response.status !== 200) {
      logger.error({ deliveryId }, "the Linear session Paseo opened was not dispatched");
    }
  } catch (error) {
    logger.error(
      { err: error, deliveryId: verified.deliveryId },
      "opening a Linear session for a delegation failed",
    );
  }
}

/** An issue update that changed its delegate. */
function readDelegation(payload: unknown, eventName: string | null): LinearDelegation | undefined {
  if (!isRecord(payload) || payload["action"] !== "update") return undefined;
  const kind = eventName ?? payload["type"];
  if (typeof kind !== "string" || kind.toLowerCase() !== "issue") return undefined;
  const issue = asRecord(payload["data"]);
  const previous = asRecord(payload["updatedFrom"]);
  const organizationId = payload["organizationId"];
  if (issue === undefined || previous === undefined || typeof organizationId !== "string") {
    return undefined;
  }
  if (!Object.hasOwn(previous, "delegateId")) return undefined;
  const issueId = issue["id"];
  const delegateId = issue["delegateId"] ?? asRecord(issue["delegate"])?.["id"];
  const delegatedAt = readTimestamp(payload["createdAt"]) ?? readTimestamp(issue["updatedAt"]);
  if (typeof issueId !== "string" || typeof delegateId !== "string" || delegatedAt === undefined) {
    return undefined;
  }
  return {
    organizationId,
    issueId,
    issue,
    actor: asRecord(payload["actor"]),
    delegatedAt,
    delegateId,
    previousDelegateId: previous["delegateId"],
  };
}

function readTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function linearEventSource(
  event: NonNullable<ReturnType<typeof normalizeLinearEvent>>,
): "linear.issue" | "linear.comment" | "linear.agent_session" {
  if (event.type === "issue") return "linear.issue";
  return event.type === "comment" ? "linear.comment" : "linear.agent_session";
}

/** Verify Linear's HMAC-SHA256 over the exact raw request body. */
export function verifyLinearSignature(
  secret: string,
  body: string | Uint8Array,
  signature: string,
): boolean {
  const normalizedSignature = canonicalLinearSignature(signature);
  if (normalizedSignature === undefined) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(normalizedSignature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A verified signature's spelling is not evidence; its normalized bytes are. */
function canonicalLinearSignature(signature: string): string | undefined {
  const unprefixed = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  return /^[a-f0-9]{64}$/iu.test(unprefixed) ? unprefixed.toLowerCase() : undefined;
}

/** The timestamp is inside the HMAC-protected body, so it can safely prevent replay. */
export function verifyLinearWebhookTimestamp(
  payload: unknown,
  nowMilliseconds = Date.now(),
): boolean {
  if (!isRecord(payload)) return false;
  const timestampMilliseconds = parseLinearWebhookTimestamp(payload["webhookTimestamp"]);
  return (
    timestampMilliseconds !== undefined &&
    Math.abs(nowMilliseconds - timestampMilliseconds) <= MAX_TIMESTAMP_SKEW_MS
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLinearWebhookTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

/** Paseo's own comments would otherwise match a `from_users: ["*"]` trigger and answer themselves. */
async function isAuthoredByApp(
  event: NonNullable<ReturnType<typeof normalizeLinearEvent>>,
  options: Pick<LinearWebhookSourceOptions, "appUserId">,
): Promise<boolean> {
  if (event.actor === null || options.appUserId === undefined) return false;
  return event.actor.id === (await options.appUserId(event.organizationId));
}
