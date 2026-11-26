import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";
import { FailureLogStream } from "../test-utils/failure-logs.js";
import {
  createMemoryInboundQueue,
  type InboundEvent,
  type InboundProcessor,
  type MemoryInboundQueueOptions,
} from "./index.js";

describe("memory inbound queue", () => {
  it("hands each attempt a fresh JSON copy of the event", async () => {
    const inbox = new Inbox();
    const seen: unknown[] = [];
    inbox.start({
      "test.event": async (event) => {
        seen.push(structuredClone(event.payload));
        if (seen.length === 1) {
          // A processor that mutates its copy and fails must not change what the retry sees.
          if (typeof event.payload === "object" && event.payload !== null) {
            Object.assign(event.payload, { mutated: true });
          }
          throw new Error("first attempt fails");
        }
      },
    });
    const payload = { nested: { list: [1, "two", null, true] } };

    expect(await inbox.enqueue("delivery-1", payload)).toEqual({ status: "queued" });
    await inbox.queue.idle();

    expect(seen).toEqual([payload, payload]);
  });

  it("refuses a payload that is not plain JSON", async () => {
    const inbox = new Inbox();
    inbox.start({ "test.event": async () => {} });

    for (const payload of [
      { at: new Date() },
      { missing: undefined },
      { call: () => undefined },
      { count: Number.NaN },
      { request: new Request("https://hub.test") },
    ]) {
      await expect(inbox.enqueue("delivery", payload)).rejects.toThrow(TypeError);
    }
    expect(inbox.queue.stats()).toMatchObject({ queued: 0, inFlight: 0, retrying: 0, bytes: 0 });
  });

  it("throws for an event no processor handles", async () => {
    const inbox = new Inbox();
    inbox.start({});

    await expect(inbox.enqueue("delivery-1", {})).rejects.toThrow(/test\.event/u);
  });

  it("retries a failing event with growing backoff until it succeeds", async () => {
    const inbox = new Inbox({ retry: { initialMs: 40, maxMs: 1_000 } });
    const attempts: number[] = [];
    inbox.start({
      "test.event": async () => {
        attempts.push(performance.now());
        if (attempts.length < 3) throw new Error("database unavailable");
      },
    });

    await inbox.enqueue("delivery-1", {});
    await until(() => inbox.queue.stats().retrying === 1);
    expect(inbox.queue.stats()).toMatchObject({ retrying: 1 });
    expect(inbox.queue.stats().bytes).toBeGreaterThan(0);
    expect(inbox.queue.stats().oldestAgeMs).toBeGreaterThanOrEqual(0);
    await inbox.queue.idle();

    expect(attempts).toHaveLength(3);
    // The first wait is at least half of 40 ms, the second at least half of 80 ms.
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(19);
    expect(attempts[2]! - attempts[1]!).toBeGreaterThanOrEqual(39);
    expect(inbox.queue.stats()).toEqual({
      queued: 0,
      inFlight: 0,
      retrying: 0,
      bytes: 0,
      oldestAgeMs: null,
      totals: { processed: 1, retried: 2, abandoned: 0, rejectedFull: 0 },
    });
    expect(inbox.messages()).toEqual(["inbound.retrying", "inbound.drained"]);
  });

  it("keeps processing other events while one keeps failing, then abandons it", async () => {
    const inbox = new Inbox({ concurrency: 1, retry: { initialMs: 10, maxMs: 20, maxAgeMs: 300 } });
    const processed: string[] = [];
    inbox.start({
      "test.event": async (event) => {
        if (event.id === "poison") throw new Error("poison event");
        processed.push(event.id);
      },
    });

    await inbox.enqueue("poison", {});
    await inbox.enqueue("healthy", {});
    await until(() => processed.length === 1);
    expect(inbox.queue.stats().retrying + inbox.queue.stats().queued).toBe(1);
    await inbox.queue.idle();

    expect(processed).toEqual(["healthy"]);
    expect(inbox.queue.stats().totals).toMatchObject({ processed: 1, abandoned: 1 });
    const abandoned = inbox.record("inbound.abandoned");
    expect(abandoned).toMatchObject({ kind: "test.event", id: "poison", level: 50 });
    expect(abandoned["attempts"]).toBeGreaterThan(1);
  });

  it("reports an id it already holds as a duplicate", async () => {
    const inbox = new Inbox();
    const release = new Gate();
    inbox.start({ "test.event": () => release.wait() });

    expect(await inbox.enqueue("delivery-1", {})).toEqual({ status: "queued" });
    expect(await inbox.enqueue("delivery-1", {})).toEqual({ status: "duplicate" });
    release.open();
    await inbox.queue.idle();

    // Once processed, the receipt store owns deduplication, so the queue takes the id again.
    expect(await inbox.enqueue("delivery-1", {})).toEqual({ status: "queued" });
  });

  it("answers full at the item and byte limits", async () => {
    const byItems = new Inbox({ maxItems: 1 });
    expect(await byItems.enqueue("first", {})).toEqual({ status: "queued" });
    expect(await byItems.enqueue("second", {})).toEqual({ status: "full" });
    expect(byItems.queue.stats().totals.rejectedFull).toBe(1);
    expect(byItems.record("inbound.rejected_full")).toMatchObject({ id: "second", level: 50 });

    const byBytes = new Inbox({ maxBytes: 200 });
    expect(await byBytes.enqueue("small", { text: "x" })).toEqual({ status: "queued" });
    expect(await byBytes.enqueue("large", { text: "x".repeat(200) })).toEqual({ status: "full" });
  });

  it("processes held events before stopping and refuses new ones", async () => {
    const inbox = new Inbox({ retry: { initialMs: 20 } });
    let failures = 0;
    const processed: string[] = [];
    inbox.start({
      "test.event": async (event) => {
        if (failures++ === 0) throw new Error("database unavailable");
        processed.push(event.id);
      },
    });

    await inbox.enqueue("delivery-1", {});
    const stopped = inbox.queue.stop({ deadlineMs: 5_000 });
    expect(await inbox.enqueue("delivery-2", {})).toEqual({ status: "stopped" });

    expect(await stopped).toEqual({ unprocessed: [] });
    expect(processed).toEqual(["delivery-1"]);
  });

  it("lists and logs the events left when the shutdown deadline passes", async () => {
    const inbox = new Inbox({ retry: { initialMs: 10 } });
    inbox.start({
      "test.event": async () => {
        throw new Error("database unavailable");
      },
    });

    await inbox.enqueue("delivery-1", {});
    await inbox.enqueue("delivery-2", {});
    const { unprocessed } = await inbox.queue.stop({ deadlineMs: 100 });

    expect(unprocessed).toEqual([
      { kind: "test.event", id: "delivery-1" },
      { kind: "test.event", id: "delivery-2" },
    ]);
    expect(inbox.record("inbound.unprocessed_on_shutdown")).toMatchObject({
      count: 2,
      events: unprocessed,
      level: 50,
    });
  });
});

class Inbox {
  readonly queue;
  private readonly logs = new FailureLogStream();

  constructor(options: MemoryInboundQueueOptions = {}) {
    this.queue = createMemoryInboundQueue({ ...options, logger: createLogger(this.logs) });
  }

  start(processors: Record<string, InboundProcessor>): void {
    this.queue.start(processors);
  }

  enqueue(id: string, payload: unknown) {
    const event: InboundEvent = {
      kind: "test.event",
      id,
      receivedAt: new Date().toISOString(),
      payload,
    };
    return this.queue.enqueue(event);
  }

  messages(): unknown[] {
    return this.logs.records().map((record) => record["msg"]);
  }

  record(message: string): Record<string, unknown> {
    const record = this.logs.records().find((candidate) => candidate["msg"] === message);
    if (record === undefined) throw new Error(`no ${message} log`);
    return record;
  }
}

class Gate {
  private resolve: (() => void) | undefined;
  private readonly opened = new Promise<void>((resolve) => {
    this.resolve = resolve;
  });

  wait(): Promise<void> {
    return this.opened;
  }

  open(): void {
    this.resolve?.();
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await delay(5);
  expect(condition()).toBe(true);
}
