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
import type { GitHubTeamMembershipClient } from "./team-membership.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedTriggerEvent {
  event: NormalizedGitHubEvent;
  trigger: MatchedTriggerDefinition;
}

export interface GitHubTriggerMatchOptions {
  connectionId?: string | null;
  teamMemberships: GitHubTeamMembershipClient;
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

export async function matchTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedGitHubEvent,
  options: GitHubTriggerMatchOptions,
): Promise<MatchedTriggerEvent[]> {
  const on = `github.${event.type}`;
  const matches: MatchedTriggerEvent[] = [];
  const membershipChecks = new Map<string, Promise<boolean>>();

  for (const trigger of config.triggers) {
    if (
      trigger.on !== on ||
      !(await matchesFilter(event, trigger.filters, options, membershipChecks))
    ) {
      continue;
    }

    matches.push({ event, trigger });
  }

  return matches;
}

async function matchesFilter(
  event: NormalizedGitHubEvent,
  filter: TriggerFilter | undefined,
  options: GitHubTriggerMatchOptions,
  membershipChecks: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (!matchesStaticFilter(event, filter, options.connectionId)) return false;
  if (filter === undefined) return false;

  const actor = getEventActor(event);
  if (filter.from_users?.includes(actor) === true) return true;
  if (actor.length === 0 || filter.from_teams === undefined) return false;

  return matchesTeamFilter(
    event,
    actor,
    filter.from_teams,
    options.teamMemberships,
    membershipChecks,
  );
}

function matchesStaticFilter(
  event: NormalizedGitHubEvent,
  filter: TriggerFilter | undefined,
  connectionId: string | null | undefined,
): boolean {
  if (filter === undefined) return false;
  if ((filter.from_users?.length ?? 0) === 0 && (filter.from_teams?.length ?? 0) === 0) {
    return false;
  }
  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) return false;

  const repo = filter["repo"];
  if (typeof repo === "string" && repo !== event.repo) return false;

  const resourceId = filter["resourceId"];
  if (typeof resourceId === "string" && resourceId !== String(event.repositoryId)) return false;

  const text = getFilterText(event);
  const pattern = readStringFilter(filter, "pattern");
  if (pattern !== undefined && !text.startsWith(pattern)) return false;

  const contains = readStringFilter(filter, "contains");
  return contains === undefined || text.includes(contains);
}

async function matchesTeamFilter(
  event: NormalizedGitHubEvent,
  actor: string,
  references: readonly string[],
  teamMemberships: GitHubTeamMembershipClient,
  membershipChecks: Map<string, Promise<boolean>>,
): Promise<boolean> {
  for (const reference of references) {
    const team = parseTeamReference(reference);
    if (team === undefined) continue;
    const key = [event.installationId, team.organization, team.slug, actor].join("\u0000");
    let membership = membershipChecks.get(key);
    if (membership === undefined) {
      membership = teamMemberships.isActiveMember({
        installationId: event.installationId,
        organization: team.organization,
        teamSlug: team.slug,
        username: actor,
      });
      membershipChecks.set(key, membership);
    }
    try {
      if (await membership) return true;
    } catch {
      // Membership checks are authorization decisions. An unavailable client denies the trigger.
    }
  }

  return false;
}

function readStringFilter(filter: TriggerFilter, key: "pattern" | "contains"): string | undefined {
  const value = filter[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseTeamReference(value: string): { organization: string; slug: string } | undefined {
  const parts = value.split("/");
  const organization = parts.length === 2 ? parts[0] : undefined;
  const slug = parts.length === 2 ? parts[1] : undefined;
  if (
    organization === undefined ||
    organization.length === 0 ||
    slug === undefined ||
    slug.length === 0
  ) {
    return undefined;
  }
  return { organization, slug };
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
