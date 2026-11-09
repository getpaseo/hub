import type { ProviderConfigurationDefinition } from "../configuration.js";

export const triggerConfiguration: ProviderConfigurationDefinition = {
  provider: "discord",
  order: 1,
  replyType: "discord.reply",
  events: { "discord.mention": { label: "Discord mention" } },
};
