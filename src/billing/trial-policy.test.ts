import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { TRIAL_DAYS, trialDaysRemaining } from "./trial-policy.js";

const NOW = new Date("2026-09-03T12:00:00.000Z");

function subscription(
  status: string | null,
  trialEnd: string | null,
): { status: string | null; trialEnd: string | null } {
  return { status, trialEnd };
}

describe("days left in a trial", () => {
  it("sets every new cardless trial to seven days", () => {
    assert.equal(TRIAL_DAYS, 7);
  });

  it("counts the days a trialing organization has left", () => {
    assert.equal(trialDaysRemaining(subscription("trialing", "2026-09-15T12:00:00.000Z"), NOW), 12);
  });

  it("counts a part-finished day as a whole one, so a trial never reads as already over", () => {
    assert.equal(trialDaysRemaining(subscription("trialing", "2026-09-04T03:00:00.000Z"), NOW), 1);
    assert.equal(trialDaysRemaining(subscription("trialing", "2026-09-03T12:00:01.000Z"), NOW), 1);
  });

  it("floors at zero rather than counting backwards past a lapsed trial", () => {
    assert.equal(trialDaysRemaining(subscription("trialing", "2026-08-20T12:00:00.000Z"), NOW), 0);
  });

  it("reports no trial for every state that is not one", () => {
    // Paid, lapsed, and never-subscribed all have to answer the same way: the sidebar decides
    // visibility on this one value, so anything but null here is a misleading countdown.
    for (const status of ["active", "past_due", "canceled", "unpaid", "incomplete_expired", null]) {
      assert.equal(
        trialDaysRemaining(subscription(status, "2026-09-15T12:00:00.000Z"), NOW),
        null,
        `${status ?? "no subscription"} reported a trial`,
      );
    }
  });

  it("reports no trial when the status says trialing but no end date came back", () => {
    assert.equal(trialDaysRemaining(subscription("trialing", null), NOW), null);
    assert.equal(trialDaysRemaining(subscription("trialing", "not a date"), NOW), null);
  });
});
