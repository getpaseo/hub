import type { MemoryProviderContext } from "../../../db/provider-persistence.js";
import type {
  AcceptSlackEventInput,
  BindSlackConnectionInput,
  CompleteSlackProviderApplicationInput,
  ConnectionStartAuthority,
  ProviderEventAcceptance,
  SlackConnectionRecord,
} from "../../../db/types.js";
export class SlackMemoryPersistence {
  private readonly slackConnections = new Map<string, SlackConnectionRecord>();
  constructor(private readonly context: MemoryProviderContext) {
    for (const connection of context.options.slackConnections ?? [])
      this.slackConnections.set(connection.teamId, connection);
  }
  async acceptSlackEvent(input: AcceptSlackEventInput): Promise<ProviderEventAcceptance> {
    const binding = await this.findSlackConnection(input.teamId);
    const reason = slackDropReason(input, binding);
    return this.context.accept(
      "slack",
      input,
      binding?.organizationId,
      binding?.id,
      input.teamId,
      reason,
    );
  }
  bindSlackConnection(_input: BindSlackConnectionInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }
  completeSlackProviderApplication(_input: CompleteSlackProviderApplicationInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }
  findSlackConnection(_teamId: string): Promise<SlackConnectionRecord | undefined> {
    return Promise.resolve(this.slackConnections.get(_teamId));
  }
  findSlackConnectionForOrganization(
    organizationId: string,
    teamId: string,
  ): Promise<SlackConnectionRecord | undefined> {
    const connection = this.slackConnections.get(teamId);
    return Promise.resolve(connection?.organizationId === organizationId ? connection : undefined);
  }
  async listConnections(organizationId?: string) {
    return Array.from(this.slackConnections.values()).filter(
      (connection) => organizationId === undefined || connection.organizationId === organizationId,
    );
  }
  disconnectConnection(_connectionId: string, _access: ConnectionStartAuthority): never {
    return connectionPersistenceUnavailable();
  }
}
function slackDropReason(
  input: AcceptSlackEventInput,
  binding: SlackConnectionRecord | undefined,
): string | undefined {
  if (input.dropReason !== undefined) return input.dropReason;
  if (binding === undefined) return "slack_unbound";
  return undefined;
}
function connectionPersistenceUnavailable(): never {
  throw new Error("connection persistence requires PostgreSQL");
}
export function slackMemoryPersistence(context: MemoryProviderContext) {
  return new SlackMemoryPersistence(context);
}
