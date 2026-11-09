import { ProviderPersistence } from "../../db/provider-persistence.js";
import type * as Types from "../../db/types.js";
import { slackMemoryPersistence } from "./persistence/memory.js";
import { SlackPostgresPersistence } from "./persistence/postgres.js";
export interface SlackPersistence {
  acceptSlackEvent(input: Types.AcceptSlackEventInput): Promise<Types.ProviderEventAcceptance>;
  bindSlackConnection(input: Types.BindSlackConnectionInput): Promise<void>;
  completeSlackProviderApplication(
    input: Types.CompleteSlackProviderApplicationInput,
  ): Promise<void>;
  findSlackConnection(teamId: string): Promise<Types.SlackConnectionRecord | undefined>;
  findSlackConnectionForOrganization(
    organizationId: string,
    teamId: string,
  ): Promise<Types.SlackConnectionRecord | undefined>;
  listConnections(organizationId?: string): Promise<Types.SlackConnectionRecord[]>;
  disconnectConnection(
    connectionId: string,
    access: Types.ConnectionStartAuthority,
  ): Promise<Extract<Types.DisconnectConnectionResult, { provider: "slack" }>>;
}
const persistence = new ProviderPersistence<SlackPersistence>({
  postgres: (context) => new SlackPostgresPersistence(context),
  memory: slackMemoryPersistence,
});
export function slackPersistence(
  database: Pick<Types.Database, "providerPersistence">,
): SlackPersistence {
  return persistence.for(database);
}
