import { eq } from "drizzle-orm";
import type { DrizzleHandle } from "./runtime/index.js";
import * as schema from "./schema.js";
import type { ForgejoWebhookRecord, RecordForgejoWebhookInput } from "./types.js";

// record is an upsert on (connection_id, scope, owner): resubscribing after deleting the
// hook by hand on the instance lands on the same row with a new hookId instead of colliding
export class ForgejoWebhookRepository {
  constructor(private readonly database: DrizzleHandle) {}

  async record(input: RecordForgejoWebhookInput): Promise<ForgejoWebhookRecord> {
    const [row] = await this.database
      .insert(schema.forgejoWebhooks)
      .values({
        connectionId: input.connectionId,
        scope: input.scope,
        owner: input.owner,
        hookId: input.hookId,
      })
      .onConflictDoUpdate({
        target: [
          schema.forgejoWebhooks.connectionId,
          schema.forgejoWebhooks.scope,
          schema.forgejoWebhooks.owner,
        ],
        set: { hookId: input.hookId },
      })
      .returning();
    if (row === undefined) throw new Error("forgejo webhook upsert returned nothing");
    return toRecord(row);
  }

  async list(connectionId: string): Promise<ForgejoWebhookRecord[]> {
    const rows = await this.database
      .select()
      .from(schema.forgejoWebhooks)
      .where(eq(schema.forgejoWebhooks.connectionId, connectionId));
    return rows.map(toRecord);
  }
}

function toRecord(row: typeof schema.forgejoWebhooks.$inferSelect): ForgejoWebhookRecord {
  return {
    id: row.id,
    connectionId: row.connectionId,
    scope: row.scope,
    owner: row.owner,
    hookId: row.hookId,
  };
}
