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
import type { TriggerRoutingDecision } from "../routing-evidence.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedTriggerEvent {
  event: NormalizedGitHubEvent;
  trigger: MatchedTriggerDefinition;
}

export interface GitHubTriggerEvaluation {
  matches: MatchedTriggerEvent[];
  routingDecisions: TriggerRoutingDecision[];
}

export function readGitHubInvocationMessage(event: NormalizedGitHubEvent): string {
  return getFilterText(event);
}

export function readGitHubInvocationParserMessage(
  event: NormalizedGitHubEvent,
  filter: TriggerFilter | undefined,
): string {
  const message = readGitHubInvocationMessage(event);
  if (filter === undefined) return message;
  const contains = readStringFilter(filter, "contains");
  if (contains === undefined) return message;
  const index = message.indexOf(contains);
  return index === -1 ? message : message.slice(index);
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
  return evaluateGitHubTriggers(config, event, connectionId).matches;
}

export function evaluateGitHubTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedGitHubEvent,
  connectionId?: string | null,
): GitHubTriggerEvaluation {
  const on = `github.${event.type}`;
  const matches: MatchedTriggerEvent[] = [];
  const routingDecisions: TriggerRoutingDecision[] = [];

  for (const trigger of config.triggers) {
    if (trigger.on !== on) {
      routingDecisions.push({ triggerName: trigger.name, code: "no_trigger_for_source" });
      continue;
    }
    const mismatch = githubFilterMismatch(event, trigger.filters, connectionId);
    if (mismatch !== undefined) {
      routingDecisions.push({ triggerName: trigger.name, code: mismatch });
      continue;
    }
    matches.push({ event, trigger });
  }

  return { matches, routingDecisions };
}

function githubFilterMismatch(
  event: NormalizedGitHubEvent,
  filter: TriggerFilter | undefined,
  connectionId?: string | null,
):
  | "connection_mismatch"
  | "repository_mismatch"
  | "resource_mismatch"
  | "pattern_mismatch"
  | "contains_mismatch"
  | "sender_not_allowed"
  | undefined {
  if (filter === undefined) {
    return "sender_not_allowed";
  }

  if (filter.from_users === undefined || filter.from_users.length === 0) {
    return "sender_not_allowed";
  }

  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) {
    return "connection_mismatch";
  }

  const repo = filter["repo"];
  if (typeof repo === "string" && repo !== event.repo) {
    return "repository_mismatch";
  }

  const resourceId = filter["resourceId"];
  if (typeof resourceId === "string" && resourceId !== String(event.repositoryId)) {
    return "resource_mismatch";
  }

  const pattern = readStringFilter(filter, "pattern");
  if (pattern !== undefined && !getFilterText(event).startsWith(pattern)) {
    return "pattern_mismatch";
  }

  const contains = readStringFilter(filter, "contains");
  if (contains !== undefined && !getFilterText(event).includes(contains)) {
    return "contains_mismatch";
  }

  const actor = getEventActor(event);
  if (!filter.from_users.includes(actor)) {
    return "sender_not_allowed";
  }

  return undefined;
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
