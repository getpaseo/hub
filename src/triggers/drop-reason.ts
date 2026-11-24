export const PROVIDER_EVENT_DROP_REASON_CODES = [
  "no_project_route",
  "no_trigger_for_source",
  "trigger_filters_rejected",
  "configuration_unavailable",
  "agent_session_stopped",
] as const;

export type ProviderEventDropReasonCode = (typeof PROVIDER_EVENT_DROP_REASON_CODES)[number];
