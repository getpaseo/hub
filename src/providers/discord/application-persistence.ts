import type { DatabaseRuntime } from "../../db/runtime/index.js";
import { createConnectionInventory } from "../../provider-applications/connection-persistence.js";
export function connectionInventory(database: DatabaseRuntime) {
  return createConnectionInventory(database, {
    table: "discord_connections",
    identityQuery: `select id::text as id, guild_name as name,
                 provider_application_id as application_id,
                 false as action_needed, null::jsonb as scopes
          from discord_connections order by connected_at`,
    actionNeeded: (row) => row.action_needed,
  });
}
