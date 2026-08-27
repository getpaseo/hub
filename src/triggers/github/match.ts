import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { classifyGitHubEvent } from "./classification.js";
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
  return classifyGitHubEvent(event).text;
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
  const classified = classifyGitHubEvent(event);
  const eventNames = new Set([`github.${event.type}`, classified.semanticEvent]);
  const matches: MatchedTriggerEvent[] = [];
  const membershipChecks = new Map<string, Promise<boolean>>();

  for (const trigger of config.triggers) {
    if (
      !eventNames.has(trigger.on) ||
      !(await matchesFilter(classified, trigger.filters, event, options, membershipChecks))
    ) {
      continue;
    }

    matches.push({ event, trigger });
  }

  return matches;
}

async function matchesFilter(
  classified: ReturnType<typeof classifyGitHubEvent>,
  filter: TriggerFilter | undefined,
  event: NormalizedGitHubEvent,
  options: GitHubTriggerMatchOptions,
  membershipChecks: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (!matchesStaticFilter(classified, filter, event, options.connectionId)) return false;
  if (filter === undefined) return false;

  if (filter.from_users?.includes(classified.actor) === true) return true;
  if (classified.actor.length === 0 || filter.from_teams === undefined) return false;

  return matchesTeamFilter(
    event,
    classified.actor,
    filter.from_teams,
    options.teamMemberships,
    membershipChecks,
  );
}

function matchesStaticFilter(
  classified: ReturnType<typeof classifyGitHubEvent>,
  filter: TriggerFilter | undefined,
  event: NormalizedGitHubEvent,
  connectionId: string | null | undefined,
): boolean {
  if (filter === undefined) return false;
  if (!hasActorAllowlist(filter)) return false;
  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) return false;

  const repo = filter["repo"];
  if (typeof repo === "string" && repo !== event.repo) return false;

  const resourceId = filter["resourceId"];
  if (typeof resourceId === "string" && resourceId !== String(event.repositoryId)) return false;

  const pattern = readStringFilter(filter, "pattern");
  if (pattern !== undefined && !classified.text.startsWith(pattern)) return false;

  const contains = readStringFilter(filter, "contains");
  if (contains !== undefined && !classified.text.includes(contains)) return false;

  const label = readStringFilter(filter, "label");
  if (label !== undefined && !sameLabel(label, classified.changedLabel)) return false;

  const labels = filter.labels;
  return !(
    labels !== undefined &&
    !labels.every((labelName) => classified.labels.some((current) => sameLabel(labelName, current)))
  );
}

function hasActorAllowlist(filter: TriggerFilter): boolean {
  return (filter.from_users?.length ?? 0) > 0 || (filter.from_teams?.length ?? 0) > 0;
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

function readStringFilter(
  filter: TriggerFilter,
  key: "pattern" | "contains" | "label",
): string | undefined {
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

function sameLabel(expected: string, actual: string | undefined): boolean {
  return (
    actual !== undefined &&
    expected.localeCompare(actual, undefined, { sensitivity: "accent" }) === 0
  );
}
