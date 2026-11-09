import { ProviderPersistence } from "../../db/provider-persistence.js";
import type * as Types from "../../db/types.js";
import type {
  AcceptDiscordEventInput,
  BindDiscordConnectionInput,
  DiscordConnectionRecord,
} from "./persistence-types.js";
import { discordMemoryPersistence } from "./persistence/memory.js";
import { DiscordPostgresPersistence } from "./persistence/postgres.js";
export interface DiscordPersistence {
  acceptDiscordEvent(input: AcceptDiscordEventInput): Promise<Types.ProviderEventAcceptance>;
  bindDiscordConnection(input: BindDiscordConnectionInput): Promise<void>;
  findDiscordConnection(guildId: string): Promise<DiscordConnectionRecord | undefined>;
  findDiscordConnectionForOrganization(
    organizationId: string,
    guildId: string,
  ): Promise<DiscordConnectionRecord | undefined>;
  removeDiscordConnection(guildId: string): Promise<void>;
  listConnections(organizationId?: string): Promise<DiscordConnectionRecord[]>;
  disconnectConnection(
    connectionId: string,
    access: Types.ConnectionStartAuthority,
  ): Promise<{ provider: "discord"; guildId: string | undefined }>;
}
const persistence = new ProviderPersistence<DiscordPersistence>({
  id: "discord",
  postgres: (context) => new DiscordPostgresPersistence(context),
  memory: discordMemoryPersistence,
});
export function discordPersistence(
  database: Pick<Types.Database, "providerPersistence">,
): DiscordPersistence {
  return persistence.for(database);
}
