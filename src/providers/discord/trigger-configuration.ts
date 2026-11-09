import type { ProviderConfigurationDefinition } from "../configuration.js";
import { filterFields, projectLegacyFilters } from "./filter-configuration.js";

export const triggerConfiguration: ProviderConfigurationDefinition = {
  filterFields,
  projectLegacyFilters,
  provider: "discord",
  order: 1,
  replyType: "discord.reply",
  events: { "discord.mention": { label: "Discord mention" } },
};
