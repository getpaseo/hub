import { scheduleYaml } from "./test-fixture.js";
import { describe, expect, it } from "vitest";
import { RecurrenceSchema, nextOccurrence, type Recurrence } from "./recurrence.js";
import { compileTriggerDocument, parseTriggerDocument } from "../configuration/index.js";
import { patchTriggerYaml, projectTriggerForm } from "../configuration/editor.js";

const daily: Recurrence = {
  frequency: "daily",
  times: ["17:00", "09:00"],
  timezone: "Europe/Berlin",
};
const next = (rule: Recurrence, after: string) =>
  nextOccurrence(rule, new Date(after)).toISOString();

describe("calendar recurrence", () => {
  it("orders distinct daily times strictly after the given instant", () => {
    expect(next(daily, "2026-09-09T07:00:00Z")).toBe("2026-09-09T15:00:00.000Z");
    expect(next(daily, "2026-09-09T15:00:00Z")).toBe("2026-09-10T07:00:00.000Z");
  });
  it("supports selected weekdays and multiple times", () => {
    const weekly: Recurrence = { ...daily, frequency: "weekly", days: ["monday", "friday"] };
    expect(next(weekly, "2026-09-09T07:00:00Z")).toBe("2026-09-11T07:00:00.000Z");
    expect(next(weekly, "2026-09-11T15:00:00Z")).toBe("2026-09-14T07:00:00.000Z");
  });
  it("skips a spring gap and runs an autumn fold only at its earlier instant", () => {
    const rule: Recurrence = { ...daily, times: ["02:30"] };
    expect(next(rule, "2026-03-28T02:00:00Z")).toBe("2026-03-30T00:30:00.000Z");
    expect(next(rule, "2026-10-24T02:00:00Z")).toBe("2026-10-25T00:30:00.000Z");
    expect(next(rule, "2026-10-25T00:30:00Z")).toBe("2026-10-26T01:30:00.000Z");
  });
  it("handles half-hour DST changes and non-hour timezone offsets", () => {
    expect(
      next(
        { frequency: "daily", times: ["02:15"], timezone: "Australia/Lord_Howe" },
        "2026-10-03T00:00:00Z",
      ),
    ).toBe("2026-10-04T15:15:00.000Z");
    expect(
      next(
        { frequency: "daily", times: ["09:00"], timezone: "Asia/Kathmandu" },
        "2026-09-09T00:00:00Z",
      ),
    ).toBe("2026-09-09T03:15:00.000Z");
  });
  it.each([
    { ...daily, times: [] },
    { ...daily, times: ["25:00"] },
    { ...daily, times: ["09:00", "09:00"] },
    { ...daily, timezone: "Mars/Olympus" },
    { ...daily, frequency: "weekly", days: [] },
    { ...daily, frequency: "daily", days: ["monday"] },
  ])("rejects invalid recurrence %#", (rule) => {
    expect(RecurrenceSchema.safeParse(rule).success).toBe(false);
  });
});

it("round trips recurrence through YAML, compiler and the existing execution form", () => {
  const projection = projectTriggerForm(scheduleYaml);
  expect(projection.status).toBe("editable");
  if (projection.status !== "editable") throw new Error(projection.reason);
  const yaml = patchTriggerYaml(scheduleYaml, {
    ...projection.value,
    recurrence: {
      frequency: "weekly",
      days: ["monday", "friday"],
      times: ["08:15", "16:45"],
      timezone: "America/New_York",
    },
  });
  const parsed = parseTriggerDocument(yaml);
  expect(parsed.on["schedule.tick"]?.recurrence).toEqual({
    frequency: "weekly",
    days: ["monday", "friday"],
    times: ["08:15", "16:45"],
    timezone: "America/New_York",
  });
  expect(parsed.run.agent).toEqual({
    provider: "test",
    mode: "full-access",
    thinkingOptionId: "low",
  });
  expect(yaml).toContain("# scheduled scan");
  expect(compileTriggerDocument(yaml).events[0]?.on).toBe("schedule.tick");
  expect(projectTriggerForm(yaml)).toMatchObject({
    status: "editable",
    value: { recurrence: parsed.on["schedule.tick"]?.recurrence },
  });
});
