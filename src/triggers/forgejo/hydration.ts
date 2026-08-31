import type {
  TriggerHandler,
  TriggerProvider,
  TriggerProviderMatch,
  TriggerProviderReactionState,
  TriggerSource,
} from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type { ForgejoHydrationConsumer } from "./dispatch.js";
import { registerForgejoHydrationConsumer } from "./dispatch.js";
import {
  matchForgejoTriggers,
  readForgejoInvocationMessage,
  readForgejoInvocationParserMessage,
  readForgejoMention,
} from "./matching.js";
import type {
  ForgejoBoundedContext,
  ForgejoRawFamily,
  ForgejoReconciliationSignal,
  NormalizedForgejoEvent,
} from "./normalize.js";
import { FORGEJO_TRIGGER_SOURCE_NAMES } from "./normalize.js";
import type { ForgejoTriggerContext } from "./provider.js";
import type { ForgejoVerifiedDelivery } from "./webhook.js";
import type {
  ForgejoHydrationReactionClient,
  ForgejoHydrationReactionContent,
  ForgejoHydrationReactionSubject,
} from "./hydration-reactions.js";
import type {
  ForgejoHydratedSourceRecordKind,
  ForgejoHydrationCursorKey,
  ForgejoHydrationRecordKind,
  ForgejoHydrationStore,
} from "./hydration-store.js";

export type {
  ForgejoHydratedSourceRecordKind,
  ForgejoHydrationCursorKey,
  ForgejoHydrationRecordKind,
  ForgejoHydrationStore,
};

export interface ForgejoRecoveredHydrationEvent {
  semanticEvent:
    | "forgejo.issue_label_added"
    | "forgejo.pull_request_label_added"
    | "forgejo.pull_request_review"
    | "forgejo.pull_request_review_comment";
  sourceRecordKind: ForgejoHydratedSourceRecordKind;
  sourceRecordId: number;
  subjectKind: "issue" | "pull_request";
  subjectId: number;
  htmlUrl: string | null;
  reactionSubject: "issue" | "pull_request" | "review_comment" | null;
}

export interface ForgejoHydrationClient {
  listSubjects(input: {
    connectionId: string;
    owner: string;
    repo: string;
    kind: "issue" | "pull_request";
  }): Promise<readonly number[]>;
  listTimeline(input: {
    connectionId: string;
    owner: string;
    repo: string;
    index: number;
  }): Promise<readonly unknown[]>;
  listReviews(input: {
    connectionId: string;
    owner: string;
    repo: string;
    index: number;
  }): Promise<readonly unknown[]>;
  listReviewComments(input: {
    connectionId: string;
    owner: string;
    repo: string;
    index: number;
    reviewId: number;
  }): Promise<readonly unknown[]>;
}

export function classifyForgejoTimelineRecord(
  record: unknown,
  subjectKind: "issue" | "pull_request",
): ForgejoRecoveredHydrationEvent | undefined {
  const row = asRecord(record);
  if (row === undefined) return undefined;
  const id = num(row, "id");
  const type = str(row, "type");
  if (id === undefined || type === undefined) return undefined;
  if (type === "label" && str(row, "body") === "1") {
    return {
      semanticEvent:
        subjectKind === "issue" ? "forgejo.issue_label_added" : "forgejo.pull_request_label_added",
      sourceRecordKind: "label",
      sourceRecordId: id,
      subjectKind,
      subjectId: 0,
      htmlUrl: str(row, "html_url") ?? null,
      reactionSubject: subjectKind,
    };
  }
  if (type === "review" && subjectKind === "pull_request") {
    const reviewId = num(row, "review_id");
    if (reviewId === undefined || reviewId === 0) return undefined;
    return {
      semanticEvent: "forgejo.pull_request_review",
      sourceRecordKind: "review",
      sourceRecordId: reviewId,
      subjectKind,
      subjectId: 0,
      htmlUrl: str(row, "html_url") ?? null,
      reactionSubject: null,
    };
  }
  return undefined;
}

