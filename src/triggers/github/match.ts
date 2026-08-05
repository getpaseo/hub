import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import {
  IssueCommentPayloadSchema,
  IssuesPayloadSchema,
  PullRequestReviewCommentPayloadSchema,
  PullRequestReviewPayloadSchema,
} from "../../auth/github-events.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedTriggerEvent {
  event: NormalizedGitHubEvent;
  trigger: MatchedTriggerDefinition;
}

export function readGitHubInvocationMessage(event: NormalizedGitHubEvent): string {
  return getFilterText(event);
}

export function readGitHubMention(
  event: NormalizedGitHubEvent,
  filter: TriggerFilter | undefined,
): string | undefined {
  const message = readGitHubInvocationMessage(event);
  const candidate = filter?.pattern ?? filter?.contains;
  return candidate !== undefined && message.includes(candidate) ? candidate : undefined;
}

export function matchTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedGitHubEvent,
  connectionId?: string | null,
): MatchedTriggerEvent[] {
  const on = `github.${event.type}`;
  const matches: MatchedTriggerEvent[] = [];

  for (const trigger of config.triggers) {
    if (trigger.on !== on || !matchesFilter(event, trigger.filters, connectionId)) {
      continue;
    }

    matches.push({ event, trigger });
  }

  return matches;
}

function matchesFilter(
  event: NormalizedGitHubEvent,
  filter: TriggerFilter | undefined,
  connectionId?: string | null,
): boolean {
  if (filter === undefined) {
    return false;
  }

  if (filter.from_users === undefined || filter.from_users.length === 0) {
    return false;
  }

  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) {
    return false;
  }

  const repo = filter["repo"];
  if (typeof repo === "string" && repo !== event.repo) {
    return false;
  }

  const resourceId = filter["resourceId"];
  if (typeof resourceId === "string" && resourceId !== String(event.repositoryId)) {
    return false;
  }

  const pattern = readStringFilter(filter, "pattern");
  if (pattern !== undefined && !getFilterText(event).startsWith(pattern)) {
    return false;
  }

  const contains = readStringFilter(filter, "contains");
  if (contains !== undefined && !getFilterText(event).includes(contains)) {
    return false;
  }

  const actor = getEventActor(event);
  if (!filter.from_users.includes(actor)) {
    return false;
  }

  return true;
}

function readStringFilter(filter: TriggerFilter, key: "pattern" | "contains"): string | undefined {
  const value = filter[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getFilterText(event: NormalizedGitHubEvent): string {
  switch (event.type) {
    case "issue_comment": {
      const payload = IssueCommentPayloadSchema.parse(event.payload);
      return payload.comment?.body ?? "";
    }
    case "issues": {
      const payload = IssuesPayloadSchema.parse(event.payload);
      return [payload.issue?.title ?? "", payload.issue?.body ?? ""]
        .filter((value) => value.length > 0)
        .join("\n");
    }
    case "pull_request_review": {
      const payload = PullRequestReviewPayloadSchema.parse(event.payload);
      return payload.review?.body ?? "";
    }
    case "pull_request_review_comment": {
      const payload = PullRequestReviewCommentPayloadSchema.parse(event.payload);
      return payload.comment?.body ?? "";
    }
    default:
      return "";
  }
}

function getEventActor(event: NormalizedGitHubEvent): string {
  switch (event.type) {
    case "issue_comment":
      return getIssueCommentActor(event.payload);
    case "issues":
      return getIssuesActor(event.payload);
    case "pull_request_review":
      return getPullRequestReviewActor(event.payload);
    case "pull_request_review_comment":
      return getPullRequestReviewCommentActor(event.payload);
    default:
      return "";
  }
}

function getIssueCommentActor(payload: unknown): string {
  const parsed = IssueCommentPayloadSchema.parse(payload);
  return parsed.sender?.login ?? parsed.comment?.user?.login ?? "";
}

function getIssuesActor(payload: unknown): string {
  const parsed = IssuesPayloadSchema.parse(payload);
  return parsed.sender?.login ?? "";
}

function getPullRequestReviewActor(payload: unknown): string {
  const parsed = PullRequestReviewPayloadSchema.parse(payload);
  return parsed.sender?.login ?? parsed.review?.user?.login ?? "";
}

function getPullRequestReviewCommentActor(payload: unknown): string {
  const parsed = PullRequestReviewCommentPayloadSchema.parse(payload);
  return parsed.sender?.login ?? parsed.comment?.user?.login ?? "";
}
