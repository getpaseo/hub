import type { ForgejoApiClient, ForgejoCredentials } from "../../providers/forgejo/client.js";
import {
  enrichForgejoLabelsOrAssignees,
  forgejoLabelsOrAssigneesCanEnrich,
} from "./enrichment-labels.js";
import { enrichForgejoReviewEvent, forgejoReviewCanEnrich } from "./enrichment-review.js";
import type { NormalizedForgejoEvent } from "./events.js";

/**
 * Fills in what a Forgejo webhook body leaves out: which label/assignee a
 * label_updated/assigned delivery added (enrichment-labels.ts), and a review's inline
 * comment text (enrichment-review.ts). This module just dispatches between the two.
 */
export interface ForgejoEnrichmentDeps {
  credentialsForConnection?(connectionId: string): Promise<ForgejoCredentials>;
  timelineClient?: Pick<ForgejoApiClient, "listIssueTimeline">;
  reviewClient?: Pick<ForgejoApiClient, "listPullReviews" | "listPullReviewComments">;
  /**
   * Claim timeline entry ids for this connection under receiptId, returning the
   * subset actually won. Missing means "claim everything" (tests that don't exercise
   * the race).
   */
  claimTimelineEntries?(
    connectionId: string,
    timelineEntryIds: readonly number[],
    receiptId: string,
  ): Promise<ReadonlySet<number>>;
}

// generous enough to survive clock skew and a delivery sitting in Forgejo's queue
// behind a burst of others. Losing enrichment silently is worse than a wide window.
const RECENCY_WINDOW_MS = 10 * 60_000;

/** Epoch ms, not an ISO string, so comparisons are real instants and not a text
 * compare against Forgejo's server-timezone timestamps. */
export function recentSinceMs(anchor: Date): number {
  const anchorMs = Number.isNaN(anchor.getTime()) ? Date.now() : anchor.getTime();
  return anchorMs - RECENCY_WINDOW_MS;
}

/** Same clock-skew allowance linear/webhook.ts uses for its own timestamp comparisons. */
const ALLOWED_CLOCK_SKEW_MS = 60_000;

/** Upper bound for a candidate entry: it can't have been created after this delivery,
 * give or take clock skew. listIssueTimeline's `since` only bounds from below. */
export function recentUntilMs(anchor: Date): number {
  const anchorMs = Number.isNaN(anchor.getTime()) ? Date.now() : anchor.getTime();
  return anchorMs + ALLOWED_CLOCK_SKEW_MS;
}

/**
 * Adds addedLabels/addedAssignees, or recovers a review's comment text, depending on
 * the event's type. Any failure returns the event unchanged; the raw event still fires.
 */
export async function enrichForgejoWebhookEvent(
  event: NormalizedForgejoEvent,
  deps: ForgejoEnrichmentDeps,
  signal?: AbortSignal,
  receiptId?: string,
  recencyAnchor?: Date,
): Promise<NormalizedForgejoEvent> {
  if (event.type === "pull_request_review") {
    return enrichForgejoReviewEvent(event, deps, signal, recencyAnchor);
  }
  return enrichForgejoLabelsOrAssignees(event, deps, signal, receiptId, recencyAnchor);
}

/** True only when enrichForgejoWebhookEvent would actually reach a network call. */
export function forgejoEventCanEnrich(
  event: NormalizedForgejoEvent,
  deps: ForgejoEnrichmentDeps,
): boolean {
  if (event.type === "pull_request_review") return forgejoReviewCanEnrich(event, deps);
  return forgejoLabelsOrAssigneesCanEnrich(event, deps);
}
