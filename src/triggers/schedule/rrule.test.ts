import { describe, expect, it } from "vitest";
import { RecurrenceSchema, nextOccurrence } from "./recurrence.js";

const recurrence = (rule: string, start = "2026-01-01T09:00:00", timezone = "UTC") => ({
  rule,
  start,
  timezone,
});
const next = (rule: ReturnType<typeof recurrence>, after: string) =>
  nextOccurrence(RecurrenceSchema.parse(rule), new Date(after))?.toISOString() ?? null;

describe("standard recurrence rules", () => {
  it("supports hourly and anchored 90-minute recurrence", () => {
    expect(next(recurrence("FREQ=HOURLY"), "2026-09-09T09:00:00Z")).toBe(
      "2026-09-09T10:00:00.000Z",
    );
    expect(next(recurrence("FREQ=MINUTELY;INTERVAL=90"), "2026-09-09T09:05:00Z")).toBe(
      "2026-09-09T10:30:00.000Z",
    );
  });
  it("supports last Fridays, month ends and leap years", () => {
    expect(next(recurrence("FREQ=MONTHLY;BYDAY=-1FR"), "2026-09-01T00:00:00Z")).toBe(
      "2026-09-25T09:00:00.000Z",
    );
    expect(next(recurrence("FREQ=MONTHLY;BYMONTHDAY=-1"), "2026-02-01T00:00:00Z")).toBe(
      "2026-02-28T09:00:00.000Z",
    );
    expect(next(recurrence("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"), "2026-02-01T00:00:00Z")).toBe(
      "2028-02-29T09:00:00.000Z",
    );
  });
  it("skips missing dates and local times without consuming COUNT", () => {
    const rule = recurrence("FREQ=DAILY;COUNT=3", "2026-03-28T02:30:00", "Europe/Berlin");
    expect(next(rule, "2026-03-28T01:30:00Z")).toBe("2026-03-30T00:30:00.000Z");
    expect(next(rule, "2026-03-30T00:30:00Z")).toBe("2026-03-31T00:30:00.000Z");
    expect(next(rule, "2026-03-31T00:30:00Z")).toBeNull();
    expect(
      next(recurrence("FREQ=MONTHLY;COUNT=3", "2026-01-31T09:00:00"), "2026-03-31T09:00:00Z"),
    ).toBe("2026-05-31T09:00:00.000Z");
  });
  it("runs only the earlier instant of a repeated local time", () => {
    const rule = recurrence("FREQ=DAILY", "2026-01-01T02:30:00", "Europe/Berlin");
    expect(next(rule, "2026-10-24T02:00:00Z")).toBe("2026-10-25T00:30:00.000Z");
    expect(next(rule, "2026-10-25T00:30:00Z")).toBe("2026-10-26T01:30:00.000Z");
    expect(next(rule, "2026-10-25T01:00:00Z")).toBe("2026-10-26T01:30:00.000Z");
  });
  it("honors an inclusive UTC UNTIL and start boundary", () => {
    const rule = recurrence(
      "FREQ=HOURLY;UNTIL=20260909T100000Z",
      "2026-09-09T09:00:00",
      "Europe/Berlin",
    );
    expect(next(rule, "2026-09-09T06:00:00Z")).toBe("2026-09-09T07:00:00.000Z");
    expect(next(rule, "2026-09-09T09:00:00Z")).toBe("2026-09-09T10:00:00.000Z");
    expect(next(rule, "2026-09-09T10:00:00Z")).toBeNull();
  });
  it.each([
    "FREQ=DAILY;BOGUS=1",
    "FREQ=DAILY;FREQ=HOURLY",
    "FREQ=DAILY\nRRULE:FREQ=HOURLY",
    "FREQ=DAILY;INTERVAL=0",
    "FREQ=MONTHLY;BYMONTHDAY=0",
    "FREQ=DAILY;COUNT=3;UNTIL=20260909T100000Z",
    "FREQ=DAILY;BYHOUR=25",
    "FREQ=MONTHLY;BYDAY=54MO",
    "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
  ])("rejects invalid or lossy rule %s", (rule) => {
    expect(RecurrenceSchema.safeParse(recurrence(rule)).success).toBe(false);
  });
});

it("skips an entire missing calendar day without exhausting a frequent rule", () => {
  const value = recurrence("FREQ=SECONDLY;COUNT=1", "2011-12-30T00:00:00", "Pacific/Apia");
  expect(next(value, "2011-12-30T09:59:59Z")).toBe("2011-12-30T10:00:00.000Z");
});
