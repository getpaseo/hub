import type { TriggerSource } from "../index.js";
import { reportFailure } from "../../failures/index.js";
export { ScheduleRepository } from "./internal/repository.js";

export interface ScheduleStore {
  tick(now: Date): Promise<number>;
}
export interface ScheduleClock {
  now(): Date;
  every(callback: () => void, milliseconds: number): () => void;
}
const clock: ScheduleClock = {
  now: () => new Date(),
  every(callback, milliseconds) {
    const timer = setInterval(callback, milliseconds);
    timer.unref();
    return () => clearInterval(timer);
  },
};

/** The clock only generates ordinary durable workflow work; execution has its own owner. */
export function createScheduleSource(
  store: ScheduleStore,
  time: ScheduleClock = clock,
): TriggerSource {
  let cancel: (() => void) | undefined;
  let processing: Promise<unknown> | undefined;
  const tick = () => {
    if (processing !== undefined) return;
    processing = store
      .tick(time.now())
      .catch((error: unknown) => {
        reportFailure(error, { operation: "schedule.tick", component: "triggers" });
      })
      .finally(() => {
        processing = undefined;
      });
  };
  return {
    async start() {
      cancel ??= time.every(tick, 1000);
      tick();
    },
    async stop() {
      cancel?.();
      cancel = undefined;
      await processing;
    },
  };
}

/** Only the clock accepts scheduled occurrences; public event intake cannot synthesize them. */
export function createScheduleProvider(): import("../index.js").TriggerProvider<
  "schedule",
  { event: { schedule: { trigger_id: string; scheduled_at: string; timezone: string } } }
> {
  return {
    name: "schedule",
    eventNames: ["schedule.tick"],
    async match() {
      return [];
    },
    async materializeContext({ triggerContext }) {
      return triggerContext.event;
    },
  };
}
