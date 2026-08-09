export const ROUTING_DECISION_CODES = [
  "no_trigger_for_source",
  "connection_mismatch",
  "resource_mismatch",
  "repository_mismatch",
  "guild_mismatch",
  "workspace_mismatch",
  "channel_mismatch",
  "sender_not_allowed",
  "contains_mismatch",
  "pattern_mismatch",
  "input_filter_mismatch",
  "invocation_rejected",
  "configuration_unavailable",
  "no_project_route",
  "routing_evidence_truncated",
] as const;

export type RoutingDecisionCode = (typeof ROUTING_DECISION_CODES)[number];

export interface TriggerRoutingDecision {
  triggerName: string | null;
  code: RoutingDecisionCode;
}

export const MAX_ROUTING_EVIDENCE_PER_RECEIPT = 50;
export const MAX_ROUTING_DECISIONS_PER_PROJECT = 25;
export const MAX_ROUTING_TRIGGER_NAME_LENGTH = 128;

const ROUTING_DECISION_SUMMARIES: Record<RoutingDecisionCode, string> = {
  no_trigger_for_source: "No configured trigger handles this event.",
  connection_mismatch: "The event connection does not match this trigger.",
  resource_mismatch: "The event resource does not match this trigger.",
  repository_mismatch: "The repository does not match this trigger.",
  guild_mismatch: "The guild does not match this trigger.",
  workspace_mismatch: "The workspace does not match this trigger.",
  channel_mismatch: "The channel does not match this trigger.",
  sender_not_allowed: "The sender is not allowed for this trigger.",
  contains_mismatch: "The event does not contain the configured trigger marker.",
  pattern_mismatch: "The event does not match the configured trigger pattern.",
  input_filter_mismatch: "The parsed inputs do not match this trigger.",
  invocation_rejected: "The trigger invocation was rejected.",
  configuration_unavailable: "Trigger configuration is unavailable for this event.",
  no_project_route: "No project route is configured for this event.",
  routing_evidence_truncated:
    "Some trigger decisions were omitted because the evidence limit was reached.",
};

const ROUTING_DECISION_PRIORITIES: Record<RoutingDecisionCode, number> = {
  no_project_route: 0,
  configuration_unavailable: 1,
  connection_mismatch: 10,
  resource_mismatch: 11,
  repository_mismatch: 12,
  guild_mismatch: 13,
  workspace_mismatch: 14,
  channel_mismatch: 15,
  sender_not_allowed: 20,
  contains_mismatch: 30,
  pattern_mismatch: 31,
  input_filter_mismatch: 40,
  invocation_rejected: 50,
  no_trigger_for_source: 90,
  routing_evidence_truncated: 100,
};

export function routingDecisionSummary(code: RoutingDecisionCode): string {
  return ROUTING_DECISION_SUMMARIES[code];
}

export function orderRoutingDecisions<
  Decision extends Pick<TriggerRoutingDecision, "triggerName" | "code">,
>(decisions: readonly Decision[]): Decision[] {
  return [...decisions].sort((left, right) => {
    const priority =
      ROUTING_DECISION_PRIORITIES[left.code] - ROUTING_DECISION_PRIORITIES[right.code];
    if (priority !== 0) return priority;
    if (left.triggerName === right.triggerName) return 0;
    if (left.triggerName === null) return 1;
    if (right.triggerName === null) return -1;
    return left.triggerName.localeCompare(right.triggerName);
  });
}

export function isRoutingDecisionCode(value: unknown): value is RoutingDecisionCode {
  return typeof value === "string" && ROUTING_DECISION_CODES.some((code) => code === value);
}

export function boundRoutingTriggerName(triggerName: string | null): string | null {
  if (triggerName === null) return null;
  return triggerName.length <= MAX_ROUTING_TRIGGER_NAME_LENGTH
    ? triggerName
    : `${triggerName.slice(0, MAX_ROUTING_TRIGGER_NAME_LENGTH - 1)}…`;
}

export function normalizeRoutingDecision(
  decision: TriggerRoutingDecision,
): TriggerRoutingDecision | undefined {
  if (!isRoutingDecisionCode(decision.code)) return undefined;
  return {
    triggerName: boundRoutingTriggerName(decision.triggerName),
    code: decision.code,
  };
}

export function normalizeRoutingDecisions(
  decisions: readonly TriggerRoutingDecision[],
): TriggerRoutingDecision[] {
  const normalized = decisions.flatMap((decision) => {
    const normalizedDecision = normalizeRoutingDecision(decision);
    return normalizedDecision === undefined ? [] : [normalizedDecision];
  });
  const sourceRelevant = normalized.filter((decision) => decision.code !== "no_trigger_for_source");
  let projectDecisions: TriggerRoutingDecision[] = [];
  if (sourceRelevant.length > 0) {
    projectDecisions = sourceRelevant;
  } else if (normalized.some((decision) => decision.code === "no_trigger_for_source")) {
    projectDecisions = [{ triggerName: null, code: "no_trigger_for_source" }];
  }
  const seen = new Set<string>();
  const unique = projectDecisions.filter((decision) => {
    const key = `${decision.triggerName ?? ""}:${decision.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length <= MAX_ROUTING_DECISIONS_PER_PROJECT) return unique;

  return [
    ...unique.slice(0, MAX_ROUTING_DECISIONS_PER_PROJECT - 1),
    { triggerName: null, code: "routing_evidence_truncated" },
  ];
}
