import type { DatabaseRuntime, QueryRow } from "../../db/runtime/index.js";
import type { Provider, ProviderApplicationInventory } from "../index.js";

interface ConnectionIdentityRow extends QueryRow {
  id: string;
  name: string;
  action_needed: boolean;
}

/** @package */
export function createProviderApplicationInventory(
  database: DatabaseRuntime,
): ProviderApplicationInventory & { organizationSlug(id: string): Promise<string | undefined> } {
  return {
    async connectedIdentities(provider) {
      const result = await database.query<ConnectionIdentityRow>(connectionIdentityQuery(provider));
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.action_needed ? "actionNeeded" : "connected",
      }));
    },
    async lastEventAt(provider) {
      if (provider === "discord") return null;
      const result = await database.query<{ received_at: Date | string | null }>(
        `select max(received_at) as received_at
         from provider_event_receipts
         where provider = $1 and signature_hash is not null`,
        [provider],
      );
      const value = result.rows[0]?.received_at;
      return value === null || value === undefined ? null : new Date(value);
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

function connectionIdentityQuery(provider: Provider): string {
  if (provider === "github") {
    return `select id::text as id, account_login as name, status = 'suspended' as action_needed
            from github_connections order by connected_at`;
  }
  if (provider === "slack") {
    return `select id::text as id, team_name as name, false as action_needed
            from slack_connections order by connected_at`;
  }
  return `select id::text as id, guild_name as name, false as action_needed
          from discord_connections order by connected_at`;
}
