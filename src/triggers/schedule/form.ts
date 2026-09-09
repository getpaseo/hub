import type { Recurrence } from "./recurrence.js";

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export const DAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export const FREQUENCIES = [
  { value: "MINUTELY", label: "Every minute" },
  { value: "HOURLY", label: "Every hour" },
  { value: "DAILY", label: "Every day" },
  { value: "WEEKLY", label: "Every week" },
  { value: "MONTHLY", label: "Every month" },
  { value: "YEARLY", label: "Every year" },
];
export interface RecurrenceDraft {
  frequency: string;
  interval: number;
  days: string[];
  times: string[];
  monthly: "date" | "weekday";
  monthDay: number;
  ordinal: number;
  weekday: string;
}
export function defaultDraft(start: string): RecurrenceDraft {
  return {
    frequency: "DAILY",
    interval: 1,
    days: ["MO"],
    times: [start.slice(11, 16)],
    monthly: "date",
    monthDay: Number(start.slice(8, 10)),
    ordinal: 1,
    weekday: "MO",
  };
}

/** Compile approachable controls into a single standard rule, including exact time pairs. */
export function ruleFromDraft(draft: RecurrenceDraft): string {
  if (!Number.isInteger(draft.interval) || draft.interval < 1 || draft.interval > 10000)
    throw new Error("Choose an interval from 1 to 10000.");
  const parts = [`FREQ=${draft.frequency}`];
  if (draft.interval !== 1) parts.push(`INTERVAL=${String(draft.interval)}`);
  if (draft.frequency === "WEEKLY") {
    if (draft.days.length === 0) throw new Error("Choose at least one day.");
    parts.push(`BYDAY=${DAY_CODES.filter((day) => draft.days.includes(day)).join(",")}`);
  }
  if (draft.frequency === "MONTHLY") {
    if (draft.monthly === "date") {
      if (
        !Number.isInteger(draft.monthDay) ||
        draft.monthDay === 0 ||
        draft.monthDay < -31 ||
        draft.monthDay > 31
      )
        throw new Error("Choose a day from 1 to 31, or -1 for the last day.");
      parts.push(`BYMONTHDAY=${String(draft.monthDay)}`);
    } else parts.push(`BYDAY=${String(draft.ordinal)}${draft.weekday}`);
  }
  if (!["MINUTELY", "HOURLY"].includes(draft.frequency)) {
    if (
      draft.times.length === 0 ||
      draft.times.some((time) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time))
    )
      throw new Error("Choose at least one valid time.");
    if (new Set(draft.times).size !== draft.times.length) throw new Error("Choose distinct times.");
    const hours = [...new Set(draft.times.map((time) => Number(time.slice(0, 2))))].sort(
      (a, b) => a - b,
    );
    const minutes = [...new Set(draft.times.map((time) => Number(time.slice(3))))].sort(
      (a, b) => a - b,
    );
    parts.push(`BYHOUR=${hours.join(",")}`, `BYMINUTE=${minutes.join(",")}`, "BYSECOND=0");
    const combinations = hours.flatMap((hour) =>
      minutes.map(
        (minute) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      ),
    );
    if (combinations.length !== draft.times.length) {
      const positions = combinations.flatMap((time, index) =>
        draft.times.includes(time) ? [index + 1] : [],
      );
      const days = draft.frequency === "WEEKLY" ? draft.days.length : 1;
      parts.push(
        `BYSETPOS=${Array.from({ length: days }, (_, day) =>
          positions.map((position) => day * combinations.length + position),
        )
          .flat()
          .join(",")}`,
      );
    }
  }
  return parts.join(";");
}

