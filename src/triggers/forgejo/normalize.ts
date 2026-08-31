import type { ForgejoVerifiedDelivery } from "./webhook.js";

export const FORGEJO_SEMANTIC_TRIGGER_EVENT_NAMES = [
  "forgejo.issue_created",
  "forgejo.pull_request_created",
  "forgejo.issue_comment_created",
  "forgejo.pull_request_comment_created",
  "forgejo.issue_label_added",
  "forgejo.pull_request_label_added",
] as const;

export type ForgejoSemanticEvent = (typeof FORGEJO_SEMANTIC_TRIGGER_EVENT_NAMES)[number];

export const FORGEJO_TRIGGER_SOURCE_NAMES = [
  "forgejo.issues",
  "forgejo.issue_comment",
  "forgejo.pull_request",
  "forgejo.pull_request_review",
  "forgejo.pull_request_review_comment",
  "forgejo.push",
] as const;

export type ForgejoRawFamily = (typeof FORGEJO_TRIGGER_SOURCE_NAMES)[number];

export const FORGEJO_RECEIPT_SOURCE_NAMES = [
  "forgejo.issues",
  "forgejo.issue_comment",
  "forgejo.pull_request",
  "forgejo.pull_request_comment",
  "forgejo.push",
] as const;

export const FORGEJO_FORM_EVENT_NAMES = [
  ...FORGEJO_SEMANTIC_TRIGGER_EVENT_NAMES,
  "forgejo.push",
  "forgejo.pull_request_review",
  "forgejo.pull_request_review_comment",
] as const;

export type ForgejoFormEvent = (typeof FORGEJO_FORM_EVENT_NAMES)[number];

export const FORGEJO_TRIGGER_EVENT_NAMES = [
  ...FORGEJO_RECEIPT_SOURCE_NAMES,
  "forgejo.pull_request_review",
  "forgejo.pull_request_review_comment",
  ...FORGEJO_SEMANTIC_TRIGGER_EVENT_NAMES,
] as const;

export interface ForgejoConnectionContext {
  id: string;
  slug: string;
  instanceId: string;
}

export interface ForgejoBoundedActor {
  id: number;
  login: string;
}

export interface ForgejoBoundedRepository {
  id: number;
  full_name: string;
  owner: string;
  name: string;
  default_branch: string;
  html_url: string;
}

export interface ForgejoBoundedSubject {
  kind: "issue" | "pull_request" | "comment" | "commit";
  id: number | string;
  number: number | null;
  html_url: string | null;
}

export interface ForgejoBoundedContext {
  deliveryId: string;
  instanceId: string;
  connectionId: string;
  connectionSlug: string;
  repository: ForgejoBoundedRepository;
  actor: ForgejoBoundedActor;
  subject: ForgejoBoundedSubject | null;
  event: ForgejoRawFamily;
  action: string | null;
  ref: string | null;
  htmlUrl: string | null;
}

export interface NormalizedForgejoEvent {
  identity: { eventId: string };
  receiptSource: string;
  rawFamily: ForgejoRawFamily;
  semanticEvent: ForgejoSemanticEvent | undefined;
  context: ForgejoBoundedContext;
  text: string;
  labels: readonly string[];
  defaultBranchPush: boolean;
}

export interface ForgejoReconciliationSignal {
  type: "incomplete_label" | "incomplete_review";
  rawFamily: ForgejoRawFamily;
  expectedSemantic: ForgejoSemanticEvent | undefined;
  context: ForgejoBoundedContext;
  text: string;
  labels: readonly string[];
}

export type ForgejoNormalizedResult =
  | { kind: "event"; event: NormalizedForgejoEvent }
  | { kind: "signal"; signal: ForgejoReconciliationSignal }
  | { kind: "unclassified"; reason: string };

export function normalizeForgejoDelivery(input: {
  delivery: Pick<
    ForgejoVerifiedDelivery,
    "deliveryId" | "event" | "eventType" | "rawBody" | "connectionId"
  >;
  connection: ForgejoConnectionContext;
}): ForgejoNormalizedResult {
  const payload = parseObject(decodeRaw(input.delivery.rawBody));
  if (payload === undefined) return { kind: "unclassified", reason: "invalid_json" };
  return classifyForgejoPayload({
    deliveryId: input.delivery.deliveryId,
    event: input.delivery.event,
    eventType: input.delivery.eventType,
    payload,
    connection: input.connection,
  });
}

