import { z } from "zod";
import { logger } from "../../logger.js";
import type { ForgejoTimelineEntry } from "../../providers/forgejo/client.js";
import { labelsFor } from "../forge/classification.js";
import type { ForgejoEnrichmentDeps } from "./enrichment.js";
import { recentSinceMs, recentUntilMs } from "./enrichment.js";
import type { NormalizedForgejoEvent } from "./events.js";
import { splitForgejoRepository } from "./repository.js";

/**
 * Forgejo's `label_updated`/`assigned` webhook body carries only the current state, never
 * which one just changed, so this reads the issue timeline to find it. Two webhooks can
 * see the same timeline additions, so each candidate is claimed via
 * deps.claimTimelineEntries first; only the delivery that wins an entry id reports it.
 */
const AssigneeSchema = z.object({ login: z.string().optional().catch(undefined) }).passthrough();
const ItemSchema = z
  .object({
    number: z.number().optional().catch(undefined),
    labels: z
      .array(z.object({ name: z.string().optional().catch(undefined) }).passthrough())
      .optional()
      .catch(undefined),
    assignees: z.array(AssigneeSchema).optional().catch(undefined),
  })
  .passthrough();
const EnrichmentPayloadSchema = z
  .object({
    action: z.string().optional().catch(undefined),
    sender: z
      .object({ login: z.string().optional().catch(undefined) })
      .passthrough()
      .optional()
      .catch(undefined),
    issue: ItemSchema.optional().catch(undefined),
    pull_request: ItemSchema.optional().catch(undefined),
  })
  .passthrough();

/**
 * Adds addedLabels/addedAssignees to a label_updated/assigned delivery. Any failure
 * (no credentials, instance unreachable, bad response) returns the event unchanged.
 * recencyAnchor defaults to this event's createdAt, but webhook.ts passes the receipt's
 * stored receivedAt on a stale-marker takeover, since the takeover's own request
 * arrives later and would otherwise slide the search window past its entries.
 */
export async function enrichForgejoLabelsOrAssignees(
  event: NormalizedForgejoEvent,
  deps: ForgejoEnrichmentDeps,
  signal?: AbortSignal,
  receiptId?: string,
  recencyAnchor?: Date,
): Promise<NormalizedForgejoEvent> {
  const context = readEnrichmentContext(event);
  if (context === undefined) return event;
  if (deps.credentialsForConnection === undefined || deps.timelineClient === undefined) {
    return event;
  }

  try {
    const credentials = await deps.credentialsForConnection(event.connectionId);
    const [owner, repo] = splitForgejoRepository(event.repo);
    const anchor = recencyAnchor ?? new Date(event.createdAt);
    const sinceMs = recentSinceMs(anchor);
    const untilMs = recentUntilMs(anchor);
    const entries = await deps.timelineClient.listIssueTimeline({
      credentials,
      owner,
      repo,
      issueNumber: context.issueNumber,
      since: new Date(sinceMs).toISOString(),
      signal,
    });
    if (context.action === "label_updated") {
      const candidates = candidateAddedLabels(
        entries,
        context.senderLogin,
        context.currentLabels,
        sinceMs,
        untilMs,
      );
      return {
        ...event,
        addedLabels: await claimAdded(candidates, event.connectionId, deps, signal, receiptId),
      };
    }
    const candidates = candidateAddedAssignees(
      entries,
      context.senderLogin,
      context.currentAssignees,
      sinceMs,
      untilMs,
    );
    return {
      ...event,
      addedAssignees: await claimAdded(candidates, event.connectionId, deps, signal, receiptId),
    };
  } catch (error) {
    logger.warn(
      { err: error, deliveryId: event.id, repo: event.repo },
      signal?.aborted === true
        ? "forgejo timeline enrichment hit its deadline, continuing without it"
        : "forgejo timeline enrichment failed, continuing without it",
    );
    return event;
  }
}

/**
 * True only when enrichForgejoLabelsOrAssignees would actually reach a network call,
 * judged with no I/O by mirroring its own early-return conditions. webhook.ts marks a
 * receipt "enrichment pending" only when this says yes.
 */
export function forgejoLabelsOrAssigneesCanEnrich(
  event: NormalizedForgejoEvent,
  deps: ForgejoEnrichmentDeps,
): boolean {
  if (deps.credentialsForConnection === undefined || deps.timelineClient === undefined) {
    return false;
  }
  return readEnrichmentContext(event) !== undefined;
}