export function classifyForgejoReviewComment(
  record: unknown,
): ForgejoRecoveredHydrationEvent | undefined {
  const row = asRecord(record);
  if (row === undefined) return undefined;
  const id = num(row, "id");
  if (id === undefined) return undefined;
  return {
    semanticEvent: "forgejo.pull_request_review_comment",
    sourceRecordKind: "review_comment",
    sourceRecordId: id,
    subjectKind: "pull_request",
    subjectId: 0,
    htmlUrl: str(row, "html_url") ?? null,
    reactionSubject: "review_comment",
  };
}

export function createMemoryForgejoHydrationStore(): ForgejoHydrationStore {
  const cursors = new Map<string, number>();
  const events = new Set<string>();
  return {
    async getCursor(key) {
      return cursors.get(cursorKey(key));
    },
    async seedCursor(key, cursorRecordId) {
      const id = cursorKey(key);
      if (!cursors.has(id)) cursors.set(id, cursorRecordId);
    },
    async insertRecoveredAndAdvance(input) {
      const eventKey = [
        input.key.connectionId,
        String(input.key.repositoryId),
        input.key.subjectKind,
        String(input.key.subjectId),
        input.sourceRecordKind,
        String(input.sourceRecordId),
      ].join(":");
      const existed = events.has(eventKey);
      events.add(eventKey);
      const current = cursors.get(cursorKey(input.key)) ?? 0;
      if (input.cursorRecordId > current) cursors.set(cursorKey(input.key), input.cursorRecordId);
      return existed ? "duplicate" : "inserted";
    },
  };
}

export interface ForgejoHydrationRecoveryInput {
  receiptId: string;
  delivery: ForgejoVerifiedDelivery;
  signal: ForgejoReconciliationSignal;
}

export function createForgejoHydrationConsumer(options: {
  store: ForgejoHydrationStore;
  client: ForgejoHydrationClient;
  onRecovered?: (
    event: ForgejoRecoveredHydrationEvent,
    input: ForgejoHydrationRecoveryInput,
  ) => Promise<void>;
}): ForgejoHydrationConsumer {
  return {
    async consume(input) {
      const recovered = await hydrateSignal(options, input.signal, input.delivery.organizationId);
      if (options.onRecovered === undefined) return;
      for (const event of recovered) await options.onRecovered(event, input);
    },
  };
}

export function forgejoReviewHasReactionSubject(): false {
  return false;
}

async function hydrateSignal(
  options: {
    store: ForgejoHydrationStore;
    client: ForgejoHydrationClient;
  },
  signal: ForgejoReconciliationSignal,
  organizationId: string,
): Promise<ForgejoRecoveredHydrationEvent[]> {
  const subject = signal.context.subject;
  if (subject === null || (subject.kind !== "issue" && subject.kind !== "pull_request")) {
    return [];
  }
  const subjectId = subject.number ?? numId(subject.id);
  if (subjectId === undefined) return [];
  const owner = signal.context.repository.owner;
  const repo = signal.context.repository.name;
  const connectionId = signal.context.connectionId;
  const repositoryId = signal.context.repository.id;
  const recovered: ForgejoRecoveredHydrationEvent[] = [];
  if (signal.type === "incomplete_label") {
    recovered.push(
      ...(await hydrateTimeline({
        options,
        organizationId,
        connectionId,
        repositoryId,
        owner,
        repo,
        subjectKind: subject.kind,
        subjectId,
      })),
    );
  }
  if (signal.type === "incomplete_review" && subject.kind === "pull_request") {
    recovered.push(
      ...(await hydrateTimeline({
        options,
        organizationId,
        connectionId,
        repositoryId,
        owner,
        repo,
        subjectKind: subject.kind,
        subjectId,
      })),
      ...(await hydrateReviewComments({
        options,
        organizationId,
        connectionId,
        repositoryId,
        owner,
        repo,
        subjectId,
      })),
    );
  }
  return recovered;
}

