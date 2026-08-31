import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type { NormalizedForgejoEvent } from "./normalize.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedForgejoTriggerEvent {
  event: NormalizedForgejoEvent;
  trigger: MatchedTriggerDefinition;
  routeRunIdentity: string;
}

export function readForgejoInvocationMessage(event: NormalizedForgejoEvent): string {
  return event.text;
}

export function readForgejoInvocationParserMessage(
  event: NormalizedForgejoEvent,
  filter: TriggerFilter | undefined,
): string {
  const message = readForgejoInvocationMessage(event);
  if (filter === undefined) return message;
  const contains = readStringFilter(filter, "contains");
  if (contains === undefined) return message;
  const index = message.indexOf(contains);
  return index === -1 ? message : message.slice(index);
}

export function readForgejoMention(
  event: NormalizedForgejoEvent,
  filter: TriggerFilter | undefined,
): string | undefined {
  const message = readForgejoInvocationMessage(event);
  const candidate = filter?.pattern ?? filter?.contains;
  return candidate !== undefined && message.includes(candidate) ? candidate : undefined;
}

export function matchForgejoTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedForgejoEvent,
  connectionId?: string | null,
): MatchedForgejoTriggerEvent[] {
  const eventNames = new Set(
    [event.receiptSource, event.rawFamily, event.semanticEvent].filter(
      (name): name is string => name !== undefined,
    ),
  );
  const matches: MatchedForgejoTriggerEvent[] = [];
  for (const trigger of config.triggers) {
    if (!eventNames.has(trigger.on) || !matchesFilter(event, trigger.filters, connectionId)) {
      continue;
    }
    matches.push({
      event,
      trigger,
      routeRunIdentity: `${event.identity.eventId}:${trigger.name}`,
    });
  }
  return matches;
}

function matchesFilter(
  event: NormalizedForgejoEvent,
  filter: TriggerFilter | undefined,
  connectionId?: string | null,
): boolean {
  if (filter === undefined) return false;
  if (filter.from_users === undefined || filter.from_users.length === 0) return false;
  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) return false;
  const repo = filter["repo"];
  if (typeof repo === "string" && repo !== event.context.repository.full_name) return false;
  const resourceId = filter["resourceId"];
  if (typeof resourceId === "string" && resourceId !== String(event.context.repository.id)) {
    return false;
  }
  const pattern = readStringFilter(filter, "pattern");
  if (pattern !== undefined && !event.text.startsWith(pattern)) return false;
  const contains = readStringFilter(filter, "contains");
  if (contains !== undefined && !event.text.includes(contains)) return false;
  if (!filter.from_users.includes("*") && !filter.from_users.includes(event.context.actor.login)) {
    return false;
  }
  const labels = filter.labels;
  if (
    labels !== undefined &&
    !labels.every((labelName) => event.labels.some((current) => sameLabel(labelName, current)))
  ) {
    return false;
  }
  return true;
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
