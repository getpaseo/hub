import type { ProviderConfigurationDefinition } from "../configuration.js";

export const triggerConfiguration: ProviderConfigurationDefinition = {
  provider: "linear",
  order: 3,
  replyType: "linear.reply",
  events: {
    "linear.issue_entered_scope": { label: "Linear issue entered scope" },
    "linear.issue_assigned": { label: "Linear issue assigned" },
    "linear.comment_created": { label: "Linear comment created" },
  },
};
