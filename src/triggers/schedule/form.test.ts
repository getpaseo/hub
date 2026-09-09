import { expect, it } from "vitest";
import { defaultDraft, projectRecurrence, ruleFromDraft } from "./form.js";
import { DEFAULT_RECURRENCE, nextOccurrence, RecurrenceSchema } from "./recurrence.js";

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
it.each(["MINUTELY", "HOURLY", "DAILY", "WEEKLY"])(
  "round-trips simple %s controls",
  (frequency) => {
    const draft = { ...defaultDraft("2026-09-09T09:00:00"), frequency };
    const value = {
      start: "2026-09-09T09:00:00",
      timezone: "Europe/Berlin",
      rule: ruleFromDraft(draft),
    };
    expect(projectRecurrence(value)).toEqual(draft);
    expect(RecurrenceSchema.safeParse(value).success).toBe(true);
  },
);
it.each([
  "FREQ=MINUTELY;INTERVAL=90",
  "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
  "FREQ=MONTHLY;BYDAY=-1FR",
  "FREQ=YEARLY",
])("leaves %s in a custom rule field", (rule) => {
  const value = { start: "2026-01-01T09:00:00", timezone: "UTC", rule };
  expect(projectRecurrence(value)).toBeNull();
  expect(RecurrenceSchema.safeParse(value).success).toBe(true);
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

it.each([
  [
    "UTC",
    "2026-09-09T07:00:00Z",
    "2026-09-09T07:01:00.000Z",
    "2026-09-09T08:00:00.000Z",
    "2026-09-09T08:00:00.000Z",
  ],
  [
    "Pacific/Honolulu",
    "2026-09-09T09:00:00Z",
    "2026-09-09T09:01:00.000Z",
    "2026-09-09T10:00:00.000Z",
    "2026-09-09T18:00:00.000Z",
  ],
  [
    "Asia/Tokyo",
    "2026-09-08T22:00:00Z",
    "2026-09-08T22:01:00.000Z",
    "2026-09-08T23:00:00.000Z",
    "2026-09-08T23:00:00.000Z",
  ],
])(
  "starts new presets at the next matching local time in %s",
  (timezone, now, minute, hour, daily) => {
    for (const [frequency, expected] of [
      ["MINUTELY", minute],
      ["HOURLY", hour],
      ["DAILY", daily],
    ]) {
      const draft = {
        ...projectRecurrence(DEFAULT_RECURRENCE)!,
        frequency: frequency!,
        times: ["08:00"],
      };
      const recurrence = { ...DEFAULT_RECURRENCE, timezone, rule: ruleFromDraft(draft) };
      expect(nextOccurrence(recurrence, new Date(now))?.toISOString()).toBe(expected);
    }
  },
);
it("keeps the default daily time and explicitly authored future anchors", () => {
  expect(projectRecurrence(DEFAULT_RECURRENCE)?.times).toEqual(["09:00"]);
  const custom = {
    start: "2026-09-10T12:00:00",
    timezone: "UTC",
    rule: "FREQ=MINUTELY;INTERVAL=90",
  };
  expect(projectRecurrence(custom)).toBeNull();
  expect(nextOccurrence(custom, new Date("2026-09-09T07:00:00Z"))?.toISOString()).toBe(
    "2026-09-10T12:00:00.000Z",
  );
});
