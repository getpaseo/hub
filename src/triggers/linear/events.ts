import { z } from "zod";
import type { LinearIssueDetails } from "../../providers/linear/client.js";

const LinearIdSchema = z.string().min(1);
const LinearActorSchema = z.object({ id: LinearIdSchema, name: z.string().optional() });
const LinearIssueSchema = z.object({
  id: LinearIdSchema,
  identifier: z.string().min(1).optional(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string().url().optional(),
  projectId: LinearIdSchema.nullable(),
  stateId: LinearIdSchema.nullable(),
  assigneeId: LinearIdSchema.nullable(),
  labelIds: z.array(LinearIdSchema),
});
const LinearIssuePreviousSchema = z.object({
  projectId: LinearIdSchema.nullable().optional(),
  stateId: LinearIdSchema.nullable().optional(),
  assigneeId: LinearIdSchema.nullable().optional(),
  labelIds: z.array(LinearIdSchema).optional(),
});

export const NormalizedLinearIssueEventSchema = z.object({
  type: z.literal("issue"),
  action: z.enum(["create", "update", "remove"]),
  id: LinearIdSchema,
  organizationId: LinearIdSchema,
  actor: LinearActorSchema.nullable(),
  issue: LinearIssueSchema,
  updatedFrom: LinearIssuePreviousSchema,
  occurredAt: z.string().datetime().optional(),
});

export const NormalizedLinearCommentEventSchema = z.object({
  type: z.literal("comment"),
  action: z.enum(["create", "update", "remove"]),
  id: LinearIdSchema,
  organizationId: LinearIdSchema,
  actor: LinearActorSchema.nullable(),
  comment: z.object({ id: LinearIdSchema, body: z.string(), issueId: LinearIdSchema }),
  issue: LinearIssueSchema.nullable(),
  occurredAt: z.string().datetime().optional(),
});

/**
 * An agent session is Linear's own first-party record of a delegated or mentioned agent run. The
 * session, not the comment, is the durable thing an activity stream attaches to, so it carries its
 * own identity alongside the issue the work belongs to.
 */
export const NormalizedLinearAgentSessionEventSchema = z.object({
  type: z.literal("agent_session"),
  action: z.enum(["created", "prompted"]),
  id: LinearIdSchema,
  organizationId: LinearIdSchema,
  actor: LinearActorSchema.nullable(),
  agentSession: z.object({
    id: LinearIdSchema,
    status: z.string().min(1).optional(),
    commentId: LinearIdSchema.nullable(),
  }),
  issue: LinearIssueSchema.nullable(),
  /** Exactly what the human typed, so invocation parsing sees the same text a comment would give. */
  prompt: z.string(),
  /** Linear's pre-rendered issue and discussion context; absent on some follow-up deliveries. */
  promptContext: z.string().nullable(),
  occurredAt: z.string().datetime().optional(),
});

export const NormalizedLinearEventSchema = z.discriminatedUnion("type", [
  NormalizedLinearIssueEventSchema,
  NormalizedLinearCommentEventSchema,
  NormalizedLinearAgentSessionEventSchema,
]);

export type NormalizedLinearIssue = z.infer<typeof LinearIssueSchema>;
export type NormalizedLinearIssueEvent = z.infer<typeof NormalizedLinearIssueEventSchema>;
export type NormalizedLinearCommentEvent = z.infer<typeof NormalizedLinearCommentEventSchema>;
export type NormalizedLinearAgentSessionEvent = z.infer<
  typeof NormalizedLinearAgentSessionEventSchema
>;
export type NormalizedLinearEvent = z.infer<typeof NormalizedLinearEventSchema>;

/**
 * Linear's webhook data follows its entity model but not every event embeds related objects. This
 * adapter accepts both the compact webhook shape and relation-expanded test/development payloads.
 */
export function normalizeLinearEvent(
  payload: unknown,
  eventName?: string | null,
  hydratedIssue?: LinearIssueDetails,
): NormalizedLinearEvent | undefined {
  const session = normalizeAgentSessionEvent(payload, eventName, hydratedIssue);
  if (session !== undefined) return session;
  const envelope = readEnvelope(payload, eventName);
  if (envelope === undefined) return undefined;
  return envelope.kind === "issue"
    ? normalizeIssueEvent(envelope, hydratedIssue)
    : normalizeCommentEvent(envelope, hydratedIssue);
}

export function eventIssueId(event: NormalizedLinearEvent): string | undefined {
  if (event.type === "issue") return event.issue.id;
  if (event.type === "comment") return event.comment.issueId;
  return event.issue?.id;
}

export function eventProjectId(event: NormalizedLinearEvent): string | undefined {
  return event.issue?.projectId ?? undefined;
}

export function isAgentSessionEventName(eventName: string | null | undefined): boolean {
  return (eventName ?? "").toLowerCase().replace(/[^a-z]/gu, "") === "agentsessionevent";
}

/**
 * Agent session deliveries carry `agentSession` where entity webhooks carry `data`, so they are
 * recognized before the entity envelope reader rather than through it.
 */
function normalizeAgentSessionEvent(
  payload: unknown,
  eventName: string | null | undefined,
  hydratedIssue: LinearIssueDetails | undefined,
): NormalizedLinearEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const declaredType = typeof payload["type"] === "string" ? payload["type"] : undefined;
  if (!isAgentSessionEventName(eventName) && !isAgentSessionEventName(declaredType)) {
    return undefined;
  }
  const session = asRecord(payload["agentSession"]);
  const organizationId = firstDefined(
    readString(payload["organizationId"]),
    readString(session?.["organizationId"]),
  );
  const sessionId = readString(session?.["id"]);
  const action = readSessionAction(payload["action"]);
  if (session === undefined || organizationId === undefined || sessionId === undefined) {
    return undefined;
  }
  if (action === undefined) return undefined;
  const comment = asRecord(session["comment"]);
  const issue = normalizeIssue(asRecord(session["issue"]) ?? {}, hydratedIssue);
  return NormalizedLinearAgentSessionEventSchema.parse({
    type: "agent_session",
    action,
    id: sessionId,
    organizationId,
    actor: readSessionActor(payload, session, comment),
    agentSession: {
      id: sessionId,
      ...optionalProperty("status", readString(session["status"])),
      commentId: readString(comment?.["id"]) ?? null,
    },
    issue: issue ?? null,
    prompt: readSessionPrompt(payload, session) ?? "",
    promptContext: readNullableString(payload["promptContext"]) ?? null,
    ...optionalProperty("occurredAt", readDate(payload["createdAt"])),
  });
}