async function hydrateTimeline(input: {
  options: { store: ForgejoHydrationStore; client: ForgejoHydrationClient };
  organizationId: string;
  connectionId: string;
  repositoryId: number;
  owner: string;
  repo: string;
  subjectKind: "issue" | "pull_request";
  subjectId: number;
}): Promise<ForgejoRecoveredHydrationEvent[]> {
  const key: ForgejoHydrationCursorKey = {
    connectionId: input.connectionId,
    repositoryId: input.repositoryId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    recordKind: "timeline",
  };
  const records = await input.options.client.listTimeline({
    connectionId: input.connectionId,
    owner: input.owner,
    repo: input.repo,
    index: input.subjectId,
  });
  return scanRecords({
    key,
    organizationId: input.organizationId,
    store: input.options.store,
    records,
    classify: (record) => classifyForgejoTimelineRecord(record, input.subjectKind),
    subjectId: input.subjectId,
    advanceUnclassified: true,
  });
}

async function hydrateReviewComments(input: {
  options: { store: ForgejoHydrationStore; client: ForgejoHydrationClient };
  organizationId: string;
  connectionId: string;
  repositoryId: number;
  owner: string;
  repo: string;
  subjectId: number;
}): Promise<ForgejoRecoveredHydrationEvent[]> {
  const key: ForgejoHydrationCursorKey = {
    connectionId: input.connectionId,
    repositoryId: input.repositoryId,
    subjectKind: "pull_request",
    subjectId: input.subjectId,
    recordKind: "review_comment",
  };
  const reviews = await input.options.client.listReviews({
    connectionId: input.connectionId,
    owner: input.owner,
    repo: input.repo,
    index: input.subjectId,
  });
  const records: unknown[] = [];
  for (const review of reviews) {
    const reviewId = recordId(review);
    if (reviewId === undefined) continue;
    records.push(
      ...(await input.options.client.listReviewComments({
        connectionId: input.connectionId,
        owner: input.owner,
        repo: input.repo,
        index: input.subjectId,
        reviewId,
      })),
    );
  }
  return scanRecords({
    key,
    organizationId: input.organizationId,
    store: input.options.store,
    records,
    classify: classifyForgejoReviewComment,
    subjectId: input.subjectId,
    advanceUnclassified: false,
  });
}

async function scanRecords(input: {
  key: ForgejoHydrationCursorKey;
  organizationId: string;
  store: ForgejoHydrationStore;
  records: readonly unknown[];
  classify: (record: unknown) => ForgejoRecoveredHydrationEvent | undefined;
  subjectId: number;
  advanceUnclassified: boolean;
}): Promise<ForgejoRecoveredHydrationEvent[]> {
  const ordered = sortByRecordId(input.records);
  const cursor = await input.store.getCursor(input.key);
  if (cursor === undefined) {
    await input.store.seedCursor(input.key, maxRecordId(ordered));
    return [];
  }
  const recovered: ForgejoRecoveredHydrationEvent[] = [];
  for (const record of ordered) {
    const id = recordId(record);
    if (id === undefined || id <= cursor) continue;
    const classified = input.classify(record);
    if (classified === undefined) {
      if (input.advanceUnclassified) {
        await input.store.insertRecoveredAndAdvance({
          key: input.key,
          organizationId: input.organizationId,
          sourceRecordKind: "timeline",
          sourceRecordId: id,
          cursorRecordId: id,
        });
      }
      continue;
    }
    const event = { ...classified, subjectId: input.subjectId };
    const outcome = await input.store.insertRecoveredAndAdvance({
      key: input.key,
      organizationId: input.organizationId,
      sourceRecordKind: event.sourceRecordKind,
      sourceRecordId: event.sourceRecordId,
      cursorRecordId: id,
    });
    if (outcome === "inserted") recovered.push(event);
  }
  return recovered;
}

function sortByRecordId(records: readonly unknown[]): unknown[] {
  return [...records].toSorted((left, right) => {
    const leftId = recordId(left) ?? 0;
    const rightId = recordId(right) ?? 0;
    return leftId - rightId;
  });
}

function maxRecordId(records: readonly unknown[]): number {
  let max = 0;
  for (const record of records) {
    const id = recordId(record);
    if (id !== undefined && id > max) max = id;
  }
  return max;
}

