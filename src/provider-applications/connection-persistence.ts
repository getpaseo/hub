import type { DatabaseRuntime, QueryHandle, QueryRow } from "../db/runtime/index.js";
import type { ConnectedProviderIdentity } from "./index.js";

export interface ConnectionIdentityRow extends QueryRow {
  id: string;
  name: string;
  application_id: string | null;
  action_needed: boolean;
  scopes: unknown;
  refresh_token?: unknown;
  access_token_expires_at?: unknown;
}
export interface ProviderConnectionInventory {
  connectionSlugs(transaction: QueryHandle, organizationId: string): Promise<readonly string[]>;
  connectedIdentities(): Promise<readonly ConnectedProviderIdentity[]>;
  claimLegacyConnections(applicationId: string): Promise<boolean>;
  requireCompatibleConnections(transaction: QueryHandle, applicationId: string): Promise<void>;
}

/** Provider-owned queries with shared ownership/compatibility semantics. */
export function createConnectionInventory(
  database: DatabaseRuntime,
  specification: {
    table: string;
    identityQuery: string;
    actionNeeded(row: ConnectionIdentityRow): boolean;
  },
): ProviderConnectionInventory {
  return {
    async connectionSlugs(transaction, organizationId) {
      const result = await transaction.query<{ slug: string }>(
        `select slug from ${specification.table} where organization_id = $1`,
        [organizationId],
      );
      return result.rows.map((row) => row.slug);
    },
    async connectedIdentities() {
      const result = await database.query<ConnectionIdentityRow>(specification.identityQuery);
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        applicationId: row.application_id,
        status: specification.actionNeeded(row) ? "actionNeeded" : "connected",
      }));
    },
    claimLegacyConnections(applicationId) {
      return database.transaction(async (transaction) => {
        await transaction.query(
          `update ${specification.table} set provider_application_id = $1 where provider_application_id is null`,
          [applicationId],
        );
        const result = await transaction.query<{ owned: boolean }>(
          `select exists (select 1 from ${specification.table}) and not exists (select 1 from ${specification.table} where provider_application_id is null or provider_application_id <> $1) as owned`,
          [applicationId],
        );
        return result.rows[0]?.owned === true;
      });
    },
    async requireCompatibleConnections(transaction, applicationId) {
      const result = await transaction.query<{ conflict: boolean }>(
        `select exists (select 1 from ${specification.table} where provider_application_id is null or provider_application_id <> $1) as conflict`,
        [applicationId],
      );
      if (result.rows[0]?.conflict === true) {
        const error = new Error("provider application identity conflicts with active connections");
        error.name = "ProviderApplicationIdentityConflictError";
        throw error;
      }
    },
  };
}
