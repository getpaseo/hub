import type { Logger } from "pino";
import { logger as defaultLogger } from "../../logger.js";
import type {
  EnqueueResult,
  InboundEvent,
  InboundEventId,
  InboundProcessors,
  InboundQueue,
  InboundQueueStats,
} from "../index.js";

export interface MemoryInboundQueueOptions {
  /** Default 5,000. */
  maxItems?: number;
  /** Default 64 MiB. Webhook bodies are capped at 1 MiB and the VM has 512 MB. */
  maxBytes?: number;
  /** Default 4, leaving most of the 10-connection pool to the dashboard and the workflow engine. */
  concurrency?: number;
  retry?: {
    /** Default 500 ms. */
    initialMs?: number;
    /** Default 30 s. */
    maxMs?: number;
    /** Default 1 hour, counted from `receivedAt`. An event still failing then is abandoned. */
    maxAgeMs?: number;
  };
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

interface HeldEvent {
  kind: string;
  id: string;
  receivedAt: string;
  receivedAtMs: number;
  /** The payload as JSON text. Every attempt parses a fresh copy. */
  payload: string;
  bytes: number;
  attempts: number;
  retryTimer: NodeJS.Timeout | undefined;
}

type State = "created" | "running" | "stopping" | "stopped";

export function createMemoryInboundQueue(options: MemoryInboundQueueOptions = {}): InboundQueue {
  return new MemoryInboundQueue(options);
}

/**
 * Holds events in process memory, so they last as long as the process. Events start in arrival
 * order, `concurrency` at a time. A failed event gives up its slot while it waits to retry, so
 * one that keeps failing never holds up the others.
 */
class MemoryInboundQueue implements InboundQueue {
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly concurrency: number;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAgeMs: number;
  private readonly log: Pick<Logger, "info" | "warn" | "error">;

  /** Every event the queue holds, by id, whatever its state. */
  private readonly held = new Map<string, HeldEvent>();
  private readonly ready: HeldEvent[] = [];
  private readonly retrying = new Set<HeldEvent>();
  private readonly inFlight = new Set<HeldEvent>();
  private bytes = 0;
  private processors: InboundProcessors | undefined;
  private state: State = "created";
  private idleWaiters: (() => void)[] = [];
  /** Set from the first retry until the queue is empty again. */
  private backlog: { since: number; processed: number } | undefined;
  private stopping: ReturnType<InboundQueue["stop"]> | undefined;
  private readonly totals = { processed: 0, retried: 0, abandoned: 0, rejectedFull: 0 };

  constructor(options: MemoryInboundQueueOptions) {
    this.maxItems = options.maxItems ?? 5_000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.concurrency = options.concurrency ?? 4;
    this.retryInitialMs = options.retry?.initialMs ?? 500;
    this.retryMaxMs = options.retry?.maxMs ?? 30_000;
    this.maxAgeMs = options.retry?.maxAgeMs ?? 60 * 60_000;
    this.log = options.logger ?? defaultLogger;
  }

  async enqueue(event: InboundEvent): Promise<EnqueueResult> {
    if (this.state === "stopping" || this.state === "stopped") return { status: "stopped" };
    if (this.processors !== undefined && !Object.hasOwn(this.processors, event.kind)) {
      throw new Error(`no inbound processor is registered for ${event.kind}`);
    }
    const receivedAtMs = Date.parse(event.receivedAt);
    if (Number.isNaN(receivedAtMs)) throw new TypeError("inbound event receivedAt is not a date");
    assertJson(event.payload, "payload");
    const payload = JSON.stringify(event.payload);
    if (this.held.has(event.id)) return { status: "duplicate" };
    const bytes =
      Buffer.byteLength(payload) + Buffer.byteLength(event.kind) + Buffer.byteLength(event.id);
    if (this.held.size >= this.maxItems || this.bytes + bytes > this.maxBytes) {
      this.totals.rejectedFull += 1;
      this.log.error(
        { kind: event.kind, id: event.id, queued: this.held.size, bytes: this.bytes },
        "inbound.rejected_full",
      );
      return { status: "full" };
    }
    const held: HeldEvent = {
      kind: event.kind,
      id: event.id,
      receivedAt: event.receivedAt,
      receivedAtMs,
      payload,
      bytes,
      attempts: 0,
      retryTimer: undefined,
    };
    this.held.set(held.id, held);
    this.bytes += bytes;
    this.ready.push(held);
    this.pump();
    return { status: "queued" };
  }

  start(processors: InboundProcessors): void {
    if (this.state !== "created") throw new Error("inbound queue has already started");
    const unknown = [...this.held.values()].find(
      (held) => !Object.hasOwn(processors, held.kind),
    )?.kind;
    if (unknown !== undefined) {
      throw new Error(`no inbound processor is registered for ${unknown}`);
    }
    this.processors = processors;
    this.state = "running";
    this.pump();
  }