function cursorKey(key: ForgejoHydrationCursorKey): string {
  return [
    key.connectionId,
    String(key.repositoryId),
    key.subjectKind,
    String(key.subjectId),
    key.recordKind,
  ].join(":");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordId(value: unknown): number | undefined {
  return isRecord(value) ? numId(value["id"]) : undefined;
}

function str(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" ? item : undefined;
}

function num(value: Record<string, unknown>, key: string): number | undefined {
  return numId(value[key]);
}

function numId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export const FORGEJO_HYDRATED_TRIGGER_EVENT_NAMES = [
  "forgejo.issue_label_added",
  "forgejo.pull_request_label_added",
  "forgejo.pull_request_review",
  "forgejo.pull_request_review_comment",
] as const;

export async function seedForgejoHydrationForRepository(input: {
  store: ForgejoHydrationStore;
  client: ForgejoHydrationClient;
  connectionId: string;
  repositoryId: number;
  owner: string;
  repo: string;
}): Promise<void> {
  const issues = await input.client.listSubjects({
    connectionId: input.connectionId,
    owner: input.owner,
    repo: input.repo,
    kind: "issue",
  });
  for (const subjectId of issues) {
    await seedSubjectKind({ ...input, subjectKind: "issue", subjectId });
  }
  const pulls = await input.client.listSubjects({
    connectionId: input.connectionId,
    owner: input.owner,
    repo: input.repo,
    kind: "pull_request",
  });
  for (const subjectId of pulls) {
    await seedSubjectKind({ ...input, subjectKind: "pull_request", subjectId });
  }
}

export function createForgejoHydrationSource(options: {
  store: ForgejoHydrationStore;
  client: ForgejoHydrationClient;
  listTargets: (input: {
    organizationId: string;
    connectionId: string;
    repositoryId: number;
  }) => Promise<
    readonly {
      projectId: string;
      organizationId: string;
      configurationRevisionId: string;
      connectionId: string;
      resourceId: string | null;
    }[]
  >;
}): TriggerSource {
  return {
    async start(handler: TriggerHandler) {
      registerForgejoHydrationConsumer(
        createForgejoHydrationConsumer({
          store: options.store,
          client: options.client,
          onRecovered: async (event, input) => {
            const targets = await options.listTargets({
              organizationId: input.delivery.organizationId,
              connectionId: input.signal.context.connectionId,
              repositoryId: input.signal.context.repository.id,
            });
            await Promise.all(
              targets.map((target) => handler(hydratedTrigger(event, input, target))),
            );
          },
        }),
      );
    },
    async stop() {
      return;
    },
  };
}

export interface ForgejoHydrationTriggerContext extends ForgejoTriggerContext {
  reactionSubject: ForgejoHydrationReactionSubject | null;
}

export function createForgejoHydrationTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  reactions?: ForgejoHydrationReactionClient;
}): TriggerProvider<"forgejo", ForgejoHydrationTriggerContext> {
  return {
    name: "forgejo",
    eventNames: [...FORGEJO_HYDRATED_TRIGGER_EVENT_NAMES],
    async match(externalTrigger) {
      const hydrated = readHydratedEnvelope(externalTrigger.payload);
      if (hydrated === undefined) return "no_trigger_for_source";
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      return matchHydratedTriggers(
        stored,
        hydrated.event,
        hydrated.reactionSubject,
        externalTrigger,
      );
    },
    async materializeContext(launch) {
      return launch.triggerContext.event;
    },
    async onDispatchAccepted(triggerContext, _outputContext, reactionState) {
      return projectHydrationReaction(options.reactions, triggerContext, "eyes", reactionState);
    },
    async onAgentExecutionCompleted(triggerContext, _outputContext, _result, reactionState) {
      return projectHydrationReaction(options.reactions, triggerContext, "+1", reactionState);
    },
    async onAgentExecutionFailed(triggerContext, _outputContext, _reason, reactionState) {
      return projectHydrationReaction(options.reactions, triggerContext, "-1", reactionState);
    },
    async onMachineTerminated(triggerContext, _reason, reactionState) {
      return projectHydrationReaction(options.reactions, triggerContext, "-1", reactionState);
    },
  };
}

