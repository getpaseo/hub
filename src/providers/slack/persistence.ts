import { ProviderPersistence } from "../../db/provider-persistence.js";
import type * as Types from "../../db/types.js";
import type { StoredProviderApplication } from "../../provider-applications/index.js";
import type {
  SlackProviderApplicationConfiguration,
  SlackProviderApplicationIdentity,
} from "./application-configuration.js";
import type { VerifiedSlackInstallation } from "./installation.js";
import type {
  AcceptSlackEventInput,
  BindSlackConnectionInput,
  CompleteSlackProviderApplicationInput,
  SlackConnectionRecord,
} from "./persistence-types.js";
import { slackMemoryPersistence } from "./persistence/memory.js";
import { SlackPostgresPersistence } from "./persistence/postgres.js";
export interface SlackSocketApplicationCommit {
  configuration: Extract<SlackProviderApplicationConfiguration, { transport: "socket" }>;
  identity: SlackProviderApplicationIdentity;
  expectedVersion: number | undefined;
  updatedByUserId: string;
  organizationId: string;
  installation: VerifiedSlackInstallation;
}
export interface SlackPersistence {
  completeSlackSocketApplication(
    input: SlackSocketApplicationCommit,
  ): Promise<StoredProviderApplication>;
  acceptSlackEvent(input: AcceptSlackEventInput): Promise<Types.ProviderEventAcceptance>;
  bindSlackConnection(input: BindSlackConnectionInput): Promise<void>;
  completeSlackProviderApplication(input: CompleteSlackProviderApplicationInput): Promise<void>;
  findSlackConnection(teamId: string): Promise<SlackConnectionRecord | undefined>;
  findSlackConnectionForOrganization(
    organizationId: string,
    teamId: string,
  ): Promise<SlackConnectionRecord | undefined>;
  listConnections(organizationId?: string): Promise<SlackConnectionRecord[]>;
  disconnectConnection(
    connectionId: string,
    access: Types.ConnectionStartAuthority,
  ): Promise<{ provider: "slack"; teamId: string | undefined; botAccessToken: string | undefined }>;
}
const persistence = new ProviderPersistence<SlackPersistence>({
  id: "slack",
  postgres: (context) => new SlackPostgresPersistence(context),
  memory: slackMemoryPersistence,
});
export function slackPersistence(
  database: Pick<Types.Database, "providerPersistence">,
): SlackPersistence {
  return persistence.for(database);
}
