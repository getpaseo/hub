import type { DatabaseRuntime } from "../../db/runtime/index.js";
import type { Locks } from "../../db/runtime/locks/index.js";
import type { ProviderApplicationStore } from "../../provider-applications/index.js";
import {
  type ProviderConfigurationRow,
  ProviderConfigurationConflictError,
  lockProviderActivation,
  parseRow,
  writeProviderActivation,
} from "../../provider-applications/storage.js";
import type { ProviderRegistry } from "../registry.js";
import { connectionInventory } from "./application-persistence.js";
export function completeSocketApplication(
  database: DatabaseRuntime,
  locks: Locks,
  registry: ProviderRegistry,
  input: Parameters<ProviderApplicationStore["completeSlackSocketApplication"]>[0],
) {
  return locks.withLock("provider-configuration:slack", () =>
    database.transaction(async (transaction) => {
      await lockProviderActivation(locks, transaction, "slack");
      await connectionInventory(database).requireCompatibleConnections(
        transaction,
        input.identity.id,
      );
      await locks.withTxLock(transaction, JSON.stringify(["slack", input.installation.teamId]));
      const existingConfiguration = await transaction.query<{ version: number }>(
        `select version from runtime_provider_configuration where provider = 'slack' for update`,
      );
      const currentVersion = existingConfiguration.rows[0]?.version;
      if (currentVersion !== input.expectedVersion) {
        throw new ProviderConfigurationConflictError();
      }
      const existingConnection = await transaction.query<{ organization_id: string }>(
        `select organization_id from slack_connections where team_id = $1 for update`,
        [input.installation.teamId],
      );
      if (
        existingConnection.rows[0] !== undefined &&
        existingConnection.rows[0].organization_id !== input.organizationId
      ) {
        const error = new Error("Slack workspace belongs to another organization");
        error.name = "ProviderApplicationIdentityConflictError";
        throw error;
      }
      await transaction.query(
        `insert into slack_connections (organization_id, team_id, team_name, slug, bot_user_id,
               bot_access_token, scopes, provider_application_id, connected_by_user_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (team_id) do update set
               team_name = excluded.team_name, bot_user_id = excluded.bot_user_id,
               bot_access_token = excluded.bot_access_token, scopes = excluded.scopes,
               provider_application_id = excluded.provider_application_id,
               connected_by_user_id = excluded.connected_by_user_id, updated_at = now()`,
        [
          input.organizationId,
          input.installation.teamId,
          input.installation.teamName,
          `slack-${input.installation.teamId.toLowerCase()}`,
          input.installation.botUserId,
          input.installation.botAccessToken,
          JSON.stringify(input.installation.scopes),
          input.identity.id,
          input.updatedByUserId,
        ],
      );
      const saved = await transaction.query<ProviderConfigurationRow>(
        currentVersion === undefined
          ? `insert into runtime_provider_configuration (provider, configuration,
                   verified_external_identity, version, verified_at, updated_at, updated_by_user_id)
                 values ('slack', $1, $2, 1, now(), now(), $3)
                 returning provider, configuration, verified_external_identity, version, verified_at,
                           updated_at, updated_by_user_id`
          : `update runtime_provider_configuration set configuration = $1,
                   verified_external_identity = $2, version = version + 1, verified_at = now(),
                   updated_at = now(), updated_by_user_id = $3
                 where provider = 'slack'
                 returning provider, configuration, verified_external_identity, version, verified_at,
                           updated_at, updated_by_user_id`,
        [
          JSON.stringify(input.configuration),
          JSON.stringify(input.identity),
          input.updatedByUserId,
        ],
      );
      const row = saved.rows[0];
      if (row === undefined) throw new Error("Slack Socket Mode save returned no row");
      const parsed = parseRow(row, registry);
      await writeProviderActivation(transaction, "slack", input.identity.id, parsed.version);
      return parsed;
    }),
  );
}
