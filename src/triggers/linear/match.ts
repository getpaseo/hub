import type {
  CompiledTriggerConfig as CompiledTrigger,
  TriggerFilter,
} from "../../config/index.js";
import type {
  NormalizedLinearCommentEvent,
  NormalizedLinearEvent,
  NormalizedLinearIssue,
  NormalizedLinearIssueEvent,
} from "./events.js";

type MatchedTriggerDefinition = Pick<CompiledTrigger, "name" | "on" | "filters">;

export interface MatchedLinearTrigger {
  event: NormalizedLinearEvent;
  trigger: MatchedTriggerDefinition;
}

/**
 * Preserve a comment as the prompt while starting input parsing after its command marker. A
 * `contains` marker may occur in prose, so parsing begins at its first boundary-delimited
 * occurrence; input-shaped markers remain intact so declarations such as `repo=hub` can still be
 * consumed.
 */
export function readLinearCommentInvocationParserMessage(
  event: NormalizedLinearCommentEvent,
  filter: TriggerFilter | undefined,
): string {
  const body = event.comment.body;
  const pattern = readCommentTextFilter(filter, "pattern");
  if (pattern !== undefined) {
    return body.startsWith(pattern) ? stripLinearCommandMarker(body, pattern) : body;
  }
  const contains = readCommentTextFilter(filter, "contains");
  if (contains === undefined) return body;
  const index = findBoundaryDelimitedMarker(body, contains);
  if (index === undefined) return body;
  return stripLinearCommandMarker(body.slice(index), contains);
}

/**
 * Match Linear's entity-level webhooks onto the small set of workflow-facing events. A scope
 * transition is edge-triggered: an eligible issue creates one run when it enters scope rather
 * than another run for every later title, estimate, or description update.
 */
export function matchLinearTriggers(
  config: { triggers: readonly MatchedTriggerDefinition[] },
  event: NormalizedLinearEvent,
  connectionId?: string | null,
): MatchedLinearTrigger[] {
  return config.triggers.flatMap((trigger) => {
    if (!matchesLinearEvent(trigger.on, event)) return [];
    if (!matchesTriggerFilter(trigger, event, connectionId)) return [];
    return [{ event, trigger }];
  });
}

export function matchesIssueScope(
  issue: NormalizedLinearIssue,
  filter: TriggerFilter | undefined,
  connectionId?: string | null,
): boolean {
  if (filter === undefined) return false;
  if (filter.connectionId !== undefined && filter.connectionId !== connectionId) return false;
  if (filter.project !== undefined && filter.project !== issue.projectId) return false;
  if (filter.states !== undefined && !matchesOptionalId(filter.states, issue.stateId)) return false;
  if (filter.assignees !== undefined && !matchesOptionalId(filter.assignees, issue.assigneeId)) {
    return false;
  }
  if (
    filter.labels !== undefined &&
    !filter.labels.every((label) => issue.labelIds.includes(label))
  ) {
    return false;
  }
  if (
    filter.exclude_labels !== undefined &&
    filter.exclude_labels.some((label) => issue.labelIds.includes(label))
  ) {
    return false;
  }
  return true;
}

function matchesLinearEvent(eventName: string, event: NormalizedLinearEvent): boolean {
  if (eventName === "linear.issue_entered_scope") {
    return event.type === "issue" && (event.action === "create" || event.action === "update");
  }
  if (eventName === "linear.issue_assigned") {
    return (
      event.type === "issue" &&
      event.action === "update" &&
      event.issue.assigneeId !== null &&
      Object.hasOwn(event.updatedFrom, "assigneeId")
    );
  }
  return (
    eventName === "linear.comment_created" && event.type === "comment" && event.action === "create"
  );
}

function matchesTriggerFilter(
  trigger: MatchedTriggerDefinition,
  event: NormalizedLinearEvent,
  connectionId?: string | null,
): boolean {
  if (trigger.on === "linear.issue_entered_scope") {
    return (
      event.type === "issue" &&
      enteredConfiguredScope(event, trigger.filters, connectionId) &&
      matchesActorIfPresent(event, trigger.filters?.from_users)
    );
  }
  const issue = event.type === "issue" ? event.issue : event.issue;
  if (issue === null || !matchesIssueScope(issue, trigger.filters, connectionId)) return false;
  if (!matchesActor(event, trigger.filters?.from_users)) return false;
  if (event.type === "comment" && !matchesCommentText(event, trigger.filters)) return false;
  return true;
}

/** The filter-specific edge check, separated to keep the generic event selection readable. */
function enteredConfiguredScope(
  event: NormalizedLinearIssueEvent,
  filter: TriggerFilter | undefined,
  connectionId?: string | null,
): boolean {
  if (!matchesIssueScope(event.issue, filter, connectionId)) return false;
  if (event.action === "create") return true;
  if (event.action !== "update") return false;
  const before: NormalizedLinearIssue = {
    ...event.issue,
    ...(Object.hasOwn(event.updatedFrom, "projectId")
      ? { projectId: event.updatedFrom.projectId ?? null }
      : {}),
    ...(Object.hasOwn(event.updatedFrom, "stateId")
      ? { stateId: event.updatedFrom.stateId ?? null }
      : {}),
    ...(Object.hasOwn(event.updatedFrom, "assigneeId")
      ? { assigneeId: event.updatedFrom.assigneeId ?? null }
      : {}),
    ...(Object.hasOwn(event.updatedFrom, "labelIds")
      ? { labelIds: event.updatedFrom.labelIds ?? [] }
      : {}),
  };
  return !matchesIssueScope(before, filter, connectionId);
}

function matchesActorIfPresent(
  event: NormalizedLinearEvent,
  allowed: readonly string[] | undefined,
): boolean {
  return allowed === undefined || allowed.length === 0 || matchesActor(event, allowed);
}

function matchesActor(
  event: NormalizedLinearEvent,
  allowed: readonly string[] | undefined,
): boolean {
  if (allowed === undefined || allowed.length === 0 || event.actor === null) return false;
  return allowed.includes(event.actor.id);
}

function matchesOptionalId(allowed: readonly string[], value: string | null): boolean {
  return value !== null && allowed.includes(value);
}

function matchesCommentText(
  event: NormalizedLinearCommentEvent,
  filter: TriggerFilter | undefined,
): boolean {
  const pattern = filter?.pattern;
  if (pattern !== undefined && !event.comment.body.startsWith(pattern)) return false;
  const contains = filter?.contains;
  return contains === undefined || event.comment.body.includes(contains);
}

function stripLinearCommandMarker(message: string, marker: string): string {
  if (marker.length === 0 || marker.includes("=")) return message;
  const nextCharacter = message.at(marker.length);
  return nextCharacter === undefined || /\s/u.test(nextCharacter)
    ? message.slice(marker.length).trimStart()
    : message;
}

function findBoundaryDelimitedMarker(message: string, marker: string): number | undefined {
  let start = 0;
  while (start < message.length) {
    const index = message.indexOf(marker, start);
    if (index === -1) return undefined;
    const before = message.at(index - 1);
    const after = message.at(index + marker.length);
    if (
      (index === 0 || (before !== undefined && /\s/u.test(before))) &&
      (after === undefined || /\s/u.test(after))
    ) {
      return index;
    }
    start = index + marker.length;
  }
  return undefined;
}

function readCommentTextFilter(
  filter: TriggerFilter | undefined,
  key: "pattern" | "contains",
): string | undefined {
  const value = filter?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
