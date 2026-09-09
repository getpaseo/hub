import { Temporal } from "@js-temporal/polyfill";
import { RRuleTemporal } from "rrule-temporal";
import { z } from "zod";
import { describeRecurrence } from "./form.js";

const timezone = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions();
      return !/^[+-]/u.test(value);
    } catch {
      return false;
    }
  }, "Choose a valid IANA timezone.");
const shape = z
  .object({
    timezone,
    start: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u, "Choose a local start date and time."),
    rule: z.string().min(1).max(2048),
  })
  .strict();
export type Recurrence = z.infer<typeof shape>;
export const RecurrenceSchema = shape.superRefine((value, context) => {
  try {
    const { evaluator, start } = compile(value);
    evaluator.next(new Date(start.toZonedDateTime("UTC").epochMilliseconds - 1));
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["rule"],
      message: error instanceof Error ? error.message : "Invalid recurrence rule.",
    });
  }
});
export const DEFAULT_RECURRENCE: Recurrence = {
  // Presets follow the clock immediately; the daily time belongs to the rule, not a future anchor.
  start: "1970-01-01T00:00:00",
  rule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
  timezone: "UTC",
};

const PARTS = new Set([
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYSECOND",
  "BYMINUTE",
  "BYHOUR",
  "BYDAY",
  "BYMONTHDAY",
  "BYYEARDAY",
  "BYWEEKNO",
  "BYMONTH",
  "BYSETPOS",
  "WKST",
]);
function compile(recurrence: Recurrence) {
  const start = Temporal.PlainDateTime.from(recurrence.start, { overflow: "reject" });
  const parts = new Map<string, string>();
  for (const part of recurrence.rule.split(";")) {
    const match = /^([A-Z]+)=([A-Z0-9,+-]+)$/u.exec(part);
    if (match === null || !PARTS.has(match[1]!) || parts.has(match[1]!))
      throw new Error("Use one RRULE with distinct, supported RFC 5545 fields.");
    parts.set(match[1]!, match[2]!);
  }
  if (parts.has("COUNT") && parts.has("UNTIL")) throw new Error("Use COUNT or UNTIL, not both.");
  const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : null;
  if (count !== null && (!Number.isSafeInteger(count) || count < 1 || count > 10000))
    throw new Error("COUNT must be between 1 and 10000.");
  const untilValue = parts.get("UNTIL");
  if (untilValue !== undefined && !/^\d{8}T\d{6}Z$/u.test(untilValue))
    throw new Error("UNTIL must be a UTC date-time, such as 20261231T235959Z.");
  const until =
    untilValue === undefined ? null : Temporal.Instant.from(untilValue).epochMilliseconds;
  const source = `DTSTART:${start.toString({ smallestUnit: "second" }).replaceAll(/[-:]/gu, "")}Z\nRRULE:${recurrence.rule}`;
  // Validate all rule combinations before stripping the limits applied to real instants below.
  new RRuleTemporal({ rruleString: source, strict: true }).options();
  validateRanges(parts);
  // Make RFC DTSTART defaults explicit: Temporal month addition otherwise constrains day 31.
  const frequency = parts.get("FREQ");
  if (
    (frequency === "MONTHLY" || frequency === "YEARLY") &&
    !["BYMONTHDAY", "BYDAY", "BYYEARDAY", "BYWEEKNO"].some((key) => parts.has(key))
  ) {
    parts.set("BYMONTHDAY", String(start.day));
    if (frequency === "YEARLY" && !parts.has("BYMONTH")) parts.set("BYMONTH", String(start.month));
  }
  parts.delete("COUNT");
  parts.delete("UNTIL");
  const evaluator = new RRuleTemporal({
    rruleString: `${source.split("\n")[0]}\nRRULE:${[...parts].map(([key, value]) => `${key}=${value}`).join(";")}`,
    strict: true,
    maxIterations: 10000,
    maxCandidateEvaluations: 100000,
  });
  return { evaluator, start, count, until };
}

/** RRULE expands wall times; this adapter owns timezone gaps, folds and finite limits. */
export function nextOccurrence(recurrence: Recurrence, after: Date): Date | null {
  const { evaluator, start, count, until } = compile(recurrence);
  if (until !== null && after.getTime() >= until) return null;
  const localAfter = Temporal.Instant.fromEpochMilliseconds(after.getTime())
    .toZonedDateTimeISO(recurrence.timezone)
    .toPlainDateTime();
  let cursor = (count === null ? localAfter : start).toZonedDateTime("UTC");
  let inclusive = count !== null;
  let generated = 0;
  for (let attempts = 0; attempts < 20000; attempts++) {
    const candidate = evaluator.next(new Date(cursor.epochMilliseconds), inclusive);
    if (candidate === null) return null;
    cursor = Temporal.Instant.fromEpochMilliseconds(candidate.epochMilliseconds).toZonedDateTimeISO(
      "UTC",
    );
    inclusive = false;
    const local = cursor.toPlainDateTime();
    const instant = local.toZonedDateTime(recurrence.timezone, { disambiguation: "earlier" });
    if (!instant.toPlainDateTime().equals(local)) {
      // Seek directly to the first valid wall time, even when a timezone skips an entire day.
      cursor = instant.getTimeZoneTransition("next")!.toPlainDateTime().toZonedDateTime("UTC");
      inclusive = true;
      continue;
    }
    generated++;
    if (count !== null && generated > count) return null;
    if (until !== null && instant.epochMilliseconds > until) return null;
    if (instant.epochMilliseconds > after.getTime()) return new Date(instant.epochMilliseconds);
  }
  throw new Error("Recurrence exceeds the evaluation limit.");
}

export const recurrenceSummary = describeRecurrence;

function validateRanges(parts: Map<string, string>): void {
  const byDay = parts.get("BYDAY");
  if (
    byDay !== undefined &&
    byDay.split(",").some((day) => {
      const ordinal = Number(day.slice(0, -2));
      return Math.abs(ordinal) > 53;
    })
  )
    throw new Error("BYDAY ordinals must be between -53 and 53.");
  const ranges: Record<string, [number, number, boolean]> = {
    BYSECOND: [0, 59, false],
    BYMINUTE: [0, 59, false],
    BYHOUR: [0, 23, false],
    BYMONTH: [1, 12, false],
    BYMONTHDAY: [-31, 31, true],
    BYYEARDAY: [-366, 366, true],
    BYWEEKNO: [-53, 53, true],
    BYSETPOS: [-366, 366, true],
    INTERVAL: [1, 10000, false],
  };
  for (const [key, [min, max, nonzero]] of Object.entries(ranges)) {
    const value = parts.get(key);
    if (
      value !== undefined &&
      value
        .split(",")
        .some(
          (item) =>
            !/^[+-]?\d+$/u.test(item) ||
            Number(item) < min ||
            Number(item) > max ||
            (nonzero && Number(item) === 0),
        )
    )
      throw new Error(`Invalid ${key} value.`);
  }
}