export function normalizeForgejoReceiptPayload(input: {
  payload: unknown;
  connection: ForgejoConnectionContext;
}): ForgejoNormalizedResult {
  const envelope = asRecord(input.payload);
  const headers = obj(envelope, "headers");
  const raw = str(envelope, "raw");
  const event = str(headers, "x-forgejo-event");
  const eventType = str(headers, "x-forgejo-event-type");
  const deliveryId = str(headers, "x-forgejo-delivery");
  if (
    raw === undefined ||
    event === undefined ||
    eventType === undefined ||
    deliveryId === undefined
  ) {
    return { kind: "unclassified", reason: "invalid_receipt_payload" };
  }
  const payload = parseObject(raw);
  if (payload === undefined) return { kind: "unclassified", reason: "invalid_json" };
  return classifyForgejoPayload({
    deliveryId,
    event,
    eventType,
    payload,
    connection: input.connection,
  });
}

export function classifyForgejoPayload(input: {
  deliveryId: string;
  event: string;
  eventType: string;
  payload: Record<string, unknown>;
  connection: ForgejoConnectionContext;
}): ForgejoNormalizedResult {
  const repository = readRepository(input.payload);
  const actor = readActor(input.payload);
  if (repository === undefined) return { kind: "unclassified", reason: "repository_missing" };
  if (actor === undefined) return { kind: "unclassified", reason: "sender_missing" };
  const rawFamily = rawFamilyFor(input.event, input.eventType);
  if (rawFamily === undefined) return { kind: "unclassified", reason: "unknown_family" };
  const action = str(input.payload, "action") ?? null;
  const ref = str(input.payload, "ref") ?? null;
  const classified = classifyFamily(input.event, input.eventType, action, input.payload);
  const subject = classified.subject;
  const context: ForgejoBoundedContext = {
    deliveryId: input.deliveryId,
    instanceId: input.connection.instanceId,
    connectionId: input.connection.id,
    connectionSlug: input.connection.slug,
    repository,
    actor,
    subject,
    event: rawFamily,
    action,
    ref,
    htmlUrl: subject?.html_url ?? repository.html_url,
  };
  if (classified.signal !== undefined) {
    return {
      kind: "signal",
      signal: {
        type: classified.signal,
        rawFamily,
        expectedSemantic: classified.expectedSemantic,
        context,
        text: classified.text,
        labels: classified.labels,
      },
    };
  }
  return {
    kind: "event",
    event: {
      identity: {
        eventId: eventIdentity(rawFamily, input.connection.id, repository.id, subject, action, ref),
      },
      receiptSource: `forgejo.${input.event}`,
      rawFamily,
      semanticEvent: classified.semantic,
      context,
      text: classified.text,
      labels: classified.labels,
      defaultBranchPush: isDefaultBranchPush(rawFamily, ref, repository.default_branch),
    },
  };
}

export function isForgejoDefaultBranchPush(event: NormalizedForgejoEvent): boolean {
  return event.defaultBranchPush;
}

function classifyFamily(
  event: string,
  eventType: string,
  action: string | null,
  payload: Record<string, unknown>,
): FamilyClassification {
  const classify = FAMILY_CLASSIFIERS[`${event}/${eventType}`];
  if (classify === undefined) return unclassifiedFamily(payload);
  return classify(action, payload);
}

interface FamilyClassification {
  semantic: ForgejoSemanticEvent | undefined;
  expectedSemantic: ForgejoSemanticEvent | undefined;
  signal: ForgejoReconciliationSignal["type"] | undefined;
  subject: ForgejoBoundedSubject | null;
  text: string;
  labels: readonly string[];
}

const FAMILY_CLASSIFIERS: Record<
  string,
  (action: string | null, payload: Record<string, unknown>) => FamilyClassification
> = {
  "issues/issue_label": (_action, payload) =>
    labelSignal("forgejo.issue_label_added", readIssueSubject(payload), payload),
  "pull_request/pull_request_label": (_action, payload) =>
    labelSignal("forgejo.pull_request_label_added", readPullRequestSubject(payload), payload),
  "pull_request_comment/pull_request_review_comment": classifyReviewWebhook,
  "issues/issues": classifyIssuesOpened,
  "pull_request/pull_request": classifyPullRequestOpened,
  "issue_comment/issue_comment": classifyIssueComment,
  "issue_comment/pull_request_comment": classifyPullRequestComment,
  "push/push": classifyPush,
};

