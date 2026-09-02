/** Failure reason of an execution ended by Linear's `stop` signal; not an error for the user. */
export const LINEAR_STOPPED_BY_USER_REASON = "stopped_by_user";

/** Failure reason of a comment-triggered run replaced by the session opened for its comment. */
export const LINEAR_SUPERSEDED_BY_AGENT_SESSION_REASON = "superseded_by_agent_session";

export type LinearTriggerSuppressionReason =
  | typeof LINEAR_STOPPED_BY_USER_REASON
  | typeof LINEAR_SUPERSEDED_BY_AGENT_SESSION_REASON;

export type LinearTriggerStart =
  | { kind: "comment"; externalId: string }
  | { kind: "agent_session"; externalId: string; eventOccurredAt: Date };

export interface RecordLinearTriggerSuppressionsInput {
  organizationId: string;
  projectId: string;
  providerEventReceiptId: string;
  reason: LinearTriggerSuppressionReason;
  externalIds: readonly string[];
  eventOccurredAt: Date;
}

export function linearTriggerSuppressionKind(
  reason: LinearTriggerSuppressionReason,
): LinearTriggerStart["kind"] {
  return reason === LINEAR_STOPPED_BY_USER_REASON ? "agent_session" : "comment";
}

export function linearTriggerSuppressionKey(
  projectId: string,
  kind: LinearTriggerStart["kind"],
  externalId: string,
): string {
  return JSON.stringify(["linear-trigger", projectId, kind, externalId]);
}

/** Read only the provider-owned fields needed to coordinate run creation. */
export function readLinearTriggerStart(triggerContext: unknown): LinearTriggerStart | undefined {
  const linear = readNestedRecord(triggerContext, "event", "linear");
  if (linear === undefined) return undefined;
  if (linear["event_type"] === "comment") {
    const comment = readRecord(linear["comment"]);
    return typeof comment?.["id"] === "string"
      ? { kind: "comment", externalId: comment["id"] }
      : undefined;
  }
  if (linear["event_type"] === "agent_session") {
    if (typeof linear["occurred_at"] !== "string") return undefined;
    const eventOccurredAt = new Date(linear["occurred_at"]);
    if (!Number.isFinite(eventOccurredAt.getTime())) return undefined;
    const session = readRecord(linear["agent_session"]);
    return typeof session?.["id"] === "string"
      ? { kind: "agent_session", externalId: session["id"], eventOccurredAt }
      : undefined;
  }
  return undefined;
}

function readNestedRecord(value: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  let current = readRecord(value);
  for (const key of keys) {
    current = readRecord(current?.[key]);
    if (current === undefined) return undefined;
  }
  return current;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