interface EnrichmentContext {
  action: "label_updated" | "assigned";
  issueNumber: number;
  senderLogin: string;
  currentLabels: readonly string[];
  currentAssignees: readonly string[];
}

function readEnrichmentContext(event: NormalizedForgejoEvent): EnrichmentContext | undefined {
  if (event.type !== "issues" && event.type !== "pull_request") return undefined;
  const parsed = EnrichmentPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return undefined;
  const action = parsed.data.action;
  if (action !== "label_updated" && action !== "assigned") return undefined;

  const item = event.type === "issues" ? parsed.data.issue : parsed.data.pull_request;
  const issueNumber = item?.number;
  const senderLogin = parsed.data.sender?.login;
  if (issueNumber === undefined || senderLogin === undefined || senderLogin.length === 0) {
    return undefined;
  }

  const currentLabels = labelsFor(item?.labels);
  const currentAssignees = logins(item?.assignees);
  // no current label/assignee means no candidate could ever match, so skip the
  // network round trip entirely.
  if (action === "label_updated" && currentLabels.length === 0) return undefined;
  if (action === "assigned" && currentAssignees.length === 0) return undefined;

  return {
    action,
    issueNumber,
    senderLogin,
    currentLabels,
    currentAssignees,
  };
}

interface AddedCandidate {
  timelineEntryId: number;
  value: string;
}

/**
 * Every still-present label add by this delivery's sender, within the recency window.
 * label_updated also fires on removal (body "", not "1"), so removals aren't candidates.
 */
function candidateAddedLabels(
  entries: readonly ForgejoTimelineEntry[],
  senderLogin: string,
  currentLabels: readonly string[],
  sinceMs: number,
  untilMs: number,
): AddedCandidate[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "label" || entry.userLogin !== senderLogin) return [];
    if (entry.id === undefined || entry.body !== "1" || entry.labelName === undefined) return [];
    if (entry.createdAtMs === undefined || entry.createdAtMs < sinceMs) return [];
    if (entry.createdAtMs > untilMs) return [];
    if (!currentLabels.includes(entry.labelName)) return [];
    return [{ timelineEntryId: entry.id, value: entry.labelName }];
  });
}

function candidateAddedAssignees(
  entries: readonly ForgejoTimelineEntry[],
  senderLogin: string,
  currentAssignees: readonly string[],
  sinceMs: number,
  untilMs: number,
): AddedCandidate[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "assignees" || entry.userLogin !== senderLogin) return [];
    if (entry.id === undefined || entry.removedAssignee || entry.assigneeLogin === undefined) {
      return [];
    }
    if (entry.createdAtMs === undefined || entry.createdAtMs < sinceMs) return [];
    if (entry.createdAtMs > untilMs) return [];
    if (!currentAssignees.includes(entry.assigneeLogin)) return [];
    return [{ timelineEntryId: entry.id, value: entry.assigneeLogin }];
  });
}

/**
 * Claim every candidate in one call, so one delivery can win several entries at once,
 * and keep only the values this delivery actually won. Without a claim dependency
 * wired (tests that do not exercise the race), every candidate wins.
 */
async function claimAdded(
  candidates: readonly AddedCandidate[],
  connectionId: string,
  deps: ForgejoEnrichmentDeps,
  signal: AbortSignal | undefined,
  receiptId: string | undefined,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  // past the deadline the webhook already dispatched without us; claiming now would
  // burn entries nobody reports.
  signal?.throwIfAborted();
  if (deps.claimTimelineEntries === undefined) {
    return dedupe(candidates.map((candidate) => candidate.value));
  }
  if (receiptId === undefined) {
    throw new Error("forgejo timeline claim requires a receipt id");
  }
  const won = await deps.claimTimelineEntries(
    connectionId,
    candidates.map((candidate) => candidate.timelineEntryId),
    receiptId,
  );
  return dedupe(
    candidates.filter((candidate) => won.has(candidate.timelineEntryId)).map((c) => c.value),
  );
}

function logins(
  assignees: readonly { login?: string | undefined }[] | undefined,
): readonly string[] {
  return (
    assignees?.flatMap((assignee) => (assignee.login === undefined ? [] : [assignee.login])) ?? []
  );
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
