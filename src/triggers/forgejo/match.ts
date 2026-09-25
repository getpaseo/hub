import { z } from "zod";
import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import { matchesCommonForgeFilter, readForgeStringFilter, sameForgeName } from "../forge/match.js";
import { classifyForgejoEvent } from "./events.js";
import type { ForgejoClassifiedEvent, NormalizedForgejoEvent } from "./events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedForgejoTrigger {
  event: NormalizedForgejoEvent;
  trigger: MatchedTriggerDefinition;
}

export function matchForgejoTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedForgejoEvent,
  connectionId?: string | null,
): MatchedForgejoTrigger[] {
  const classified = classifyForgejoEvent(event);
  const eventNames = new Set([`forgejo.${event.type}`, classified.semanticEvent]);
  const matches: MatchedForgejoTrigger[] = [];

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
  classified: ForgejoClassifiedEvent,
  filter: TriggerFilter | undefined,
  event: NormalizedForgejoEvent,
  connectionId?: string | null,
): boolean {
  if (filter === undefined) return false;
  if (!matchesCommonForgeFilter(classified, filter, connectionId)) return false;

  // matched by repository id, not the raw repo string, so a rename after save still
  // matches. A repo filter that never resolved a resourceId must never fall back to
  // a string compare, or it would silently match every repository.
  const repo = filter["repo"];
  const resourceId = filter["resourceId"];
  if (typeof repo === "string" && typeof resourceId !== "string") return false;
  if (typeof resourceId === "string" && resourceId !== String(event.repositoryId)) return false;

  return (
    matchesAddedLabelFilter(classified, filter) &&
    matchesAssigneesFilter(classified, filter) &&
    matchesReviewersFilter(classified, filter) &&
    matchesBranchesFilter(event, filter)
  );
}

/** Read off addedLabels since Forgejo's webhook body carries no label field. */
function matchesAddedLabelFilter(
  classified: ForgejoClassifiedEvent,
  filter: TriggerFilter,
): boolean {
  const label = readForgeStringFilter(filter, "label");
  return (
    label === undefined || classified.addedLabels.some((current) => sameForgeName(label, current))
  );
}

function matchesAssigneesFilter(
  classified: ForgejoClassifiedEvent,
  filter: TriggerFilter,
): boolean {
  const assignees = filter.assignees;
  return (
    assignees === undefined ||
    assignees.includes("*") ||
    assignees.some((login) =>
      classified.addedAssignees.some((current) => sameForgeName(login, current)),
    )
  );
}

/** Matched against requestedReviewer, read straight off the wire, not derived from a
 * timeline like an added label or assignee. */
function matchesReviewersFilter(
  classified: ForgejoClassifiedEvent,
  filter: TriggerFilter,
): boolean {
  const reviewers = filter.reviewers;
  return (
    reviewers === undefined ||
    reviewers.includes("*") ||
    reviewers.some((login) => sameForgeName(login, classified.requestedReviewer))
  );
}

const ForgejoPushRefPayloadSchema = z
  .object({ ref: z.string().optional().catch(undefined) })
  .passthrough();

const REF_HEADS_PREFIX = "refs/heads/";

/** forgejo.push only. Matched exact and case sensitive, unlike every other filter
 * here, since git branch names are themselves case sensitive. A tag push never
 * matches, not even a bare "*". */
function matchesBranchesFilter(event: NormalizedForgejoEvent, filter: TriggerFilter): boolean {
  const branches = filter.branches;
  if (branches === undefined) return true;
  const ref = ForgejoPushRefPayloadSchema.safeParse(event.payload).data?.ref;
  if (ref === undefined || !ref.startsWith(REF_HEADS_PREFIX)) return false;
  const branch = ref.slice(REF_HEADS_PREFIX.length);
  return branches.includes("*") || branches.includes(branch);
}