/** The human who opened the session: its creator, the delivery actor, or the comment's author. */
function readSessionActor(
  payload: Record<string, unknown>,
  session: Record<string, unknown>,
  comment: Record<string, unknown> | undefined,
): { id: string; name?: string } | null {
  return (
    normalizeActor(session["creator"]) ??
    normalizeActor(payload["actor"]) ??
    normalizeActor(comment?.["user"]) ??
    null
  );
}

function readSessionAction(value: unknown): "created" | "prompted" | undefined {
  return value === "created" || value === "prompted" ? value : undefined;
}

/**
 * The human's words live in the triggering comment on `created` and in the follow-up activity on
 * `prompted`. Both spellings of an activity body are accepted so a schema tweak cannot mute a run.
 */
function readSessionPrompt(
  payload: Record<string, unknown>,
  session: Record<string, unknown>,
): string | undefined {
  const activity = asRecord(payload["agentActivity"]);
  return firstDefined(
    readString(asRecord(activity?.["content"])?.["body"]),
    readString(activity?.["body"]),
    readString(asRecord(session["comment"])?.["body"]),
    readString(payload["promptContext"]),
  );
}

interface LinearEnvelope {
  kind: "issue" | "comment";
  action: "create" | "update" | "remove";
  organizationId: string;
  payload: Record<string, unknown>;
  data: Record<string, unknown>;
  occurredAt?: string;
}

