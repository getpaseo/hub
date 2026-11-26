/**
 * Inbound events: a verified provider delivery, held between the response to the provider and the
 * Postgres work that accepts it. Sources verify and enqueue, then answer the provider; a named
 * processor accepts the receipt and dispatches once Postgres answers. Delivery is at least once,
 * so processors must be idempotent.
 *
 * The queue is a serialization boundary. An event is stored as JSON text and every attempt gets
 * a fresh copy, which is what a shared store such as Redis would hold. Anything that is not plain
 * JSON is refused at `enqueue`.
 */
export interface InboundEvent {
  /** The processor that handles the event, such as `github.webhook`. */
  kind: string;
  /** Unique per provider delivery, such as `github:<X-GitHub-Delivery>`. */
  id: string;
  /** ISO-8601, captured when the delivery was verified. */
  receivedAt: string;
  /** Plain JSON. Processors read it as untrusted and parse it. */
  payload: unknown;
}

export type EnqueueResult =
  /** Held until a processor handles it. */
  | { status: "queued" }
  /** An event with the same id is already queued, waiting to retry, or being processed. */
  | { status: "duplicate" }
  /** The item or byte limit is reached. */
  | { status: "full" }
  /** Shutdown has begun. */
  | { status: "stopped" };

/** Resolves once the event is handled, including a deliberate drop. Throws to be tried again. */
export type InboundProcessor = (event: InboundEvent) => Promise<void>;

export type InboundProcessors = Readonly<Record<string, InboundProcessor>>;

/** What a source holds: the one call that hands a verified delivery over. */
export interface InboundSink {
  enqueue(event: InboundEvent): Promise<EnqueueResult>;
}

export interface InboundQueue extends InboundSink {
  /** Begins processing. Every kind enqueued from now on must have a processor. */
  start(processors: InboundProcessors): void;
  /**
   * Refuses new events, then processes what is held until it is empty or the deadline passes.
   * Lists the events left unprocessed, which are also logged so they can be redelivered.
   */
  stop(options: { deadlineMs: number }): Promise<{ unprocessed: readonly InboundEventId[] }>;
  stats(): InboundQueueStats;
  /** Resolves when nothing is queued, waiting to retry, or being processed. */
  idle(): Promise<void>;
}

export type InboundEventId = Pick<InboundEvent, "kind" | "id">;

export interface InboundQueueStats {
  queued: number;
  inFlight: number;
  retrying: number;
  bytes: number;
  oldestAgeMs: number | null;
  totals: { processed: number; retried: number; abandoned: number; rejectedFull: number };
}

export {
  createMemoryInboundQueue,
  type MemoryInboundQueueOptions,
} from "./internal/memory-queue.js";
