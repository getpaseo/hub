import type { DatabaseRuntime, QueryRow } from "../../db/runtime/index.js";
import type { Locks } from "../../db/runtime/locks/index.js";
import type { Database } from "../../db/types.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import type {
  Provider,
  ProviderApplicationConfiguration,
  ProviderApplicationStore,
  StoredProviderApplication,
} from "../index.js";

/** @package */
export function parseProviderApplicationConfiguration(
  value: unknown,
  registry: ProviderRegistry,
): ProviderApplicationConfiguration {
  return registry.parseConfiguration(value);
}
interface ProviderConfigurationRow extends QueryRow {
  provider: string;
  configuration: unknown;
  verified_external_identity: unknown;
  version: number;
  verified_at: Date | string;
  updated_at: Date | string;
  updated_by_user_id: string | null;
}

/** @package */
export class ProviderConfigurationConflictError extends Error {
  constructor() {
    super("provider configuration changed");
    this.name = "ProviderConfigurationConflictError";
  }
}

/** @package */
export function createProviderApplicationStore(
  database: DatabaseRuntime,
  locks: Locks,
  registry: ProviderRegistry,
  connections?: Pick<
    Database,
    "completeSlackProviderApplication" | "completeLinearProviderApplication"
  >,
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
          await requireCompatibleConnections(transaction, input.provider, input.identity.id);
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
          await requireCompatibleConnections(transaction, input.provider, input.identity.id);
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
      if (connections === undefined) throw new Error("Slack application persistence unavailable");
      return connections.completeSlackProviderApplication({
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
      if (connections === undefined) throw new Error("Linear application persistence unavailable");
      return connections.completeLinearProviderApplication({
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
      return locks.withLock("provider-configuration:slack", () =>
        database.transaction(async (transaction) => {
          await lockProviderActivation(locks, transaction, "slack");
          await requireCompatibleConnections(transaction, "slack", input.identity.id);
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
    },
  };
}

async function lockProviderActivation(
  locks: Locks,
  transaction: Parameters<Locks["withTxLock"]>[0],
  provider: Provider,
): Promise<void> {
  await locks.withTxLock(transaction, JSON.stringify(["provider-application", provider]));
}

async function requireCompatibleConnections(
  transaction: Parameters<Locks["withTxLock"]>[0],
  provider: Provider,
  applicationId: string,
): Promise<void> {
  const table = connectionTable(provider);
  const conflicts = await transaction.query<{ conflict: boolean }>(
    `select exists (
       select 1 from ${table}
       where provider_application_id is null or provider_application_id <> $1
     ) as conflict`,
    [applicationId],
  );
  if (conflicts.rows[0]?.conflict === true) {
    const error = new Error("provider application identity conflicts with active connections");
    error.name = "ProviderApplicationIdentityConflictError";
    throw error;
  }
}

async function writeProviderActivation(
  transaction: Parameters<Locks["withTxLock"]>[0],
  provider: Provider,
  applicationId: string,
  configurationVersion: number,
): Promise<void> {
  await transaction.query(
    `insert into runtime_provider_activation
       (provider, provider_application_id, configuration_version, activated_at)
     values ($1, $2, $3, now())
     on conflict (provider) do update
       set provider_application_id = excluded.provider_application_id,
           configuration_version = excluded.configuration_version,
           activated_at = excluded.activated_at`,
    [provider, applicationId, configurationVersion],
  );
}

function connectionTable(provider: Provider): string {
  if (provider === "github") return "github_connections";
  if (provider === "slack") return "slack_connections";
  if (provider === "linear") return "linear_connections";
  return "discord_connections";
}

function parseRow(
  row: ProviderConfigurationRow,
  registry: ProviderRegistry,
): StoredProviderApplication {
  const provider = row.provider;
  const module = registry.require(provider);
  const configuration = parseProviderApplicationConfiguration(row.configuration, registry);
  const identity = module.application.parseIdentity(row.verified_external_identity);
  if (configuration.provider !== provider || identity.provider !== provider) {
    throw new Error("stored provider configuration has inconsistent provider identity");
  }
  return {
    provider,
    configuration,
    identity: identity,
    version: row.version,
    verifiedAt: new Date(row.verified_at),
    updatedAt: new Date(row.updated_at),
    updatedByUserId: row.updated_by_user_id,
  };
}
