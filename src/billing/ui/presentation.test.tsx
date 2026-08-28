import assert from "node:assert/strict";
import { it } from "vitest";
import type { BillingOverviewView, PublicBillingPlan } from "../../server/runtime.js";
import {
  intervalLabel,
  offeredIntervals,
  planAction,
  planPrice,
  recommendedPlanSlug,
  subscriptionSummary,
  trialFootnote,
} from "./presentation.js";

const euros = (unitAmount: number) => ({ unitAmount, currency: "eur" });

function plan(
  slug: string,
  name: string,
  prices: Partial<PublicBillingPlan["prices"]>,
): PublicBillingPlan {
  return {
    slug,
    name,
    marketingFeatures: [],
    prices: { monthly: null, annual: null, ...prices },
  };
}

function subscription(
  overrides: Partial<BillingOverviewView["subscription"]>,
): BillingOverviewView["subscription"] {
  return {
    planSlug: null,
    planName: null,
    status: null,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    trialEnd: null,
    trialEligible: true,
    manageable: false,
    ...overrides,
  };
}

it("prices a paid plan as a figure the customer can read at a glance", () => {
  assert.deepEqual(planPrice(euros(1500), "monthly"), {
    amount: "€15",
    unit: "per user / month",
  });
  assert.deepEqual(planPrice(euros(15000), "annual"), {
    amount: "€150",
    unit: "per user / year",
  });
});

it("prices the free tier as a figure so every plan column shares a baseline", () => {
  assert.deepEqual(planPrice(euros(0), "monthly"), { amount: "€0", unit: "forever" });
});

it("says which interval is missing rather than showing a blank price", () => {
  assert.deepEqual(planPrice(null, "annual"), { amount: "—", unit: "No yearly price" });
});

it("keeps the plan name in the trial button's accessible name while the visible label stays short", () => {
  const action = planAction({
    planName: "Paseo Hub",
    price: euros(1500),
    isCurrent: false,
    trialEligible: true,
  });
  assert.deepEqual(action, {
    label: "Start free trial",
    name: "Start free trial with Paseo Hub",
    disabled: false,
  });
  assert.ok(
    action.name.includes(action.label),
    "the accessible name must contain the visible label",
  );
});

it("offers a former subscriber ordinary checkout instead of a second trial", () => {
  assert.deepEqual(
    planAction({
      planName: "Paseo Hub",
      price: euros(1500),
      isCurrent: false,
      trialEligible: false,
    }),
    { label: "Choose Paseo Hub", name: "Choose Paseo Hub", disabled: false },
  );
});

it("never offers a trial on the free tier, even when the organization is trial eligible", () => {
  assert.deepEqual(
    planAction({ planName: "Free", price: euros(0), isCurrent: false, trialEligible: true }),
    { label: "Choose Free", name: "Choose Free", disabled: false },
  );
  assert.equal(trialFootnote(euros(0), "monthly", true), null);
});

it("disables the plan the organization is already on and names it", () => {
  const action = planAction({
    planName: "Free",
    price: euros(0),
    isCurrent: true,
    trialEligible: true,
  });
  assert.deepEqual(action, { label: "Current plan", name: "Current plan: Free", disabled: true });
});

it("disables a plan the catalog does not price at the selected interval", () => {
  assert.deepEqual(
    planAction({ planName: "Paseo Hub", price: null, isCurrent: false, trialEligible: true }),
    { label: "Not available", name: "Not available: Paseo Hub", disabled: true },
  );
});

it("spells out what the customer pays when the free days run out", () => {
  assert.equal(
    trialFootnote(euros(1500), "monthly", true),
    "14 days free, then €15 per user each month.",
  );
  assert.equal(
    trialFootnote(euros(15000), "annual", true),
    "14 days free, then €150 per user each year.",
  );
  assert.equal(trialFootnote(euros(1500), "monthly", false), null);
});

it("recommends the first paid plan the organization is not already on", () => {
  const plans = [
    plan("free", "Free", { monthly: euros(0) }),
    plan("solo", "Solo", { monthly: euros(1500) }),
    plan("team", "Team", { monthly: euros(4900) }),
  ];
  assert.equal(recommendedPlanSlug(plans, "monthly", null), "solo");
  assert.equal(recommendedPlanSlug(plans, "monthly", "solo"), "team");
  assert.equal(recommendedPlanSlug(plans.slice(0, 1), "monthly", null), null);
});

it("hides the interval switch for a catalog that only charges monthly", () => {
  const plans = [
    plan("free", "Free", { monthly: euros(0), annual: euros(0) }),
    plan("solo", "Solo", { monthly: euros(1500) }),
  ];
  assert.deepEqual(offeredIntervals(plans), ["monthly"]);
  assert.deepEqual(
    offeredIntervals([plan("solo", "Solo", { monthly: euros(1500), annual: euros(15000) })]),
    ["monthly", "annual"],
  );
  // A catalog with nothing priced still has to render at one interval.
  assert.deepEqual(offeredIntervals([]), ["monthly"]);
});

it("labels intervals the way the picker shows them", () => {
  assert.equal(intervalLabel("monthly"), "Monthly");
  assert.equal(intervalLabel("annual"), "Annual");
});

it("asks an unprovisioned organization to pick a plan", () => {
  assert.deepEqual(subscriptionSummary(subscription({})), {
    planName: null,
    status: null,
    detail: "Pick a plan to get started.",
  });
});

it("reads a free organization as having no subscription rather than an active one", () => {
  assert.deepEqual(subscriptionSummary(subscription({ planSlug: "free", planName: "Free" })), {
    planName: "Free",
    status: null,
    detail: "No subscription — upgrade whenever you're ready.",
  });
});

it("leads with the trial end date while a trial is running", () => {
  const summary = subscriptionSummary(
    subscription({
      planSlug: "solo",
      planName: "Solo",
      status: "trialing",
      trialEnd: "2026-09-11T00:00:00.000Z",
      currentPeriodEnd: "2026-09-11T00:00:00.000Z",
      manageable: true,
    }),
  );
  assert.deepEqual(summary.status, { tone: "success", label: "Trialing" });
  assert.equal(summary.detail, "Trial ends September 11, 2026.");
});

it("leads with the cancellation date once a subscription is set to end", () => {
  const summary = subscriptionSummary(
    subscription({
      planSlug: "solo",
      planName: "Solo",
      status: "active",
      cancelAtPeriodEnd: true,
      trialEnd: "2026-09-11T00:00:00.000Z",
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      manageable: true,
    }),
  );
  assert.equal(summary.detail, "Cancels on October 1, 2026.");
});

it("warns on a payment problem and stays neutral on an unrecognised status", () => {
  assert.deepEqual(
    subscriptionSummary(subscription({ planName: "Solo", status: "past_due" })).status,
    { tone: "warning", label: "Past Due" },
  );
  assert.deepEqual(
    subscriptionSummary(subscription({ planName: "Solo", status: "paused" })).status,
    { tone: "neutral", label: "Paused" },
  );
});
