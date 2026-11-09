import type { DatabaseRuntime } from "../../db/runtime/index.js";
import {
  createConnectionInventory,
  type ConnectionIdentityRow,
} from "../../provider-applications/connection-persistence.js";
import { linearConnectionRequiresReauthorization } from "./client.js";
function linearConnectionActionNeeded(row: ConnectionIdentityRow): boolean {
  if (!isStringArray(row.scopes)) return true;
  const refreshToken = row.refresh_token;
  if (refreshToken !== null && typeof refreshToken !== "string") return true;
  const accessTokenExpiresAt = optionalDate(row.access_token_expires_at);
  if (accessTokenExpiresAt === undefined) return true;
  return linearConnectionRequiresReauthorization({
    scopes: row.scopes,
    refreshToken,
    accessTokenExpiresAt,
  });
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function optionalDate(value: unknown): Date | null | undefined {
  if (value === null) return null;
  if (!(value instanceof Date) && typeof value !== "string") return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
export function connectionInventory(database: DatabaseRuntime) {
  return createConnectionInventory(database, {
    table: "linear_connections",
    identityQuery: `select id::text as id, linear_organization_name as name,
                   provider_application_id as application_id,
                   false as action_needed, scopes, refresh_token, access_token_expires_at
            from linear_connections order by connected_at`,
    actionNeeded: (row) => row.action_needed || linearConnectionActionNeeded(row),
  });
}
