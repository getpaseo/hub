import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { DrizzleHandle } from "./runtime/index.js";
import * as schema from "./schema.js";

// worst case subscribe (paging hooks, one create, a round of deletes) is about 120s,
// three minutes covers that with room; a dead holder just blocks hook actions until then
export const FORGEJO_HOOK_LEASE_MS = 3 * 60_000;

// a lease row, not an advisory lock: both subscribe and disconnect talk to the forgejo
// instance while serialized, and a lock would pin a pooled connection for all of it
export class ForgejoHookLeaseRepository {
  constructor(private readonly database: DrizzleHandle) {}

  async claim(connectionId: string, organizationId: string): Promise<string | undefined> {
    const leaseId = randomUUID();
    const [row] = await this.database
      .update(schema.forgejoConnections)
      .set({
        hookLeaseId: leaseId,
        hookLeaseExpiresAt: sql`now() + make_interval(secs => ${FORGEJO_HOOK_LEASE_MS / 1000})`,
      })
      .where(
        and(
          eq(schema.forgejoConnections.id, connectionId),
          eq(schema.forgejoConnections.organizationId, organizationId),
          or(
            isNull(schema.forgejoConnections.hookLeaseExpiresAt),
            lte(schema.forgejoConnections.hookLeaseExpiresAt, sql`now()`),
          ),
        ),
      )
      .returning({ id: schema.forgejoConnections.id });
    return row === undefined ? undefined : leaseId;
  }

  async release(connectionId: string, leaseId: string): Promise<void> {
    await this.database
      .update(schema.forgejoConnections)
      .set({ hookLeaseId: null, hookLeaseExpiresAt: null })
      .where(
        and(
          eq(schema.forgejoConnections.id, connectionId),
          eq(schema.forgejoConnections.hookLeaseId, leaseId),
        ),
      );
  }
}
