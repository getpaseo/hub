import assert from "node:assert/strict";
import { it } from "vitest";
import type { BillingPlanPriceInterval } from "../../db/types.js";
import type { BillingOverviewView, PublicBillingPlan } from "../../server/runtime.js";
/**
 * Copy rules, not the product catalog. Where several plans are needed to pin generic behaviour
 * these use deliberately synthetic names — Hub sells one plan today, and a fixture that pretends
 * otherwise is how obsolete tiers end up on a screenshot.
 */

import { formatAbsolute } from "../../components/app/relative-time.js";
import {
  intervalLabel,
  offeredIntervals,
  planAction,
  planPrice,
  purchasablePlans,
  subscriptionSummary,
} from "./presentation.js";

const euros = (unitAmount: number, interval: BillingPlanPriceInterval = "monthly") => ({
  interval,
  intervalCount: 1 as const,
  unitAmount,
  currency: "eur",
  tooltip: null,
});

function plan(
  slug: string,
  name: string,
  prices: Partial<Record<BillingPlanPriceInterval, ReturnType<typeof euros>>>,
): PublicBillingPlan {
  return {
    slug,
    name,
    billing: {
      model: "per_unit",
      unit: {
        key: "seat",
        label: "seat",
      },
    },
    features: [],
    prices: Object.values(prices),
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
    manageable: false,
    ...overrides,
  };
}

it("prices a paid plan as a figure the customer can read at a glance", () => {
  assert.deepEqual(planPrice(euros(1500), "monthly"), {
    amount: "€15",
    unit: "per seat / month",
  });
  assert.deepEqual(planPrice(euros(15000, "annual"), "annual"), {
    amount: "€150",
    unit: "per seat / year",
  });
});

it("prices the free tier as a figure so every plan column shares a baseline", () => {
  assert.deepEqual(planPrice(euros(0), "monthly"), { amount: "€0", unit: "forever" });
});

it("says which interval is missing rather than showing a blank price", () => {
  assert.deepEqual(planPrice(null, "annual"), { amount: "—", unit: "No yearly price" });
});

it("keeps the plan name in the button's accessible name while the visible label stays short", () => {
  const action = planAction({ planName: "Paseo Hub", price: euros(1500), isCurrent: false });
  assert.deepEqual(action, {
    label: "Subscribe",
    name: "Subscribe to Paseo Hub",
    disabled: false,
  });
  assert.ok(
    action.name.includes(action.label),
    "the accessible name must contain the visible label",
  );
});

it("disables the plan the organization is already on and names it", () => {
  const action = planAction({ planName: "Free", price: euros(0), isCurrent: true });
  assert.deepEqual(action, { label: "Current plan", name: "Current plan: Free", disabled: true });
});

it("disables a plan the catalog does not price at the selected interval", () => {
  assert.deepEqual(planAction({ planName: "Paseo Hub", price: null, isCurrent: false }), {
    label: "Not available",
    name: "Not available: Paseo Hub",
    disabled: true,
  });
});

it("counts Free as a plan on the page but not as something to buy", () => {
  const free = plan("free", "Free", { monthly: euros(0) });
  const pro = plan("hosted", "Pro", { monthly: euros(1500) });

  assert.deepEqual(purchasablePlans([free, pro]), [pro]);
  assert.deepEqual(purchasablePlans([free]), []);
});

it("hides the interval switch for a catalog that only charges monthly", () => {
  const plans = [
    plan("free", "Free", { monthly: euros(0), annual: euros(0, "annual") }),
    plan("starter", "Starter", { monthly: euros(1500) }),
  ];
  assert.deepEqual(offeredIntervals(plans), ["monthly"]);
  assert.deepEqual(
    offeredIntervals([
      plan("starter", "Starter", {
        monthly: euros(1500),
        annual: euros(15000, "annual"),
      }),
    ]),
    ["monthly", "annual"],
  );
  // A catalog with nothing priced still has to render at one interval.
  assert.deepEqual(offeredIntervals([]), ["monthly"]);
});

it("labels intervals the way the picker shows them", () => {
  assert.equal(intervalLabel("monthly"), "Monthly");
  assert.equal(intervalLabel("annual"), "Annual");
});

it("says nothing beyond the plan when there is no subscription to describe", () => {
  // Free is a plan with no subscription behind it: it is named, and nothing is dated or pending.
  assert.deepEqual(subscriptionSummary(subscription({ planSlug: "free", planName: "Free" })), {
    planName: "Free",
    status: null,
    detail: null,
  });
});

it("leads with the renewal date while a subscription is running", () => {
  const summary = subscriptionSummary(
    subscription({
      planSlug: "hosted",
      planName: "Pro",
      status: "active",
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      manageable: true,
    }),
  );
  assert.deepEqual(summary.status, { tone: "success", label: "Active" });
  // The date is the app's one absolute formatter — a billing date and the same instant in a
  // tooltip read as the same string.
  assert.equal(summary.detail, `Renews on ${formatAbsolute("2026-10-01T00:00:00.000Z")}.`);
});

it("leads with the cancellation date once a subscription is set to end", () => {
  const summary = subscriptionSummary(
    subscription({
      planSlug: "hosted",
      planName: "Pro",
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      manageable: true,
    }),
  );
  // A pending cancellation outranks the renewal, and it dates from the period end.
  assert.equal(summary.detail, `Cancels on ${formatAbsolute("2026-10-01T00:00:00.000Z")}.`);
});

it("warns on a payment problem and stays neutral on an unrecognised status", () => {
  assert.deepEqual(
    subscriptionSummary(subscription({ planName: "Pro", status: "past_due" })).status,
    { tone: "warning", label: "Past due" },
  );
  assert.deepEqual(
    subscriptionSummary(subscription({ planName: "Pro", status: "paused" })).status,
    { tone: "neutral", label: "Paused" },
  );
});
