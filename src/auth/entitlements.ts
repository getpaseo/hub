import { createPostgresPool } from "../db/pg.js";
import type { Database } from "../db/types.js";
import { EntitlementsService } from "../entitlements/service.js";
import { countOrganizationSeatUsage } from "./organization-access.js";

export interface ComposedEntitlements {
  service: EntitlementsService;
  /** The organization's live seat count (members + pending invitations). Shared with billing's
   * post-paid seat reporter so both read the same pool-backed count. */
  seatUsage: (organizationId: string) => Promise<number>;
  close(): Promise<void>;
}

/**
 * The composition root's single owner of the core `EntitlementsService`. It exists whenever a
 * database does, independent of browser auth — the workflow engine meters executions even on
 * instances that run without auth, so entitlements can never be owned by the optional auth
 * server. Auth, the dashboard, and the workflow engine are all injected this one instance.
 *
 * The `seats` counter reads better-auth `member`/`invitation` tables, so it needs a pool rather
 * than the `Database` interface (the in-memory database does not model them). This owns that
 * pool and closes it. The count runs on its own pooled connection; the invite flow's advisory
 * lock is what serializes concurrent invites, so a cross-connection count still sees a
 * consistent seat total.
 */
export function composeEntitlements(database: Database, databaseUrl: string): ComposedEntitlements {
  const pool = createPostgresPool(databaseUrl);
  const seatUsage = (organizationId: string) => countOrganizationSeatUsage(pool, organizationId);
  const service = new EntitlementsService(database, { seats: seatUsage });
  return { service, seatUsage, close: () => pool.end() };
}
