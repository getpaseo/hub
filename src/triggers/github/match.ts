import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { matchesCommonForgeFilter, readForgeStringFilter, sameForgeName } from "../forge/match.js";
import { classifyGitHubEvent } from "./classification.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedTriggerEvent {
  event: NormalizedGitHubEvent;
  trigger: MatchedTriggerDefinition;
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
  if (filter === undefined) return false;
  if (!matchesCommonForgeFilter(classified, filter, connectionId)) return false;

  const repo = filter["repo"];
  if (typeof repo === "string" && repo !== event.repo) return false;

  const resourceId = filter["resourceId"];
  if (typeof resourceId === "string" && resourceId !== String(event.repositoryId)) return false;

  const label = readForgeStringFilter(filter, "label");
  return label === undefined || sameForgeName(label, classified.changedLabel);
}
