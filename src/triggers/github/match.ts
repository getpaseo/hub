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

export function matchTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedGitHubEvent,
  connectionId?: string | null,
): MatchedTriggerEvent[];
export function matchTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedGitHubEvent,
  options: GitHubTriggerMatchOptions,
): Promise<MatchedTriggerEvent[]>;
export function matchTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedGitHubEvent,
  input?: string | null | GitHubTriggerMatchOptions,
): MatchedTriggerEvent[] | Promise<MatchedTriggerEvent[]> {
  const classified = classifyGitHubEvent(event);
  const eventNames = new Set([`github.${event.type}`, classified.semanticEvent]);

  if (typeof input !== "object" || input === null) {
    return matchTriggersWithoutTeams(config, event, classified, eventNames, input);
  }
  return matchTriggersWithTeams(config, event, classified, eventNames, input);
}

function matchTriggersWithoutTeams(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedGitHubEvent,
  classified: ReturnType<typeof classifyGitHubEvent>,
  eventNames: ReadonlySet<string | undefined>,
  connectionId: string | null | undefined,
): MatchedTriggerEvent[] {
  const matches: MatchedTriggerEvent[] = [];

  for (const trigger of config.triggers) {
    if (
      !eventNames.has(trigger.on) ||
      !matchesStaticFilter(classified, trigger.filters, event, connectionId) ||
      !matchesUserFilter(trigger.filters, classified.actor)
    ) {
      continue;
    }
    matches.push({ event, trigger });
  }

  return matches;
}

async function matchTriggersWithTeams(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedGitHubEvent,
  classified: ReturnType<typeof classifyGitHubEvent>,
  eventNames: ReadonlySet<string | undefined>,
  options: GitHubTriggerMatchOptions,
): Promise<MatchedTriggerEvent[]> {
  const matches: MatchedTriggerEvent[] = [];
  const membershipChecks = new Map<string, Promise<boolean>>();

  for (const trigger of config.triggers) {
    if (!eventNames.has(trigger.on)) continue;
    if (!matchesStaticFilter(classified, trigger.filters, event, options.connectionId)) continue;
    if (matchesUserFilter(trigger.filters, classified.actor)) {
      matches.push({ event, trigger });
      continue;
    }
    if (trigger.filters === undefined || classified.actor.length === 0) continue;
    if (
      !(await matchesTeamFilter(
        event,
        classified.actor,
        trigger.filters.from_teams,
        options.teamMemberships,
        membershipChecks,
      ))
    ) {
      continue;
    }
    matches.push({ event, trigger });
  }

  return matches;
}

function matchesStaticFilter(
  classified: ReturnType<typeof classifyGitHubEvent>,
  filter: TriggerFilter | undefined,
  event: NormalizedGitHubEvent,
  connectionId: string | null | undefined,
): boolean {
  if (filter === undefined) return false;
  return (
    hasIdentityAllowlist(filter) &&
    matchesConnection(filter, connectionId) &&
    matchesRepository(filter, event) &&
    matchesText(filter, classified.text) &&
    matchesLabels(filter, classified)
  );
}

function hasIdentityAllowlist(filter: TriggerFilter): boolean {
  return (filter.from_users?.length ?? 0) > 0 || (filter.from_teams?.length ?? 0) > 0;
}

function matchesConnection(
  filter: TriggerFilter,
  connectionId: string | null | undefined,
): boolean {
  return filter.connectionId === undefined || filter.connectionId === connectionId;
}

function matchesRepository(filter: TriggerFilter, event: NormalizedGitHubEvent): boolean {
  const repo = filter["repo"];
  if (typeof repo === "string" && repo !== event.repo) return false;

  const resourceId = filter["resourceId"];
  return typeof resourceId !== "string" || resourceId === String(event.repositoryId);
}

function matchesText(filter: TriggerFilter, text: string): boolean {
  const pattern = readStringFilter(filter, "pattern");
  if (pattern !== undefined && !text.startsWith(pattern)) return false;

  const contains = readStringFilter(filter, "contains");
  return contains === undefined || text.includes(contains);
}

function matchesLabels(
  filter: TriggerFilter,
  classified: ReturnType<typeof classifyGitHubEvent>,
): boolean {
  const label = readStringFilter(filter, "label");
  if (label !== undefined && !sameLabel(label, classified.changedLabel)) return false;

  return (
    filter.labels === undefined ||
    filter.labels.every((labelName) =>
      classified.labels.some((current) => sameLabel(labelName, current)),
    )
  );
}

function matchesUserFilter(filter: TriggerFilter | undefined, actor: string): boolean {
  const fromUsers = filter?.from_users;
  return fromUsers?.includes("*") === true || fromUsers?.includes(actor) === true;
}

async function matchesTeamFilter(
  event: NormalizedGitHubEvent,
  actor: string,
  references: readonly string[] | undefined,
  teamMemberships: GitHubTeamMembershipClient,
  membershipChecks: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (references === undefined) return false;

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

function sameLabel(expected: string, actual: string | undefined): boolean {
  return (
    actual !== undefined &&
    expected.localeCompare(actual, undefined, { sensitivity: "accent" }) === 0
  );
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
