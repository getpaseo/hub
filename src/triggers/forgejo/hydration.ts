import type { ForgejoHydrationConsumer } from "./dispatch.js";
import type { ForgejoReconciliationSignal } from "./normalize.js";

export type ForgejoHydrationRecordKind = "timeline" | "review" | "review_comment";

export interface ForgejoHydrationCursorKey {
  connectionId: string;
  repositoryId: number;
  subjectKind: "issue" | "pull_request";
  subjectId: number;
  recordKind: ForgejoHydrationRecordKind;
}

export interface ForgejoRecoveredHydrationEvent {
  semanticEvent:
    | "forgejo.issue_label_added"
    | "forgejo.pull_request_label_added"
    | "forgejo.pull_request_review"
    | "forgejo.pull_request_review_comment";
  sourceRecordKind: "timeline" | "review" | "review_comment" | "label";
  sourceRecordId: number;
  subjectKind: "issue" | "pull_request";
  subjectId: number;
  htmlUrl: string | null;
  reactionSubject: "issue" | "pull_request" | "review_comment" | null;
}

export interface ForgejoHydrationStore {
  getCursor(key: ForgejoHydrationCursorKey): Promise<number | undefined>;
  seedCursor(key: ForgejoHydrationCursorKey, cursorRecordId: number): Promise<void>;
  insertRecoveredAndAdvance(input: {
    key: ForgejoHydrationCursorKey;
    organizationId: string;
    sourceRecordKind: ForgejoRecoveredHydrationEvent["sourceRecordKind"];
    sourceRecordId: number;
    cursorRecordId: number;
  }): Promise<"inserted" | "duplicate">;
}

export interface ForgejoHydrationClient {
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

export function createForgejoHydrationConsumer(options: {
  store: ForgejoHydrationStore;
  client: ForgejoHydrationClient;
  onRecovered?: (event: ForgejoRecoveredHydrationEvent) => Promise<void>;
}): ForgejoHydrationConsumer {
  return {
    async consume(input) {
      const recovered = await hydrateSignal(options, input.signal, input.delivery.organizationId);
      if (options.onRecovered === undefined) return;
      for (const event of recovered) await options.onRecovered(event);
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
  const records = await input.options.client.listReviewComments({
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
