import { expect, it } from "vitest";
import { defaultDraft, projectRecurrence, ruleFromDraft } from "./form.js";
import { nextOccurrence, recurrenceSummary, RecurrenceSchema } from "./recurrence.js";

it("round-trips exact paired times without extra hour/minute combinations", () => {
  const draft = {
    ...defaultDraft("2026-01-01T09:00:00"),
    frequency: "WEEKLY",
    days: ["MO", "FR"],
    times: ["08:15", "16:45"],
  };
  const value = { start: "2026-01-01T09:00:00", timezone: "UTC", rule: ruleFromDraft(draft) };
  expect(projectRecurrence(value)).toEqual(draft);
  let after = new Date("2026-09-07T00:00:00Z");
  const actual = Array.from({ length: 5 }, () => {
    after = nextOccurrence(RecurrenceSchema.parse(value), after)!;
    return after.toISOString();
  });
  expect(actual).toEqual([
    "2026-09-07T08:15:00.000Z",
    "2026-09-07T16:45:00.000Z",
    "2026-09-11T08:15:00.000Z",
    "2026-09-11T16:45:00.000Z",
    "2026-09-14T08:15:00.000Z",
  ]);
});
it.each(["MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"])(
  "round-trips %s controls",
  (frequency) => {
    const draft = { ...defaultDraft("2026-09-09T09:00:00"), frequency, interval: 2 };
    const value = {
      start: "2026-09-09T09:00:00",
      timezone: "Europe/Berlin",
      rule: ruleFromDraft(draft),
    };
    expect(projectRecurrence(value)).toEqual(draft);
    expect(RecurrenceSchema.safeParse(value).success).toBe(true);
  },
);
it("round-trips the last Friday of each month", () => {
  const draft = {
    ...defaultDraft("2026-09-09T17:00:00"),
    frequency: "MONTHLY",
    monthly: "weekday" as const,
    ordinal: -1,
    weekday: "FR",
  };
  const value = {
    start: "2026-09-09T17:00:00",
    timezone: "Europe/Berlin",
    rule: ruleFromDraft(draft),
  };
  expect(projectRecurrence(value)).toEqual(draft);
  expect(recurrenceSummary(value)).toBe("Every month on the last friday at 17:00 (Europe/Berlin)");
});
it("preserves advanced rules instead of projecting them into lossy controls", () => {
  for (const rule of [
    "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29",
    "FREQ=DAILY;COUNT=10",
    "FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9,17;BYSETPOS=1,4",
    "FREQ=HOURLY;BYMINUTE=15,45",
  ])
    expect(projectRecurrence({ rule, start: "2026-01-01T09:00:00", timezone: "UTC" })).toBeNull();
});
it("rejects incomplete or duplicate controls before saving", () => {
  expect(() =>
    ruleFromDraft({ ...defaultDraft("2026-01-01T09:00:00"), times: ["09:00", "09:00"] }),
  ).toThrow("distinct");
  expect(() =>
    ruleFromDraft({ ...defaultDraft("2026-01-01T09:00:00"), frequency: "WEEKLY", days: [] }),
  ).toThrow("at least one day");
});
