import type { DatabaseRuntime } from "../../db/runtime/index.js";
import { createConnectionInventory } from "../../provider-applications/connection-persistence.js";
import { hasRequiredSlackScopes } from "./client.js";
export function connectionInventory(database: DatabaseRuntime) {
  return createConnectionInventory(database, {
    table: "slack_connections",
    identityQuery: `select id::text as id, team_name as name,
                   provider_application_id as application_id,
                   false as action_needed, scopes
            from slack_connections order by connected_at`,
    actionNeeded: (row) =>
      row.action_needed || !Array.isArray(row.scopes) || !hasRequiredSlackScopes(row.scopes),
  });
}