async function seedSubjectKind(input: {
  store: ForgejoHydrationStore;
  client: ForgejoHydrationClient;
  connectionId: string;
  repositoryId: number;
  owner: string;
  repo: string;
  subjectKind: "issue" | "pull_request";
  subjectId: number;
}): Promise<void> {
  const timeline = await input.client.listTimeline({
    connectionId: input.connectionId,
    owner: input.owner,
    repo: input.repo,
    index: input.subjectId,
  });
  await input.store.seedCursor(
    {
      connectionId: input.connectionId,
      repositoryId: input.repositoryId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      recordKind: "timeline",
    },
    maxRecordId(timeline),
  );
  if (input.subjectKind !== "pull_request") return;
  const reviews = await input.client.listReviews({
    connectionId: input.connectionId,
    owner: input.owner,
    repo: input.repo,
    index: input.subjectId,
  });
  await input.store.seedCursor(
    {
      connectionId: input.connectionId,
      repositoryId: input.repositoryId,
      subjectKind: "pull_request",
      subjectId: input.subjectId,
      recordKind: "review",
    },
    maxRecordId(reviews),
  );
  let commentMax = 0;
  for (const review of reviews) {
    const reviewId = recordId(review);
    if (reviewId === undefined) continue;
    const comments = await input.client.listReviewComments({
      connectionId: input.connectionId,
      owner: input.owner,
      repo: input.repo,
      index: input.subjectId,
      reviewId,
    });
    const next = maxRecordId(comments);
    if (next > commentMax) commentMax = next;
  }
  await input.store.seedCursor(
    {
      connectionId: input.connectionId,
      repositoryId: input.repositoryId,
      subjectKind: "pull_request",
      subjectId: input.subjectId,
      recordKind: "review_comment",
    },
    commentMax,
  );
}

function hydratedTrigger(
  event: ForgejoRecoveredHydrationEvent,
  input: ForgejoHydrationRecoveryInput,
  target: {
    projectId: string;
    organizationId: string;
    configurationRevisionId: string;
    connectionId: string;
    resourceId: string | null;
  },
) {
  return {
    providerEventReceiptId: input.receiptId,
    organizationId: target.organizationId,
    projectId: target.projectId,
    configurationRevisionId: target.configurationRevisionId,
    source: event.semanticEvent,
    deliveryId: input.delivery.deliveryId,
    receivedAt: input.delivery.receivedAt,
    payload: {
      headers: {
        "x-forgejo-delivery": input.delivery.deliveryId,
        "x-forgejo-event": "hydrated",
        "x-forgejo-event-type": event.semanticEvent,
      },
      raw: JSON.stringify({
        hydration: {
          semanticEvent: event.semanticEvent,
          sourceRecordKind: event.sourceRecordKind,
          sourceRecordId: event.sourceRecordId,
          subjectKind: event.subjectKind,
          subjectId: event.subjectId,
          htmlUrl: event.htmlUrl,
          reactionSubject: event.reactionSubject,
          context: input.signal.context,
        },
      }),
    },
    connectionId: target.connectionId,
    resourceId: target.resourceId,
  };
}

function readHydratedEnvelope(payload: unknown):
  | {
      event: NormalizedForgejoEvent;
      reactionSubject: ForgejoHydrationReactionSubject | null;
    }
  | undefined {
  const envelope = asRecord(payload);
  const headers = asRecord(envelope?.["headers"]);
  if (str(headers ?? {}, "x-forgejo-event") !== "hydrated") return undefined;
  const raw = str(envelope ?? {}, "raw");
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const hydration = asRecord(asRecord(parsed)?.["hydration"]);
    if (hydration === undefined) return undefined;
    const event = toNormalizedHydratedEvent(hydration);
    if (event === undefined) return undefined;
    return { event, reactionSubject: readReactionSubject(hydration, event) };
  } catch {
    return undefined;
  }
}

