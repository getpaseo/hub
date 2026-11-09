import { ProviderPersistence } from "../../db/provider-persistence.js";
import type * as Types from "../../db/types.js";
import { linearMemoryPersistence } from "./persistence/memory.js";
import { LinearPostgresPersistence } from "./persistence/postgres.js";
export interface LinearPersistence {
  acceptLinearEvent(input: Types.AcceptLinearEventInput): Promise<Types.ProviderEventAcceptance>;
  bindLinearConnection(input: Types.BindLinearConnectionInput): Promise<void>;
  completeLinearProviderApplication(
    input: Types.CompleteLinearProviderApplicationInput,
  ): Promise<void>;
  updateLinearConnectionTokens(input: Types.UpdateLinearConnectionTokensInput): Promise<void>;
  /** Re-read and update tokens under the same transaction lock as OAuth rebind. */
  withLinearConnectionRefresh<T>(
    linearOrganizationId: string,
    operation: Types.LinearConnectionRefreshOperation<T>,
  ): Promise<T>;
  findLinearConnection(
    linearOrganizationId: string,
  ): Promise<Types.LinearConnectionRecord | undefined>;
  findLinearConnectionForOrganization(
    organizationId: string,
    linearOrganizationId: string,
  ): Promise<Types.LinearConnectionRecord | undefined>;
  listConnections(organizationId?: string): Promise<Types.LinearConnectionRecord[]>;
  disconnectConnection(
    connectionId: string,
    access: Types.ConnectionStartAuthority,
  ): Promise<{
    provider: "linear";
    linearOrganizationId: string | undefined;
    accessToken: string | undefined;
  }>;
}
const persistence = new ProviderPersistence<LinearPersistence>({
  id: "linear",
  postgres: (context) => new LinearPostgresPersistence(context),
  memory: linearMemoryPersistence,
});
export function linearPersistence(
  database: Pick<Types.Database, "providerPersistence">,
): LinearPersistence {
  return persistence.for(database);
}
