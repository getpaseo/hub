import type { ProviderConfigurationDefinition } from "../configuration.js";

export const triggerConfiguration: ProviderConfigurationDefinition = {
  provider: "slack",
  order: 0,
  replyType: "slack.reply",
  defaultEvent: "slack.mention",
  events: { "slack.mention": { label: "Slack mention" } },
};