function classifyReviewWebhook(
  _action: string | null,
  payload: Record<string, unknown>,
): FamilyClassification {
  const review = obj(payload, "review");
  return {
    semantic: undefined,
    expectedSemantic: undefined,
    signal: "incomplete_review",
    subject: readPullRequestSubject(payload),
    text: str(review, "content") ?? str(review, "body") ?? "",
    labels: labelsFor(field(obj(payload, "pull_request"), "labels")),
  };
}

function classifyIssuesOpened(
  action: string | null,
  payload: Record<string, unknown>,
): FamilyClassification {
  return completeEvent(
    action === "opened" ? "forgejo.issue_created" : undefined,
    readIssueSubject(payload),
    itemText(payload),
    labelsFor(field(obj(payload, "issue"), "labels")),
  );
}

function classifyPullRequestOpened(
  action: string | null,
  payload: Record<string, unknown>,
): FamilyClassification {
  return completeEvent(
    action === "opened" ? "forgejo.pull_request_created" : undefined,
    readPullRequestSubject(payload),
    itemText(payload),
    labelsFor(field(obj(payload, "pull_request"), "labels")),
  );
}

function classifyIssueComment(
  action: string | null,
  payload: Record<string, unknown>,
): FamilyClassification {
  const comment = obj(payload, "comment");
  return completeEvent(
    action === "created" ? "forgejo.issue_comment_created" : undefined,
    commentSubject(comment, readIssueSubject(payload)),
    str(comment, "body") ?? "",
    labelsFor(field(obj(payload, "issue"), "labels")),
  );
}

function classifyPullRequestComment(
  action: string | null,
  payload: Record<string, unknown>,
): FamilyClassification {
  const comment = obj(payload, "comment");
  return completeEvent(
    action === "created" ? "forgejo.pull_request_comment_created" : undefined,
    commentSubject(comment, readPullRequestSubject(payload) ?? readIssueSubject(payload)),
    str(comment, "body") ?? "",
    labelsFor(
      field(obj(payload, "issue"), "labels") ?? field(obj(payload, "pull_request"), "labels"),
    ),
  );
}

function classifyPush(
  _action: string | null,
  payload: Record<string, unknown>,
): FamilyClassification {
  const after = str(payload, "after");
  return completeEvent(
    undefined,
    after === undefined
      ? null
      : {
          kind: "commit",
          id: after,
          number: null,
          html_url: str(payload, "compare_url") ?? null,
        },
    pushText(payload),
    [],
  );
}

function completeEvent(
  semantic: ForgejoSemanticEvent | undefined,
  subject: ForgejoBoundedSubject | null,
  text: string,
  labels: readonly string[],
): FamilyClassification {
  return {
    semantic,
    expectedSemantic: semantic,
    signal: undefined,
    subject,
    text,
    labels,
  };
}

function unclassifiedFamily(payload: Record<string, unknown>): FamilyClassification {
  return {
    semantic: undefined,
    expectedSemantic: undefined,
    signal: undefined,
    subject: readPullRequestSubject(payload) ?? readIssueSubject(payload),
    text: "",
    labels: [],
  };
}

function labelSignal(
  expectedSemantic: ForgejoSemanticEvent,
  subject: ForgejoBoundedSubject | null,
  payload: Record<string, unknown>,
): ReturnType<typeof completeEvent> {
  const item = obj(payload, "issue") ?? obj(payload, "pull_request");
  return {
    semantic: undefined,
    expectedSemantic,
    signal: "incomplete_label",
    subject,
    text: [str(item, "title") ?? "", str(item, "body") ?? ""].filter(Boolean).join("\n"),
    labels: labelsFor(field(item, "labels")),
  };
}

function rawFamilyFor(event: string, eventType: string): ForgejoRawFamily | undefined {
  if (event === "push" && eventType === "push") return "forgejo.push";
  if (event === "issues") return "forgejo.issues";
  if (event === "issue_comment") return "forgejo.issue_comment";
  if (event === "pull_request") return "forgejo.pull_request";
  if (event === "pull_request_comment" && eventType === "pull_request_review_comment") {
    return "forgejo.pull_request_review";
  }
  return undefined;
}

