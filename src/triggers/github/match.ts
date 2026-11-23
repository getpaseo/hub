import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { classifyGitHubEvent } from "./classification.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedTriggerEvent {
  event: NormalizedGitHubEvent;
  trigger: MatchedTriggerDefinition;
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
): MatchedTriggerEvent[] {
  const classified = classifyGitHubEvent(event);
  const eventNames = new Set([`github.${event.type}`, classified.semanticEvent]);
  const matches: MatchedTriggerEvent[] = [];

  for (const trigger of config.triggers) {
    if (
      !eventNames.has(trigger.on) ||
      !matchesFilter(classified, trigger.filters, event, connectionId)
    ) {
      continue;
    }

    matches.push({ event, trigger });
  }

  return matches;
}

function matchesFilter(
  classified: ReturnType<typeof classifyGitHubEvent>,
  filter: TriggerFilter | undefined,
  event: NormalizedGitHubEvent,
  connectionId?: string | null,
): boolean {
  if (filter === undefined) {
    return false;
  }

  if (!admitsActor(classified, filter)) {
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

  if (!matchesText(classified.text, filter)) {
    return false;
  }

  const label = readStringFilter(filter, "label");
  if (label !== undefined && !sameLabel(label, classified.changedLabel)) {
    return false;
  }

  const labels = filter.labels;
  if (
    labels !== undefined &&
    !labels.every((labelName) => classified.labels.some((current) => sameLabel(labelName, current)))
  ) {
    return false;
  }

  return true;
}

/**
 * Who may invoke the trigger. A trigger names people, repository associations, or both; each one
 * it declares narrows the audience, and a trigger that declares neither admits nobody.
 */
function admitsActor(
  classified: ReturnType<typeof classifyGitHubEvent>,
  filter: TriggerFilter,
): boolean {
  const users = filter.from_users;
  const associations = filter.author_associations;
  if (users === undefined && associations === undefined) return false;
  if (users !== undefined && !users.includes("*") && !users.includes(classified.actor)) {
    return false;
  }
  return (
    associations === undefined ||
    (classified.actorAssociation !== undefined &&
      associations.includes(classified.actorAssociation))
  );
}

function matchesText(text: string, filter: TriggerFilter): boolean {
  const pattern = readStringFilter(filter, "pattern");
  if (pattern !== undefined && !text.startsWith(pattern)) return false;
  const contains = readStringFilter(filter, "contains");
  if (contains !== undefined && !text.includes(contains)) return false;
  const excluded = readStringFilter(filter, "exclude_contains");
  return excluded === undefined || !text.includes(excluded);
}

function readStringFilter(
  filter: TriggerFilter,
  key: "pattern" | "contains" | "exclude_contains" | "label",
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
