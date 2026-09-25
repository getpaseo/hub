import {
  PullRequestReviewCommentPayloadSchema,
  PullRequestReviewPayloadSchema,
} from "../../auth/github-events.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import {
  classifyForgeEvent,
  classifyPullRequest,
  FORGE_SEMANTIC_EVENT_SUFFIXES,
} from "../forge/classification.js";
import type {
  ForgeClassifiedEvent,
  ForgeClassifiedItem,
  ForgeSemanticEventSuffix,
} from "../forge/classification.js";

/**
 * Issues, pull requests and comments read through forge/classification.ts, since
 * Forgejo reproduces these fields exactly. Reviews and review comments stay here:
 * GitHub raises a pull_request_review_comment event Forgejo has no equivalent for.
 */
export type GitHubSemanticEvent = `github.${ForgeSemanticEventSuffix}`;

// derived, not hand-copied, so a suffix added there can't go missing here.
export const GITHUB_SEMANTIC_TRIGGER_EVENT_NAMES: readonly GitHubSemanticEvent[] =
  FORGE_SEMANTIC_EVENT_SUFFIXES.map((suffix) => `github.${suffix}` as const);

export const GITHUB_TRIGGER_SOURCE_NAMES = [
  "github.issue_comment",
  "github.issues",
  "github.pull_request",
  "github.pull_request_review",
  "github.pull_request_review_comment",
  "github.push",
] as const;

export interface GitHubClassifiedEvent extends Omit<ForgeClassifiedEvent, "semanticEvent"> {
  readonly semanticEvent: GitHubSemanticEvent | undefined;
}

export type GitHubClassifiedItem = ForgeClassifiedItem;

/** The sole owner of GitHub webhook action and item interpretation. */
export function classifyGitHubEvent(event: NormalizedGitHubEvent): GitHubClassifiedEvent {
  if (event.type === "pull_request_review") return classifyReview(event);
  if (event.type === "pull_request_review_comment") return classifyReviewComment(event);
  return toGitHubClassification(classifyForgeEvent(event));
}

function toGitHubClassification(classified: ForgeClassifiedEvent): GitHubClassifiedEvent {
  return {
    ...classified,
    semanticEvent:
      classified.semanticEvent === undefined ? undefined : `github.${classified.semanticEvent}`,
  };
}

function classifyReview(event: NormalizedGitHubEvent): GitHubClassifiedEvent {
  const payload = PullRequestReviewPayloadSchema.parse(event.payload);
  const pullRequest = classifyPullRequest(payload);
  return {
    ...pullRequest,
    semanticEvent: undefined,
    actor: payload.sender?.login ?? payload.review?.user?.login ?? "",
    text: payload.review?.body ?? "",
  };
}

function classifyReviewComment(event: NormalizedGitHubEvent): GitHubClassifiedEvent {
  const payload = PullRequestReviewCommentPayloadSchema.parse(event.payload);
  const pullRequest = classifyPullRequest(payload);
  return {
    ...pullRequest,
    semanticEvent: undefined,
    actor: payload.sender?.login ?? payload.comment?.user?.login ?? "",
    text: payload.comment?.body ?? "",
  };
}
