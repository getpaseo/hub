import { expect, it } from "vitest";
import { createScheduleSource, type ScheduleClock, type ScheduleStore } from "./index.js";

it("owns one clock loop and waits for in-flight work when stopped", async () => {
  let tick: (() => void) | undefined;
  let stopped = 0;
  let release: (() => void) | undefined;
  const observed: Date[] = [];
  const now = new Date("2026-09-09T12:00:00Z");
  const clock: ScheduleClock = {
    now: () => now,
    every(callback) {
      tick = callback;
      return () => {
        stopped++;
      };
    },
  };
  const store: ScheduleStore = {
    async tick(time) {
      observed.push(time);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 1;
    },
  };
  const source = createScheduleSource(store, clock);
  await source.start(async () => {});
  await source.start(async () => {});
  tick!();
  expect(observed).toEqual([now]);
  let finished = false;
  const stopping = source.stop().then(() => {
    finished = true;
    return undefined;
  });
  await Promise.resolve();
  expect(stopped).toBe(1);
  expect(finished).toBe(false);
  release!();
  await stopping;
  expect(finished).toBe(true);
});