function readRepository(payload: Record<string, unknown>): ForgejoBoundedRepository | undefined {
  const repo = obj(payload, "repository");
  if (repo === undefined) return undefined;
  const id = num(repo, "id");
  const fullName = str(repo, "full_name");
  const name = str(repo, "name");
  const ownerRecord = obj(repo, "owner");
  const owner = str(ownerRecord, "login") ?? asString(field(repo, "owner"));
  const defaultBranch = str(repo, "default_branch");
  const htmlUrl = str(repo, "html_url");
  if (
    id === undefined ||
    fullName === undefined ||
    name === undefined ||
    owner === undefined ||
    defaultBranch === undefined ||
    htmlUrl === undefined
  ) {
    return undefined;
  }
  return { id, full_name: fullName, owner, name, default_branch: defaultBranch, html_url: htmlUrl };
}

function readActor(payload: Record<string, unknown>): ForgejoBoundedActor | undefined {
  const sender = obj(payload, "sender");
  const id = num(sender, "id");
  const login = str(sender, "login");
  if (id === undefined || login === undefined || login.length === 0) return undefined;
  return { id, login };
}

function readIssueSubject(payload: Record<string, unknown>): ForgejoBoundedSubject | null {
  return subjectFrom(obj(payload, "issue"), "issue");
}

function readPullRequestSubject(payload: Record<string, unknown>): ForgejoBoundedSubject | null {
  return subjectFrom(obj(payload, "pull_request"), "pull_request");
}

function subjectFrom(
  item: Record<string, unknown> | undefined,
  kind: "issue" | "pull_request",
): ForgejoBoundedSubject | null {
  if (item === undefined) return null;
  const id = num(item, "id");
  if (id === undefined) return null;
  return {
    kind,
    id,
    number: num(item, "number") ?? null,
    html_url: str(item, "html_url") ?? null,
  };
}

function commentSubject(
  comment: Record<string, unknown> | undefined,
  fallback: ForgejoBoundedSubject | null,
): ForgejoBoundedSubject | null {
  const id = num(comment, "id");
  if (id === undefined) return fallback;
  return {
    kind: "comment",
    id,
    number: fallback?.number ?? null,
    html_url: str(comment, "html_url") ?? fallback?.html_url ?? null,
  };
}

function itemText(payload: Record<string, unknown>): string {
  const item = obj(payload, "issue") ?? obj(payload, "pull_request");
  return [str(item, "title") ?? "", str(item, "body") ?? ""]
    .filter((value) => value.length > 0)
    .join("\n");
}

function pushText(payload: Record<string, unknown>): string {
  const commitsValue = field(payload, "commits");
  const commits = Array.isArray(commitsValue) ? commitsValue : [];
  const messages = commits.flatMap((commit) => {
    const message = str(asRecord(commit), "message");
    return message === undefined ? [] : [message];
  });
  const ref = str(payload, "ref");
  return [ref ?? "", ...messages].filter((value) => value.length > 0).join("\n");
}

function labelsFor(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const name = str(asRecord(entry), "name");
    return name === undefined ? [] : [name];
  });
}

function field(record: Record<string, unknown> | undefined, key: string): unknown {
  return record === undefined ? undefined : record[key];
}

function obj(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  return asRecord(field(record, key));
}

function str(record: Record<string, unknown> | undefined, key: string): string | undefined {
  return asString(field(record, key));
}

function num(record: Record<string, unknown> | undefined, key: string): number | undefined {
  return asNumber(field(record, key));
}

function isDefaultBranchPush(
  rawFamily: ForgejoRawFamily,
  ref: string | null,
  defaultBranch: string,
): boolean {
  return rawFamily === "forgejo.push" && ref === `refs/heads/${defaultBranch}`;
}

function eventIdentity(
  rawFamily: ForgejoRawFamily,
  connectionId: string,
  repositoryId: number,
  subject: ForgejoBoundedSubject | null,
  action: string | null,
  ref: string | null,
): string {
  const subjectKey = subject === null ? "none" : `${subject.kind}:${String(subject.id)}`;
  return `${rawFamily}:${connectionId}:${String(repositoryId)}:${subjectKey}:${action ?? ref ?? "none"}`;
}

function decodeRaw(body: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