/** Rules the controls cannot faithfully express remain editable as RRULE without conversion. */
export function projectRecurrence(value: Recurrence): RecurrenceDraft | null {
  const parts = new Map(
    value.rule
      .split(";")
      .map(
        (part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)] as const,
      ),
  );
  const frequency = parts.get("FREQ");
  if (!FREQUENCIES.some((item) => item.value === frequency)) return null;
  if (
    [...parts.keys()].some(
      (key) =>
        ![
          "FREQ",
          "INTERVAL",
          "BYDAY",
          "BYMONTHDAY",
          "BYHOUR",
          "BYMINUTE",
          "BYSECOND",
          "BYSETPOS",
        ].includes(key),
    )
  )
    return null;
  const draft = {
    ...defaultDraft(value.start),
    frequency: frequency!,
    interval: Number(parts.get("INTERVAL") ?? 1),
  };
  const byDay = parts.get("BYDAY");
  if (frequency === "WEEKLY") {
    draft.days = byDay?.split(",") ?? [
      DAY_CODES[(new Date(`${value.start}Z`).getUTCDay() + 6) % 7]!,
    ];
    if (draft.days.some((day) => !DAY_CODES.some((code) => code === day))) return null;
  } else if (frequency === "MONTHLY" && byDay !== undefined) {
    const match = /^(-1|[1-5])(MO|TU|WE|TH|FR|SA|SU)$/u.exec(byDay);
    if (match === null) return null;
    draft.monthly = "weekday";
    draft.ordinal = Number(match[1]);
    draft.weekday = match[2]!;
  } else if (byDay !== undefined) return null;
  const monthDay = parts.get("BYMONTHDAY");
  if (monthDay !== undefined) {
    if (frequency !== "MONTHLY" || !/^-?\d+$/u.test(monthDay) || byDay !== undefined) return null;
    draft.monthDay = Number(monthDay);
  }
  if (["MINUTELY", "HOURLY"].includes(frequency!))
    return parts.size <= (parts.has("INTERVAL") ? 2 : 1) ? draft : null;
  return projectTimes(value, parts, draft);
}

function projectTimes(
  value: Recurrence,
  parts: Map<string, string>,
  draft: RecurrenceDraft,
): RecurrenceDraft | null {
  if (parts.has("BYSECOND") && parts.get("BYSECOND") !== "0") return null;
  if (!parts.has("BYSECOND") && value.start.slice(17) !== "00") return null;
  const hours = (parts.get("BYHOUR") ?? value.start.slice(11, 13))
    .split(",")
    .map(Number)
    .sort((a, b) => a - b);
  const minutes = (parts.get("BYMINUTE") ?? value.start.slice(14, 16))
    .split(",")
    .map(Number)
    .sort((a, b) => a - b);
  const combinations = hours.flatMap((hour) =>
    minutes.map((minute) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`),
  );
  const positions = parts.get("BYSETPOS")?.split(",").map(Number);
  draft.times =
    positions === undefined
      ? combinations
      : combinations.filter((_, index) => positions.includes(index + 1));
  if (draft.times.length === 0 || draft.times.length > 24) return null;
  if (positions !== undefined) {
    const generated = new Map(
      ruleFromDraft(draft)
        .split(";")
        .map(
          (part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)] as const,
        ),
    );
    if (generated.get("BYSETPOS") !== parts.get("BYSETPOS")) return null;
  }
  return draft;
}

export function describeRecurrence(value: Recurrence): string {
  const draft = projectRecurrence(value);
  if (draft === null) return `${value.rule} (${value.timezone})`;
  const units: Record<string, string> = {
    MINUTELY: "minute",
    HOURLY: "hour",
    DAILY: "day",
    WEEKLY: "week",
    MONTHLY: "month",
    YEARLY: "year",
  };
  let summary = `Every ${draft.interval === 1 ? "" : `${String(draft.interval)} `}${units[draft.frequency]}${draft.interval === 1 ? "" : "s"}`;
  if (draft.frequency === "WEEKLY")
    summary = `${draft.interval === 1 ? "Every" : `${summary} on`} ${DAY_CODES.filter((day) =>
      draft.days.includes(day),
    )
      .map((day) => WEEKDAYS[DAY_CODES.indexOf(day)]!.slice(0, 3))
      .map((day) => day.charAt(0).toUpperCase() + day.slice(1))
      .join(", ")}`;
  if (draft.frequency === "MONTHLY")
    summary +=
      draft.monthly === "date"
        ? ` on ${draft.monthDay === -1 ? "the last day" : `day ${String(draft.monthDay)}`}`
        : ` on the ${draft.ordinal === -1 ? "last" : ["", "first", "second", "third", "fourth", "fifth"][draft.ordinal]} ${WEEKDAYS[DAY_CODES.findIndex((day) => day === draft.weekday)]}`;
  if (["MINUTELY", "HOURLY"].includes(draft.frequency))
    summary += ` from ${value.start.replace("T", " ")}`;
  else summary += ` at ${draft.times.join(" and ")}`;
  return `${summary} (${value.timezone})`;
}
