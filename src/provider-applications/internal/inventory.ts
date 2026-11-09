import type { DatabaseRuntime } from "../../db/runtime/index.js";
import type { ProviderApplicationInventory } from "../index.js";

/** @package */
export function createProviderApplicationInventory(
  database: DatabaseRuntime,
  registry: import("../../providers/registry.js").ProviderRegistry,
): ProviderApplicationInventory & { organizationSlug(id: string): Promise<string | undefined> } {
  return {
    async connectedIdentities(provider) {
      return registry.require(provider).application.persistence(database).connectedIdentities();
    },
    async lastEventAt(provider, identity, configurationVersion) {
      if (!registry.require(provider).application.receivesEvents) return null;
      const result = await database.query<{ received_at: Date | string | null }>(
        `select max(received_at) as received_at
         from provider_event_receipts
         where provider = $1 and signature_hash is not null
           and provider_application_id = $2
           and provider_configuration_version = $3`,
        [provider, identity.id, configurationVersion],
      );
      const value = result.rows[0]?.received_at;
      return value === null || value === undefined ? null : new Date(value);
    },
    async claimLegacyConnections(provider, identity) {
      return registry
        .require(provider)
        .application.persistence(database)
        .claimLegacyConnections(identity.id);
    },
    async organizationSlug(id) {
      const result = await database.query<{ slug: string }>(
        `select slug from organization where id = $1`,
        [id],
      );
      return result.rows[0]?.slug;
    },
  };
}
