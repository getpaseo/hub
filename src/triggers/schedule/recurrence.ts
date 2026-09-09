import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
const times = z
  .array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "Use a time in HH:mm format."))
  .min(1, "Choose at least one time.")
  .max(24)
  .refine((values) => new Set(values).size === values.length, "Choose distinct times.");
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
export const RecurrenceSchema = z.discriminatedUnion("frequency", [
  z.object({ frequency: z.literal("daily"), times, timezone }).strict(),
  z
    .object({
      frequency: z.literal("weekly"),
      days: z
        .array(z.enum(WEEKDAYS))
        .min(1, "Choose at least one day.")
        .max(7)
        .refine((values) => new Set(values).size === values.length, "Choose distinct days."),
      times,
      timezone,
    })
    .strict(),
]);
export type Recurrence = z.infer<typeof RecurrenceSchema>;
export const DEFAULT_RECURRENCE: Recurrence = {
  frequency: "daily",
  times: ["09:00"],
  timezone: "UTC",
};

/** Strictly after the supplied instant. Gaps are skipped; folds use the earlier instant. */
export function nextOccurrence(recurrence: Recurrence, after: Date): Date {
  let date = Temporal.Instant.fromEpochMilliseconds(after.getTime())
    .toZonedDateTimeISO(recurrence.timezone)
    .toPlainDate();
  for (let offset = 0; offset < 15; offset++, date = date.add({ days: 1 })) {
    if (
      recurrence.frequency === "weekly" &&
      !recurrence.days.includes(WEEKDAYS[date.dayOfWeek - 1]!)
    )
      continue;
    for (const time of [...recurrence.times].sort()) {
      const local = date.toPlainDateTime(Temporal.PlainTime.from(time));
      const zoned = local.toZonedDateTime(recurrence.timezone, { disambiguation: "earlier" });
      if (!zoned.toPlainDateTime().equals(local)) continue;
      if (zoned.epochMilliseconds > after.getTime()) return new Date(zoned.epochMilliseconds);
    }
  }
  throw new Error("No occurrence found within two weeks.");
}

export function recurrenceSummary(recurrence: Recurrence): string {
  const days =
    recurrence.frequency === "daily"
      ? "Every day"
      : `Every ${WEEKDAYS.filter((day) => recurrence.days.includes(day))
          .map((day) => day.charAt(0).toUpperCase() + day.slice(1, 3))
          .join(", ")}`;
  return `${days} at ${[...recurrence.times].sort().join(" and ")} (${recurrence.timezone})`;
}
