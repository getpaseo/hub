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
  "no_project_route",
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
  no_project_route: "No project route is configured for this event.",
};

export function routingDecisionSummary(code: RoutingDecisionCode): string {
  return ROUTING_DECISION_SUMMARIES[code];
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
  return decisions
    .flatMap((decision) => {
      const normalized = normalizeRoutingDecision(decision);
      return normalized === undefined ? [] : [normalized];
    })
    .slice(0, MAX_ROUTING_DECISIONS_PER_PROJECT);
}
