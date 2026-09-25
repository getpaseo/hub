import { z } from "zod";
import { logger } from "../../logger.js";
import type { ForgejoReviewComment, ForgejoReviewSummary } from "../../providers/forgejo/client.js";
import type { ForgejoEnrichmentDeps } from "./enrichment.js";
import { recentSinceMs } from "./enrichment.js";
import type { NormalizedForgejoEvent } from "./events.js";
import { splitForgejoRepository } from "./repository.js";

const ReviewEventPayloadSchema = z
  .object({
    pull_request: z
      .object({ number: z.number().optional().catch(undefined) })
      .passthrough()
      .optional()
      .catch(undefined),
    review: z
      .object({
        content: z.string().optional().catch(undefined),
        // verdict: pull_request_review_approved/_rejected/_comment. Different spelling
        // than the X-Forgejo-Event header, which normalizeForgejoEventType already
        // collapsed by the time this runs.
        type: z.string().optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
    sender: z
      .object({ login: z.string().optional().catch(undefined) })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

/**
 * Recovers review comment text into review.content, since Forgejo's webhook body never
 * carries it (upstream: https://codeberg.org/forgejo/forgejo/issues/7966). The webhook
 * names no review id either, so the review is matched by sender + verdict, most recently
 * updated_at (not submitted_at, which Forgejo sets once and never touches again) within
 * the recency window. TODO: drop once the payload carries the review id and comments
 * directly, https://codeberg.org/forgejo/forgejo/issues/14557
 */
export async function enrichForgejoReviewEvent(
  event: NormalizedForgejoEvent,
  deps: ForgejoEnrichmentDeps,
  signal: AbortSignal | undefined,
  recencyAnchor?: Date,
): Promise<NormalizedForgejoEvent> {
  if (deps.credentialsForConnection === undefined || deps.reviewClient === undefined) {
    return event;
  }

  const parsed = ReviewEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return event;

  const issueNumber = parsed.data.pull_request?.number;
  const senderLogin = parsed.data.sender?.login;
  const expectedState = reviewVerdictState(parsed.data.review?.type);
  if (
    issueNumber === undefined ||
    senderLogin === undefined ||
    senderLogin.length === 0 ||
    expectedState === undefined
  ) {
    return event;
  }

  try {
    const credentials = await deps.credentialsForConnection(event.connectionId);
    const [owner, repo] = splitForgejoRepository(event.repo);
    const reviews = await deps.reviewClient.listPullReviews({
      credentials,
      owner,
      repo,
      issueNumber,
      signal,
    });
    const review = latestReviewBySender(
      reviews,
      senderLogin,
      expectedState,
      recentSinceMs(recencyAnchor ?? new Date(event.createdAt)),
      parsed.data.review?.content,
    );
    if (review === undefined) return event;

    const comments = await deps.reviewClient.listPullReviewComments({
      credentials,
      owner,
      repo,
      issueNumber,
      reviewId: review.id,
      signal,
    });
    const bodies = comments.map((comment) => comment.body).filter((body) => body.length > 0);
    if (bodies.length === 0) return event;

    const summary = parsed.data.review?.content ?? "";
    const content = [summary, bodies.join("\n\n")].filter((part) => part.length > 0).join("\n\n");
    return {
      ...event,
      payload: withReviewEnrichment(event.payload, content, comments),
    };
  } catch (error) {
    logger.warn(
      { err: error, deliveryId: event.id, repo: event.repo },
      signal?.aborted === true
        ? "forgejo review comment enrichment hit its deadline, continuing without it"
        : "forgejo review comment enrichment failed, continuing without it",
    );
    return event;
  }
}

/** True only when enrichForgejoReviewEvent would actually reach a network call. */
export function forgejoReviewCanEnrich(
  event: NormalizedForgejoEvent,
  deps: ForgejoEnrichmentDeps,
): boolean {
  if (deps.credentialsForConnection === undefined || deps.reviewClient === undefined) {
    return false;
  }
  const parsed = ReviewEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return false;
  const issueNumber = parsed.data.pull_request?.number;
  const senderLogin = parsed.data.sender?.login;
  const expectedState = reviewVerdictState(parsed.data.review?.type);
  return (
    issueNumber !== undefined &&
    senderLogin !== undefined &&
    senderLogin.length > 0 &&
    expectedState !== undefined
  );
}

/** The ReviewStateType a webhook's review.type verdict maps to. PENDING/REQUEST_REVIEW
 * never reach a webhook, so those states never appear here. */
function reviewVerdictState(reviewType: string | undefined): string | undefined {
  if (reviewType === "pull_request_review_approved") return "APPROVED";
  if (reviewType === "pull_request_review_rejected") return "REQUEST_CHANGES";
  if (reviewType === "pull_request_review_comment") return "COMMENT";
  return undefined;
}

/**
 * Same sender, same verdict state, most recently updated within the window, tiebroken
 * by higher id (later review). When the webhook carried non-empty review.content, a
 * candidate must match it too, since sender+verdict+window alone can still tie when
 * the same sender submits two same-verdict reviews close together.
 */
function latestReviewBySender(
  reviews: readonly ForgejoReviewSummary[],
  senderLogin: string,
  expectedState: string,
  sinceMs: number,
  expectedContent: string | undefined,
): ForgejoReviewSummary | undefined {
  return reviews
    .filter(
      (review) =>
        review.userLogin === senderLogin &&
        review.state === expectedState &&
        review.updatedAtMs !== undefined &&
        review.updatedAtMs >= sinceMs &&
        (expectedContent === undefined ||
          expectedContent.length === 0 ||
          review.body === expectedContent),
    )
    .reduce<ForgejoReviewSummary | undefined>((latest, candidate) => {
      if (latest === undefined) return candidate;
      const candidateMs = candidate.updatedAtMs ?? 0;
      const latestMs = latest.updatedAtMs ?? 0;
      if (candidateMs !== latestMs) return candidateMs > latestMs ? candidate : latest;
      return candidate.id > latest.id ? candidate : latest;
    }, undefined);
}

/** Always a new object, so webhook.ts can tell enrichment ran via `enriched.payload !==
 * event.payload` instead of a separate flag. */
function withReviewEnrichment(
  payload: NormalizedForgejoEvent["payload"],
  content: string,
  comments: readonly ForgejoReviewComment[],
): NormalizedForgejoEvent["payload"] {
  const existing = payload["review"];
  const review = typeof existing === "object" && existing !== null ? existing : {};
  return {
    ...payload,
    review: { ...review, content, comments: comments.map(toPayloadReviewComment) },
  };
}

/** `line`/`side`, not GitHub's `line`/`original_line`: Forgejo has no force-push
 * distinction to justify that second name, just one line on one side of the diff. */
function toPayloadReviewComment(comment: ForgejoReviewComment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    path: comment.path ?? null,
    line: comment.line ?? null,
    side: comment.side ?? null,
    diff_hunk: comment.diffHunk ?? null,
    commit_id: comment.commitId ?? null,
    html_url: comment.htmlUrl ?? null,
    created_at: comment.createdAt ?? null,
    user: comment.userLogin === undefined ? null : { login: comment.userLogin },
  };
}
