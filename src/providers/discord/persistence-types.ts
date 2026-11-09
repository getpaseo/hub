import type { ProviderEventEvidence, ReadConnectionAttemptInput } from "../../db/types.js";

export interface DiscordConnectionRecord {
  id: string;
  organizationId: string;
  slug: string;
  guildId: string;
  guildName: string;
  providerApplicationId: string | null;
}

export interface BindDiscordConnectionInput extends ReadConnectionAttemptInput {
  providerApplicationId: string;
  guildId: string;
  guildName: string;
}

export interface AcceptDiscordEventInput extends ProviderEventEvidence {
  guildId: string;
}
