import type { QueryRow } from "../db/runtime/index.js";
import type { Locks } from "../db/runtime/locks/index.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { Provider, StoredProviderApplication } from "./index.js";
export interface ProviderConfigurationRow extends QueryRow {
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

export async function lockProviderActivation(
  locks: Locks,
  transaction: Parameters<Locks["withTxLock"]>[0],
  provider: Provider,
): Promise<void> {
  await locks.withTxLock(transaction, JSON.stringify(["provider-application", provider]));
}
export async function writeProviderActivation(
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
export function parseRow(
  row: ProviderConfigurationRow,
  registry: ProviderRegistry,
): StoredProviderApplication {
  const provider = row.provider;
  const module = registry.require(provider);
  const configuration = registry.parseConfiguration(row.configuration);
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
