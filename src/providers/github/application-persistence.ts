import type { DatabaseRuntime } from "../../db/runtime/index.js";
import { createConnectionInventory } from "../../provider-applications/connection-persistence.js";
export function connectionInventory(database: DatabaseRuntime) {
  return createConnectionInventory(database, {
    table: "github_connections",
    identityQuery: `select id::text as id, account_login as name,
                   provider_application_id as application_id,
                   status = 'suspended' as action_needed, null::jsonb as scopes
            from github_connections order by connected_at`,
    actionNeeded: (row) => row.action_needed,
  });
}