function readEnvelope(
  payload: unknown,
  eventName: string | null | undefined,
): LinearEnvelope | undefined {
  if (!isRecord(payload)) return undefined;
  const action = readAction(payload["action"]);
  const organizationId = readString(payload["organizationId"]);
  const data = asRecord(payload["data"]);
  const kind = readKind(eventName, payload["type"]);
  if (
    action === undefined ||
    organizationId === undefined ||
    data === undefined ||
    kind === undefined
  ) {
    return undefined;
  }
  // A signed delivery timestamp proves freshness, but it is not a causal event timestamp: a
  // comment can be created before the delivery is emitted. Prefer the comment's own timestamp
  // so deferred history can exclude the trigger and all later comments. If neither entity nor
  // event time is supplied, context materialization safely leaves history unavailable.
  const occurredAt = firstDefined(
    kind === "comment" ? readDate(data["createdAt"]) : undefined,
    readDate(payload["createdAt"]),
  );
  return {
    kind,
    action,
    organizationId,
    payload,
    data,
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}

function normalizeIssueEvent(
  envelope: LinearEnvelope,
  hydratedIssue: LinearIssueDetails | undefined,
): NormalizedLinearEvent | undefined {
  const issue = normalizeIssue(envelope.data, hydratedIssue);
  if (issue === undefined) return undefined;
  return NormalizedLinearIssueEventSchema.parse({
    type: "issue",
    action: envelope.action,
    id: firstDefined(readString(envelope.data["id"]), issue.id),
    organizationId: envelope.organizationId,
    actor: normalizeActor(envelope.payload["actor"]),
    issue,
    updatedFrom: normalizePreviousIssue(envelope.payload["updatedFrom"]),
    ...(envelope.occurredAt === undefined ? {} : { occurredAt: envelope.occurredAt }),
  });
}

function normalizeCommentEvent(
  envelope: LinearEnvelope,
  hydratedIssue: LinearIssueDetails | undefined,
): NormalizedLinearEvent | undefined {
  const commentId = readString(envelope.data["id"]);
  const issueId = firstDefined(
    readString(envelope.data["issueId"]),
    readString(asRecord(envelope.data["issue"])?.["id"]),
  );
  if (commentId === undefined || issueId === undefined) return undefined;
  return NormalizedLinearCommentEventSchema.parse({
    type: "comment",
    action: envelope.action,
    id: commentId,
    organizationId: envelope.organizationId,
    actor:
      normalizeActor(envelope.payload["actor"]) ??
      normalizeActor(envelope.data["user"]) ??
      actorFromUserId(envelope.data) ??
      null,
    comment: { id: commentId, body: readString(envelope.data["body"]) ?? "", issueId },
    issue: normalizeIssue(asRecord(envelope.data["issue"]) ?? {}, hydratedIssue) ?? null,
    ...(envelope.occurredAt === undefined ? {} : { occurredAt: envelope.occurredAt }),
  });
}

function normalizeIssue(
  data: Record<string, unknown>,
  hydrated: LinearIssueDetails | undefined,
): NormalizedLinearIssue | undefined {
  const id = firstDefined(readString(data["id"]), hydrated?.id);
  if (id === undefined) return undefined;
  const title = firstDefined(readString(data["title"]), hydrated?.title);
  if (title === undefined) return undefined;
  const identifier = firstDefined(readString(data["identifier"]), hydrated?.identifier);
  const url = firstDefined(readString(data["url"]), hydrated?.url);
  return {
    id,
    ...optionalProperty("identifier", identifier),
    title,
    description: nullableValue(data, "description", hydrated?.description ?? null),
    ...optionalProperty("url", url),
    projectId: relatedId(data, "projectId", "project", hydrated?.projectId ?? null),
    stateId: relatedId(data, "stateId", "state", hydrated?.stateId ?? null),
    assigneeId: relatedId(data, "assigneeId", "assignee", hydrated?.assigneeId ?? null),
    labelIds: firstDefined(readLabelIds(data), hydrated?.labelIds) ?? [],
  };
}

function actorFromUserId(data: Record<string, unknown>): { id: string } | undefined {
  const id = readString(data["userId"]);
  return id === undefined ? undefined : { id };
}

function nullableValue(
  data: Record<string, unknown>,
  key: string,
  fallback: string | null,
): string | null {
  const value = readNullableString(data[key]);
  return value === undefined ? fallback : value;
}

function relatedId(
  data: Record<string, unknown>,
  directKey: string,
  relationKey: string,
  fallback: string | null,
): string | null {
  const direct = readNullableId(data, directKey);
  if (direct !== undefined) return direct;
  if (hasOwn(data, relationKey) && data[relationKey] === null) return null;
  const nested = readNullableId(asRecord(data[relationKey]), "id");
  return nested === undefined ? fallback : nested;
}

function optionalProperty(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
}

function normalizePreviousIssue(value: unknown): z.infer<typeof LinearIssuePreviousSchema> {
  const previous = asRecord(value);
  if (previous === undefined) return {};
  return {
    ...(hasOwn(previous, "projectId") || hasOwn(previous, "project")
      ? { projectId: readPreviousRelatedId(previous, "projectId", "project") }
      : {}),
    ...(hasOwn(previous, "stateId") || hasOwn(previous, "state")
      ? { stateId: readPreviousRelatedId(previous, "stateId", "state") }
      : {}),
    ...(hasOwn(previous, "assigneeId") || hasOwn(previous, "assignee")
      ? { assigneeId: readPreviousRelatedId(previous, "assigneeId", "assignee") }
      : {}),
    ...(hasOwn(previous, "labelIds") || hasOwn(previous, "labels")
      ? { labelIds: readLabelIds(previous) ?? [] }
      : {}),
  };
}

function readPreviousRelatedId(
  previous: Record<string, unknown>,
  directKey: string,
  relationKey: string,
): string | null | undefined {
  return firstDefined(
    readNullableId(previous, directKey),
    previous[relationKey] === null ? null : readNullableId(asRecord(previous[relationKey]), "id"),
  );
}

function normalizeActor(value: unknown): { id: string; name?: string } | null {
  const actor = asRecord(value);
  if (actor === undefined) return null;
  const id = readString(actor["id"]);
  if (id === undefined) return null;
  const name = readString(actor["name"]) ?? readString(actor["displayName"]);
  return name === undefined ? { id } : { id, name };
}

function readKind(
  eventName: string | null | undefined,
  type: unknown,
): "issue" | "comment" | undefined {
  const value = (eventName ?? (typeof type === "string" ? type : "")).toLowerCase();
  if (value.includes("issue")) return "issue";
  if (value.includes("comment")) return "comment";
  return undefined;
}

function readAction(value: unknown): "create" | "update" | "remove" | undefined {
  return value === "create" || value === "update" || value === "remove" ? value : undefined;
}

function readLabelIds(value: Record<string, unknown>): string[] | undefined {
  const direct = value["labelIds"];
  if (Array.isArray(direct) && direct.every((candidate) => typeof candidate === "string")) {
    return direct;
  }
  const labels = value["labels"];
  const nodes = Array.isArray(labels) ? labels : asRecord(labels)?.["nodes"];
  if (!Array.isArray(nodes)) return undefined;
  return nodes.flatMap((candidate) => {
    const id = readString(asRecord(candidate)?.["id"]);
    return id === undefined ? [] : [id];
  });
}

function readNullableId(
  value: Record<string, unknown> | undefined,
  key: string,
): string | null | undefined {
  if (value === undefined || !hasOwn(value, key)) return undefined;
  return readNullableString(value[key]);
}

function readNullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readDate(value: unknown): string | undefined {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
    return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