function toNormalizedHydratedEvent(
  hydration: Record<string, unknown>,
): NormalizedForgejoEvent | undefined {
  const semantic = str(hydration, "semanticEvent");
  const sourceRecordKind = str(hydration, "sourceRecordKind");
  const sourceRecordId = num(hydration, "sourceRecordId");
  const subjectKind = str(hydration, "subjectKind");
  const subjectId = num(hydration, "subjectId");
  const context = readBoundedContext(hydration["context"]);
  if (
    semantic === undefined ||
    sourceRecordKind === undefined ||
    sourceRecordId === undefined ||
    subjectKind === undefined ||
    subjectId === undefined ||
    context === undefined
  ) {
    return undefined;
  }
  const rawFamily = hydratedRawFamily(semantic);
  if (rawFamily === undefined) return undefined;
  return {
    identity: {
      eventId: [
        semantic,
        context.connectionId,
        String(context.repository.id),
        subjectKind,
        String(subjectId),
        sourceRecordKind,
        String(sourceRecordId),
      ].join(":"),
    },
    receiptSource: rawFamily,
    rawFamily,
    semanticEvent: hydratedSemantic(semantic),
    context,
    text: "",
    labels: [],
    defaultBranchPush: false,
  };
}

function readBoundedContext(value: unknown): ForgejoBoundedContext | undefined {
  const row = asRecord(value);
  if (row === undefined) return undefined;
  const repository = readRepository(row["repository"]);
  const actor = readActor(row["actor"]);
  const connectionId = str(row, "connectionId");
  const connectionSlug = str(row, "connectionSlug");
  const deliveryId = str(row, "deliveryId");
  const instanceId = str(row, "instanceId");
  const rawFamily = readRawFamily(str(row, "event") ?? "");
  if (
    repository === undefined ||
    actor === undefined ||
    connectionId === undefined ||
    connectionSlug === undefined ||
    deliveryId === undefined ||
    instanceId === undefined ||
    rawFamily === undefined
  ) {
    return undefined;
  }
  return {
    deliveryId,
    instanceId,
    connectionId,
    connectionSlug,
    repository,
    actor,
    subject: readSubject(row["subject"]),
    event: rawFamily,
    action: str(row, "action") ?? null,
    ref: str(row, "ref") ?? null,
    htmlUrl: str(row, "htmlUrl") ?? null,
  };
}

function readRepository(value: unknown): ForgejoBoundedContext["repository"] | undefined {
  const repository = asRecord(value);
  if (repository === undefined) return undefined;
  const fullName = str(repository, "full_name");
  const owner = str(repository, "owner");
  const name = str(repository, "name");
  const defaultBranch = str(repository, "default_branch");
  const htmlUrl = str(repository, "html_url");
  const id = num(repository, "id");
  if (
    fullName === undefined ||
    owner === undefined ||
    name === undefined ||
    defaultBranch === undefined ||
    htmlUrl === undefined ||
    id === undefined
  ) {
    return undefined;
  }
  return {
    id,
    full_name: fullName,
    owner,
    name,
    default_branch: defaultBranch,
    html_url: htmlUrl,
  };
}

function readActor(value: unknown): ForgejoBoundedContext["actor"] | undefined {
  const actor = asRecord(value);
  if (actor === undefined) return undefined;
  const id = num(actor, "id");
  const login = str(actor, "login");
  if (id === undefined || login === undefined) return undefined;
  return { id, login };
}

function readRawFamily(value: string): ForgejoRawFamily | undefined {
  return FORGEJO_TRIGGER_SOURCE_NAMES.find((name) => name === value);
}

function readSubject(value: unknown): ForgejoBoundedContext["subject"] {
  const row = asRecord(value);
  if (row === undefined) return null;
  const kind = str(row, "kind");
  if (kind !== "issue" && kind !== "pull_request" && kind !== "comment" && kind !== "commit") {
    return null;
  }
  const rawId = row["id"];
  const id = typeof rawId === "number" || typeof rawId === "string" ? rawId : undefined;
  if (id === undefined) return null;
  return {
    kind,
    id,
    number: num(row, "number") ?? null,
    html_url: str(row, "html_url") ?? null,
  };
}

