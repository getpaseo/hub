import type { DatabaseRuntime } from "../../db/runtime/index.js";
import type { Locks } from "../../db/runtime/locks/index.js";
import type { Database } from "../../db/types.js";
import { linearPersistence } from "../../providers/linear/persistence.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import { slackPersistence } from "../../providers/slack/persistence.js";
import { completeSocketApplication } from "../../providers/slack/socket-persistence.js";
import type { ProviderApplicationConfiguration, ProviderApplicationStore } from "../index.js";
import {
  type ProviderConfigurationRow,
  ProviderConfigurationConflictError,
  lockProviderActivation,
  parseRow,
  writeProviderActivation,
} from "../storage.js";
export { ProviderConfigurationConflictError } from "../storage.js";

/** @package */
export function parseProviderApplicationConfiguration(
  value: unknown,
  registry: ProviderRegistry,
): ProviderApplicationConfiguration {
  return registry.parseConfiguration(value);
}
/** @package */
export function createProviderApplicationStore(
  database: DatabaseRuntime,
  locks: Locks,
  registry: ProviderRegistry,
  providerDatabase?: Pick<Database, "providerPersistence">,
): ProviderApplicationStore {
  return {
    async read(provider) {
      const result = await database.query<ProviderConfigurationRow>(
        `select provider, configuration, verified_external_identity, version,
                verified_at, updated_at, updated_by_user_id
         from runtime_provider_configuration where provider = $1`,
        [provider],
      );
      return result.rows[0] === undefined ? undefined : parseRow(result.rows[0], registry);
    },
    async readAll() {
      const result = await database.query<ProviderConfigurationRow>(
        `select provider, configuration, verified_external_identity, version,
                verified_at, updated_at, updated_by_user_id
         from runtime_provider_configuration order by provider`,
      );
      return result.rows.map((row) => parseRow(row, registry));
    },
    save(input) {
      return locks.withLock(`provider-configuration:${input.provider}`, () =>
        database.transaction(async (transaction) => {
          await lockProviderActivation(locks, transaction, input.provider);
          await registry
            .require(input.provider)
            .application.persistence(database)
            .requireCompatibleConnections(transaction, input.identity.id);
          const existing = await transaction.query<{ version: number }>(
            `select version from runtime_provider_configuration where provider = $1 for update`,
            [input.provider],
          );
          const currentVersion = existing.rows[0]?.version;
          if (currentVersion !== input.expectedVersion) {
            throw new ProviderConfigurationConflictError();
          }
          const result = await transaction.query<ProviderConfigurationRow>(
            currentVersion === undefined
              ? `insert into runtime_provider_configuration
                 (provider, configuration, verified_external_identity, version, verified_at,
                  updated_at, updated_by_user_id)
               values ($1, $2, $3, 1, now(), now(), $4)
               returning provider, configuration, verified_external_identity, version,
                         verified_at, updated_at, updated_by_user_id`
              : `update runtime_provider_configuration
               set configuration = $2,
                   verified_external_identity = $3,
                   version = version + 1,
                   verified_at = now(),
                   updated_at = now(),
                   updated_by_user_id = $4
               where provider = $1
               returning provider, configuration, verified_external_identity, version,
                         verified_at, updated_at, updated_by_user_id`,
            [
              input.provider,
              JSON.stringify(input.configuration),
              JSON.stringify(input.identity),
              input.updatedByUserId,
            ],
          );
          const saved = result.rows[0];
          if (saved === undefined) throw new Error("provider configuration save returned no row");
          const parsed = parseRow(saved, registry);
          await writeProviderActivation(
            transaction,
            input.provider,
            input.identity.id,
            parsed.version,
          );
          return parsed;
        }),
      );
    },
    activate(input) {
      return locks.withLock(`provider-configuration:${input.provider}`, () =>
        database.transaction(async (transaction) => {
          await lockProviderActivation(locks, transaction, input.provider);
          await registry
            .require(input.provider)
            .application.persistence(database)
            .requireCompatibleConnections(transaction, input.identity.id);
          await writeProviderActivation(
            transaction,
            input.provider,
            input.identity.id,
            input.configurationVersion,
          );
        }),
      );
    },
    completeSlackInstallation(input) {
      if (providerDatabase === undefined)
        throw new Error("Slack application persistence unavailable");
      return slackPersistence(providerDatabase).completeSlackProviderApplication({
        ...input.binding,
        providerConfiguration: {
          configuration: input.configuration,
          identity: input.identity,
          expectedVersion: input.expectedVersion,
          updatedByUserId: input.updatedByUserId,
        },
      });
    },
    completeLinearInstallation(input) {
      if (providerDatabase === undefined)
        throw new Error("Linear application persistence unavailable");
      return linearPersistence(providerDatabase).completeLinearProviderApplication({
        ...input.binding,
        providerConfiguration: {
          configuration: input.configuration,
          identity: input.identity,
          expectedVersion: input.expectedVersion,
          updatedByUserId: input.updatedByUserId,
        },
      });
    },
    completeSlackSocketApplication(input) {
      return completeSocketApplication(database, locks, registry, input);
    },
  };
}
