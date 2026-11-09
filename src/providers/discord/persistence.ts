import { ProviderPersistence } from "../../db/provider-persistence.js";
import type * as Types from "../../db/types.js";
import { discordMemoryPersistence } from "./persistence/memory.js";
import { DiscordPostgresPersistence } from "./persistence/postgres.js";
export interface DiscordPersistence {
  acceptDiscordEvent(input: Types.AcceptDiscordEventInput): Promise<Types.ProviderEventAcceptance>;
  bindDiscordConnection(input: Types.BindDiscordConnectionInput): Promise<void>;
  findDiscordConnection(guildId: string): Promise<Types.DiscordConnectionRecord | undefined>;
  findDiscordConnectionForOrganization(
    organizationId: string,
    guildId: string,
  ): Promise<Types.DiscordConnectionRecord | undefined>;
  removeDiscordConnection(guildId: string): Promise<void>;
  listConnections(organizationId?: string): Promise<Types.DiscordConnectionRecord[]>;
  disconnectConnection(
    connectionId: string,
    access: Types.ConnectionStartAuthority,
  ): Promise<Extract<Types.DisconnectConnectionResult, { provider: "discord" }>>;
}
const persistence = new ProviderPersistence<DiscordPersistence>({
  postgres: (context) => new DiscordPostgresPersistence(context),
  memory: discordMemoryPersistence,
});
export function discordPersistence(
  database: Pick<Types.Database, "providerPersistence">,
): DiscordPersistence {
  return persistence.for(database);
}