  stop(options: { deadlineMs: number }): ReturnType<InboundQueue["stop"]> {
    this.stopping ??= this.drain(options.deadlineMs);
    return this.stopping;
  }

  stats(): InboundQueueStats {
    let oldest: number | undefined;
    for (const held of this.held.values()) {
      if (oldest === undefined || held.receivedAtMs < oldest) oldest = held.receivedAtMs;
    }
    return {
      queued: this.ready.length,
      inFlight: this.inFlight.size,
      retrying: this.retrying.size,
      bytes: this.bytes,
      oldestAgeMs: oldest === undefined ? null : Math.max(0, Date.now() - oldest),
      totals: { ...this.totals },
    };
  }

  idle(): Promise<void> {
    if (this.held.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(deadlineMs: number): Promise<{ unprocessed: readonly InboundEventId[] }> {
    const started = this.state === "running";
    this.state = "stopping";
    if (started) {
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([
        this.idle(),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, deadlineMs);
        }),
      ]);
      clearTimeout(deadline);
    }
    this.state = "stopped";
    for (const held of this.retrying) clearTimeout(held.retryTimer);
    const unprocessed = [...this.held.values()].map(({ kind, id }) => ({ kind, id }));
    if (unprocessed.length > 0) {
      this.log.error(
        { count: unprocessed.length, events: unprocessed },
        "inbound.unprocessed_on_shutdown",
      );
    }
    return { unprocessed };
  }

  private pump(): void {
    const processors = this.processors;
    if (processors === undefined || this.state === "stopped") return;
    while (this.inFlight.size < this.concurrency) {
      const held = this.ready.shift();
      if (held === undefined) return;
      void this.attempt(held, processors);
    }
  }

  private async attempt(held: HeldEvent, processors: InboundProcessors): Promise<void> {
    this.inFlight.add(held);
    held.attempts += 1;
    let failure: { error: unknown } | undefined;
    try {
      await processors[held.kind]!({
        kind: held.kind,
        id: held.id,
        receivedAt: held.receivedAt,
        payload: JSON.parse(held.payload) as unknown,
      });
    } catch (error) {
      failure = { error };
    }
    this.inFlight.delete(held);
    // Past the shutdown deadline the event is already listed as unprocessed.
    if (this.state === "stopped") return;
    if (failure === undefined) this.complete(held);
    else this.retry(held, failure.error);
    this.pump();
    this.settle();
  }

  private complete(held: HeldEvent): void {
    this.release(held);
    this.totals.processed += 1;
    if (this.backlog !== undefined) this.backlog.processed += 1;
  }

  private retry(held: HeldEvent, error: unknown): void {
    const ageMs = Date.now() - held.receivedAtMs;
    if (ageMs >= this.maxAgeMs) {
      this.release(held);
      this.totals.abandoned += 1;
      this.log.error(
        { err: error, kind: held.kind, id: held.id, attempts: held.attempts, ageMs },
        "inbound.abandoned",
      );
      return;
    }
    this.totals.retried += 1;
    this.backlog ??= { since: Date.now(), processed: 0 };
    if (held.attempts === 1) {
      this.log.warn(
        { err: error, kind: held.kind, id: held.id, retrying: this.retrying.size + 1 },
        "inbound.retrying",
      );
    }
    // Exponential backoff with jitter in the upper half, so no retry follows immediately.
    const ceiling = Math.min(this.retryMaxMs, this.retryInitialMs * 2 ** (held.attempts - 1));
    const delay = ceiling / 2 + (Math.random() * ceiling) / 2;
    this.retrying.add(held);
    held.retryTimer = setTimeout(() => {
      held.retryTimer = undefined;
      this.retrying.delete(held);
      this.ready.push(held);
      this.pump();
    }, delay);
    held.retryTimer.unref();
  }

  private release(held: HeldEvent): void {
    this.held.delete(held.id);
    this.bytes -= held.bytes;
  }

  private settle(): void {
    if (this.held.size > 0) return;
    if (this.backlog !== undefined) {
      this.log.info(
        { processed: this.backlog.processed, durationMs: Date.now() - this.backlog.since },
        "inbound.drained",
      );
      this.backlog = undefined;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Plain JSON only: what `JSON.stringify` would change or drop is refused instead. */
function assertJson(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`inbound event ${path} is not a finite number`);
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertJson(item, `${path}[${index}]`);
    return;
  }
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`);
      return;
    }
  }
  throw new TypeError(`inbound event ${path} is not plain JSON`);
}
