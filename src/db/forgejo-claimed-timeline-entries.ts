import { sql } from "drizzle-orm";
import { logger } from "../logger.js";
import type { DrizzleHandle } from "./runtime/index.js";
import * as schema from "./schema.js";

// shared clock with the memory store's own prune, see memory.ts
export const FORGEJO_CLAIMED_TIMELINE_ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// claim runs on every enrichable delivery; throttle the table-wide DELETE so it's a
// periodic sweep, not once per webhook. shared with the memory store's own throttle.
export const FORGEJO_CLAIMED_TIMELINE_ENTRY_PRUNE_THROTTLE_MS = 5 * 60_000;

// which issue-timeline entries a label_updated/assigned delivery already turned into a
// semantic event. forgejo fires one webhook per changed label or assignee, so two
// deliveries can read the timeline after both changes landed and try to derive the same
// add. claiming makes that exactly-once: only the insert that wins an entry id gets to
// use it. the row also records which receipt won, so a later claim under the SAME
// receiptId (a stale-marker takeover, see trigger-acceptance.ts's replayProviderReceipt)
// reclaims its own entries instead of losing them, while a different receipt still loses.
export class ForgejoClaimedTimelineEntryRepository {
  private lastPrunedAt = 0;

  constructor(private readonly database: DrizzleHandle) {}

  /** Returns the subset of `timelineEntryIds` this call won. */
  async claim(
    connectionId: string,
    timelineEntryIds: readonly number[],
    receiptId: string,
  ): Promise<Set<number>> {
    // postgres errors if the same conflict target appears twice in one multi-row insert
    const uniqueIds = Array.from(new Set(timelineEntryIds));
    if (uniqueIds.length === 0) return new Set();
    const won = await this.database
      .insert(schema.forgejoClaimedTimelineEntries)
      .values(uniqueIds.map((timelineEntryId) => ({ connectionId, timelineEntryId, receiptId })))
      .onConflictDoUpdate({
        target: [
          schema.forgejoClaimedTimelineEntries.connectionId,
          schema.forgejoClaimedTimelineEntries.timelineEntryId,
        ],
        // no-op write, gated by setWhere so it only fires for the same-receipt reclaim case
        set: { receiptId: sql`excluded.receipt_id` },
        setWhere: sql`${schema.forgejoClaimedTimelineEntries.receiptId} = excluded.receipt_id`,
      })
      .returning({ timelineEntryId: schema.forgejoClaimedTimelineEntries.timelineEntryId });
    // fire and forget: awaiting this would spend the enrichment deadline on unrelated housekeeping
    void this.pruneThrottled();
    return new Set(won.map((row) => row.timelineEntryId));
  }

  private pruneThrottled(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPrunedAt < FORGEJO_CLAIMED_TIMELINE_ENTRY_PRUNE_THROTTLE_MS) {
      return Promise.resolve();
    }
    this.lastPrunedAt = now;
    return this.prune();
  }

  private async prune(): Promise<void> {
    try {
      await this.database.delete(schema.forgejoClaimedTimelineEntries).where(
        sql`${schema.forgejoClaimedTimelineEntries.claimedAt} <
            now() - make_interval(secs => ${FORGEJO_CLAIMED_TIMELINE_ENTRY_TTL_MS / 1000})`,
      );
    } catch (error) {
      logger.warn({ err: error }, "forgejo claimed timeline entry prune failed, continuing");
    }
  }
}
