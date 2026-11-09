import type { ProviderEventSummary } from "../presentation.js";
import { reportFailure } from "../../failures/index.js";
import {
  IssueCommentPayloadSchema,
  IssuesPayloadSchema,
  NormalizedGitHubEventSchema,
  PullRequestReviewCommentPayloadSchema,
  PullRequestReviewPayloadSchema,
  PushPayloadSchema,
  readGitHubTriggerUrl,
} from "../../auth/github-events.js";
import {
  classifyGitHubEvent,
  type GitHubSemanticEvent,
} from "../../triggers/github/classification.js";

interface GitHubHeadline {
  headline: string;
  actor: string | null;
}

const GITHUB_EVENT_SUMMARIES: Record<string, (payload: unknown) => GitHubHeadline> = {
  issue_comment: summarizeIssueComment,
  issues: summarizeIssue,
  pull_request_review: summarizePullRequestReview,
  pull_request_review_comment: summarizePullRequestReviewComment,
  push: summarizePush,
};

export function summarizeEvent(payload: unknown): ProviderEventSummary {
  const event = NormalizedGitHubEventSchema.safeParse(payload);
  if (!event.success) {
    return { provider: "github", headline: "GitHub event", actor: null, externalUrl: null };
  }
  const externalUrl = readGitHubTriggerUrl(event.data.payload) ?? null;
  const classified = classifyGitHubEvent(event.data);
  const action = pullRequestAction(classified.semanticEvent);
  if (action !== undefined) {
    return {
      provider: "github",
      headline:
        classified.item?.number === null || classified.item === null
          ? `Pull request ${action}`
          : `Pull request #${String(classified.item.number)} ${action}${classified.item.title === null ? "" : `: ${classified.item.title}`}`,
      actor: classified.actor.length === 0 ? null : classified.actor,
      externalUrl,
    };
  }
  const { headline, actor } = summarizeGitHubEvent(event.data.type, event.data.payload);
  return { provider: "github", headline, actor, externalUrl };
}

function pullRequestAction(event: GitHubSemanticEvent | undefined): string | undefined {
  if (event === "github.pull_request_created") return "created";
  if (event === "github.pull_request_ready_for_review") return "ready for review";
  if (event === "github.pull_request_synchronized") return "updated with new commits";
  return undefined;
}

/**
 * The webhook receipt path validates only the permissive outer envelope, not the
 * event-specific shape — a stored row can have a `type` whose nested payload doesn't
 * match that type's schema. Isolate that single throwing call so one bad row falls
 * back to a generic headline instead of failing the whole snapshot.
 */
function summarizeGitHubEvent(type: string, payload: unknown): GitHubHeadline {
  const summarize = GITHUB_EVENT_SUMMARIES[type];
  if (summarize === undefined) return { headline: humanize(type), actor: null };
  try {
    return summarize(payload);
  } catch (error) {
    reportFailure(error, {
      operation: "project_activity.summarize",
      component: "projects",
      provider: "github",
    });
    return { headline: humanize(type), actor: null };
  }
}

function summarizeIssueComment(payload: unknown): GitHubHeadline {
  const body = IssueCommentPayloadSchema.parse(payload);
  const number = body.issue?.number;
  return {
    headline: number === undefined ? "Issue comment" : `Comment on #${String(number)}`,
    actor: body.sender?.login ?? body.comment?.user?.login ?? null,
  };
}

function summarizeIssue(payload: unknown): GitHubHeadline {
  const body = IssuesPayloadSchema.parse(payload);
  const number = body.issue?.number;
  const title = body.issue?.title;
  return {
    headline:
      number === undefined
        ? "Issue"
        : `Issue #${String(number)}${title === undefined ? "" : `: ${title}`}`,
    actor: body.sender?.login ?? null,
  };
}

function summarizePullRequestReview(payload: unknown): GitHubHeadline {
  const body = PullRequestReviewPayloadSchema.parse(payload);
  return {
    headline: "Pull request review",
    actor: body.sender?.login ?? body.review?.user?.login ?? null,
  };
}

function summarizePullRequestReviewComment(payload: unknown): GitHubHeadline {
  const body = PullRequestReviewCommentPayloadSchema.parse(payload);
  return {
    headline: "Pull request review comment",
    actor: body.sender?.login ?? body.comment?.user?.login ?? null,
  };
}

function summarizePush(payload: unknown): GitHubHeadline {
  const body = PushPayloadSchema.parse(payload);
  const branch = body.ref.replace(/^refs\/heads\//u, "");
  const count = body.commits.length;
  return {
    headline: `Push to ${branch}${count > 0 ? ` (${String(count)} commit${count === 1 ? "" : "s"})` : ""}`,
    actor: body.sender?.login ?? null,
  };
}

function humanize(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