function hydratedRawFamily(semantic: string): NormalizedForgejoEvent["rawFamily"] | undefined {
  if (semantic === "forgejo.issue_label_added") return "forgejo.issues";
  if (semantic === "forgejo.pull_request_label_added") return "forgejo.pull_request";
  if (semantic === "forgejo.pull_request_review") return "forgejo.pull_request_review";
  if (semantic === "forgejo.pull_request_review_comment") {
    return "forgejo.pull_request_review_comment";
  }
  return undefined;
}

function hydratedSemantic(semantic: string): NormalizedForgejoEvent["semanticEvent"] {
  if (semantic === "forgejo.issue_label_added" || semantic === "forgejo.pull_request_label_added") {
    return semantic;
  }
  return undefined;
}

async function matchHydratedTriggers(
  stored: NonNullable<Awaited<ReturnType<ProjectConfigurationStore["getRevision"]>>>,
  event: NormalizedForgejoEvent,
  reactionSubject: ForgejoHydrationReactionSubject | null,
  externalTrigger: {
    connectionId?: string | null;
    receivedAt: Date;
  },
) {
  const found: TriggerProviderMatch<ForgejoHydrationTriggerContext>[] = [];
  for (const match of matchForgejoTriggers(
    stored.configuration,
    event,
    externalTrigger.connectionId,
  )) {
    const compiledTrigger = stored.configuration.triggers.find(
      (candidate) => candidate.name === match.trigger.name,
    );
    if (compiledTrigger === undefined) {
      throw new Error(`compiled trigger not found: ${match.trigger.name}`);
    }
    const triggerContext: ForgejoHydrationTriggerContext = {
      provider: "forgejo",
      target: {
        connectionId: event.context.connectionId,
        repositoryId: event.context.repository.id,
        repository: event.context.repository.full_name,
      },
      event: {
        forgejo: {
          delivery_id: event.context.deliveryId,
          event_name: event.rawFamily,
          repository: {
            full_name: event.context.repository.full_name,
            id: event.context.repository.id,
          },
          actor: event.context.actor,
          received_at: externalTrigger.receivedAt.toISOString(),
          identity: event.identity,
        },
      },
      reactionSubject,
    };
    const invocation = parseInvocation(
      readForgejoInvocationMessage(event),
      compiledTrigger.inputs,
      readForgejoMention(event, compiledTrigger.filters),
      readForgejoInvocationParserMessage(event, compiledTrigger.filters),
    );
    if (invocation.status === "accepted") {
      if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
      found.push({
        triggerName: match.trigger.name,
        triggerContext,
        outputContext: triggerContext,
        configurationRevisionId: stored.revision.id,
        hubConfig: stored.configuration,
        invocation,
      });
      continue;
    }
    found.push({
      triggerName: match.trigger.name,
      triggerContext,
      outputContext: triggerContext,
      configurationRevisionId: stored.revision.id,
      hubConfig: stored.configuration,
      invocation,
    });
  }
  return found.length === 0 ? "trigger_filters_rejected" : found;
}

function readReactionSubject(
  hydration: Record<string, unknown>,
  event: NormalizedForgejoEvent,
): ForgejoHydrationReactionSubject | null {
  const kind = str(hydration, "reactionSubject");
  if (kind === "review_comment") {
    const id = num(hydration, "sourceRecordId");
    return id === undefined ? null : { kind, id };
  }
  if (kind !== "issue" && kind !== "pull_request") return null;
  const id = event.context.subject?.number ?? num(hydration, "subjectId");
  return id === undefined ? null : { kind, id };
}

async function projectHydrationReaction(
  reactions: ForgejoHydrationReactionClient | undefined,
  triggerContext: ForgejoHydrationTriggerContext,
  content: ForgejoHydrationReactionContent,
  _reactionState: TriggerProviderReactionState | undefined,
): Promise<TriggerProviderReactionState> {
  if (reactions === undefined || triggerContext.reactionSubject === null) return null;
  const [owner, repo] = triggerContext.target.repository.split("/");
  if (owner === undefined || repo === undefined) return null;
  await reactions.create({
    connectionId: triggerContext.target.connectionId,
    owner,
    repo,
    subject: triggerContext.reactionSubject,
    content,
  });
  return {
    content,
    kind: triggerContext.reactionSubject.kind,
    id: triggerContext.reactionSubject.id,
  };
}
