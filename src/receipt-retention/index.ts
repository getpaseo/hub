import type { QueryHandle } from "../db/runtime/index.js";
import { reportFailure } from "../failures/index.js";
import { logger } from "../logger.js";

const RETENTION_MS = 7 * 24 * 60 * 60_000;
const BATCH_SIZE = 500;
const BATCH_DELAY_MS = 250;
const SWEEP_DELAY_MS = 60 * 60_000;
const RETRY_DELAY_MS = 60_000;

/** Owns automatic expiry of finalized, unrouted receipts and its bounded database sweep. */
export class ReceiptRetention {
  private cursor: string | null = null;
  private cutoff: Date | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private stopped = true;

  constructor(private readonly database: QueryHandle) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }

  /** One bounded step; retained rows also advance the cursor so they cannot stall a sweep. */
  async runBatch(now = new Date()) {
    this.cutoff ??= new Date(now.getTime() - RETENTION_MS);
    const result = await this.database.query<{
      scanned: number;
      deleted: number;
      cursor: string | null;
    }>(
      `with candidates as materialized (
         select id from provider_event_receipts
         where id > coalesce($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
         order by id limit $3
       ), deleted as (
         delete from provider_event_receipts receipts
         using candidates
         where receipts.id = candidates.id
           and receipts.received_at < $2
           and receipts.dropped_reason is not null
           and (receipts.accepted_routes is null or receipts.accepted_routes = '[]'::jsonb)
           and not exists (
             select 1 from trigger_runs runs where runs.provider_event_receipt_id = receipts.id
           )
           and not exists (
             select 1 from attachment_capabilities attachments
             where attachments.provider_event_receipt_id = receipts.id
           )
         returning receipts.id
       )
       select (select count(*)::int from candidates) as scanned,
              (select count(*)::int from deleted) as deleted,
              (select id from candidates order by id desc limit 1) as cursor`,
      [this.cursor, this.cutoff, BATCH_SIZE],
    );
    const batch = result.rows[0]!;
    const complete = batch.scanned < BATCH_SIZE;
    this.cursor = complete ? null : batch.cursor;
    if (complete) this.cutoff = undefined;
    return { scanned: batch.scanned, deleted: batch.deleted, complete };
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.active = this.tick();
    }, delay);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    let delay = RETRY_DELAY_MS;
    try {
      const startedAt = Date.now();
      const batch = await this.runBatch();
      if (batch.deleted > 0 || batch.complete) {
        logger.info(
          { operation: "receipt_retention.cleanup", ...batch, durationMs: Date.now() - startedAt },
          "receipt retention cleanup",
        );
      }
      delay = batch.complete ? SWEEP_DELAY_MS : BATCH_DELAY_MS;
    } catch (error) {
      reportFailure(error, {
        operation: "receipt_retention.cleanup",
        component: "receipt_retention",
      });
    }
    this.schedule(delay);
  }
}
