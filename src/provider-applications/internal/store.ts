import { z } from "zod";
import type { DatabaseRuntime, QueryRow } from "../../db/runtime/index.js";
import type { Locks } from "../../db/runtime/locks/index.js";
import type {
  Provider,
  ProviderApplicationConfiguration,
  ProviderApplicationIdentity,
  ProviderApplicationStore,
  StoredProviderApplication,
} from "../index.js";

const githubConfigurationSchema = z.object({
  provider: z.literal("github"),
  appId: z.string().min(1),
  appSlug: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  privateKey: z.string().min(1),
  webhookSecret: z.string().min(1),
});
const slackConfigurationSchema = z.object({
  provider: z.literal("slack"),
  appId: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  signingSecret: z.string().min(1),
});
const discordConfigurationSchema = z.object({
  provider: z.literal("discord"),
  applicationId: z.string().min(1),
  clientSecret: z.string().min(1),
  botToken: z.string().min(1),
});
const configurationSchema = z.discriminatedUnion("provider", [
  githubConfigurationSchema,
  slackConfigurationSchema,
  discordConfigurationSchema,
]);

/** @package */
export function parseProviderApplicationConfiguration(
  value: unknown,
): ProviderApplicationConfiguration {
  return configurationSchema.parse(value) as ProviderApplicationConfiguration;
}
const identitySchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("github"),
    id: z.string().min(1),
    name: z.string().min(1),
    ownerLogin: z.string().min(1),
  }),
  z.object({ provider: z.literal("slack"), id: z.string().min(1), name: z.string().min(1) }),
  z.object({ provider: z.literal("discord"), id: z.string().min(1), name: z.string().min(1) }),
]);

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
): ProviderApplicationStore {
  return {
    async read(provider) {
      const result = await database.query<ProviderConfigurationRow>(
        `select provider, configuration, verified_external_identity, version,
                verified_at, updated_at, updated_by_user_id
         from runtime_provider_configuration where provider = $1`,
        [provider],
      );
      return result.rows[0] === undefined ? undefined : parseRow(result.rows[0]);
    },
    async readAll() {
      const result = await database.query<ProviderConfigurationRow>(
        `select provider, configuration, verified_external_identity, version,
                verified_at, updated_at, updated_by_user_id
         from runtime_provider_configuration order by provider`,
      );
      return result.rows.map(parseRow);
    },
    save(input) {
      return locks.withLock(`provider-configuration:${input.provider}`, () =>
        database.transaction(async (transaction) => {
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
          return parseRow(saved);
        }),
      );
    },
  };
}

function parseRow(row: ProviderConfigurationRow): StoredProviderApplication {
  const provider = providerSchema(row.provider);
  const configuration = parseProviderApplicationConfiguration(row.configuration);
  const identity = identitySchema.parse(row.verified_external_identity);
  if (configuration.provider !== provider || identity.provider !== provider) {
    throw new Error("stored provider configuration has inconsistent provider identity");
  }
  return {
    provider,
    configuration,
    identity: identity as ProviderApplicationIdentity,
    version: row.version,
    verifiedAt: new Date(row.verified_at),
    updatedAt: new Date(row.updated_at),
    updatedByUserId: row.updated_by_user_id,
  };
}

function providerSchema(value: string): Provider {
  if (value === "github" || value === "slack" || value === "discord") return value;
  throw new Error("stored provider configuration has invalid provider");
}
