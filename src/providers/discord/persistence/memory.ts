import type { MemoryProviderContext } from "../../../db/provider-persistence.js";
import type {
  AcceptDiscordEventInput,
  BindDiscordConnectionInput,
  ConnectionStartAuthority,
  DiscordConnectionRecord,
  ProviderEventAcceptance,
} from "../../../db/types.js";
export class DiscordMemoryPersistence {
  private readonly discordConnections = new Map<string, DiscordConnectionRecord>();
  constructor(private readonly context: MemoryProviderContext) {}
  async acceptDiscordEvent(input: AcceptDiscordEventInput): Promise<ProviderEventAcceptance> {
    const binding = await this.findDiscordConnection(input.guildId);
    const reason = discordDropReason(input, binding);
    return this.context.accept(
      "discord",
      input,
      binding?.organizationId,
      binding?.id,
      input.guildId,
      reason,
    );
  }
  bindDiscordConnection(_input: BindDiscordConnectionInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }
  findDiscordConnection(_guildId: string): Promise<DiscordConnectionRecord | undefined> {
    return Promise.resolve(this.discordConnections.get(_guildId));
  }
  findDiscordConnectionForOrganization(
    organizationId: string,
    guildId: string,
  ): Promise<DiscordConnectionRecord | undefined> {
    const connection = this.discordConnections.get(guildId);
    return Promise.resolve(connection?.organizationId === organizationId ? connection : undefined);
  }
  removeDiscordConnection(): Promise<void> {
    return Promise.resolve();
  }
  async listConnections(organizationId?: string) {
    return Array.from(this.discordConnections.values()).filter(
      (connection) => organizationId === undefined || connection.organizationId === organizationId,
    );
  }
  disconnectConnection(_connectionId: string, _access: ConnectionStartAuthority): never {
    return connectionPersistenceUnavailable();
  }
}
function discordDropReason(
  input: AcceptDiscordEventInput,
  binding: DiscordConnectionRecord | undefined,
): string | undefined {
  if (input.dropReason !== undefined) return input.dropReason;
  if (binding === undefined) return "discord_unbound";
  return undefined;
}
function connectionPersistenceUnavailable(): never {
  throw new Error("connection persistence requires PostgreSQL");
}
export function discordMemoryPersistence(context: MemoryProviderContext) {
  return new DiscordMemoryPersistence(context);
}
