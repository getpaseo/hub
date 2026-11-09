import type { ProviderConfigurationDefinition } from "../configuration.js";
import { filterFields, nativeFilters, projectLegacyFilters } from "./filter-configuration.js";

export const triggerConfiguration: ProviderConfigurationDefinition = {
  filterFields,
  projectLegacyFilters,
  allowsLaunchWithoutActor(trigger) {
    if (trigger.on !== "linear.issue_entered_scope") return false;
    if (nativeFilters(trigger.filters ?? {}).project === undefined)
      throw new Error(
        `trigger ${trigger.name} requires filters.project for linear.issue_entered_scope`,
      );
    return true;
  },
  provider: "linear",
  order: 3,
  replyType: "linear.reply",
  events: {
    "linear.issue_entered_scope": { label: "Linear issue entered scope" },
    "linear.issue_assigned": { label: "Linear issue assigned" },
    "linear.comment_created": { label: "Linear comment created" },
  },
};
