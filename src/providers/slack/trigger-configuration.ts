import type { ProviderConfigurationDefinition } from "../configuration.js";
import { filterFields, projectLegacyFilters } from "./filter-configuration.js";

export const triggerConfiguration: ProviderConfigurationDefinition = {
  preparationFailureCodes: ["slack_trigger_unavailable"],
  filterFields,
  projectLegacyFilters,
  provider: "slack",
  order: 0,
  replyType: "slack.reply",
  defaultEvent: "slack.mention",
  events: { "slack.mention": { label: "Slack mention" } },
};
