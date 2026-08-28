import type { StatusTone } from "../../components/app/status-pill.js";
import type { BillingPlanPriceInterval } from "../../db/types.js";
import type {
  BillingOverviewView,
  PublicBillingPlan,
  PublicBillingPlanPrice,
} from "../../server/runtime.js";

/**
 * Every word the billing surfaces render: prices, the button on each plan, and the one sentence
 * that says what happens next. Pure and React-free, so the copy is unit-testable and the panel
 * and plan dialog only have to lay it out. Nothing here reaches for the DOM or the network.
 */

const INTERVAL_WORDS: Record<
  BillingPlanPriceInterval,
  { label: string; unit: string; adjective: string }
> = {
  monthly: { label: "Monthly", unit: "month", adjective: "monthly" },
  annual: { label: "Annual", unit: "year", adjective: "yearly" },
};

const INTERVAL_ORDER: readonly BillingPlanPriceInterval[] = ["monthly", "annual"];

export function intervalLabel(interval: BillingPlanPriceInterval): string {
  return INTERVAL_WORDS[interval].label;
}

/**
 * The intervals worth showing a switch for: the ones some plan actually charges at. A catalog
 * published monthly-only collapses to a single interval and the picker drops the switch rather
 * than offering a column of "—". Never empty, so the picker always has an interval to price at.
 */
export function offeredIntervals(
  plans: readonly PublicBillingPlan[],
): readonly BillingPlanPriceInterval[] {
  const offered = INTERVAL_ORDER.filter((interval) =>
    plans.some((plan) => isPaidPrice(plan.prices[interval])),
  );
  return offered.length === 0 ? ["monthly"] : offered;
}

/** The number of free trial days Stripe grants on a cardless checkout. */
export const TRIAL_DAYS = 14;

export interface PlanPrice {
  /** The headline figure — "€15", "Free", or "—" when this interval has no price. */
  amount: string;
  /** The unit line under the figure — never repeats the figure. */
  unit: string;
}

export function planPrice(
  price: PublicBillingPlanPrice | null,
  interval: BillingPlanPriceInterval,
): PlanPrice {
  const words = INTERVAL_WORDS[interval];
  if (price === null) return { amount: "—", unit: `No ${words.adjective} price` };
  // Every column shows a figure, including the free tier: the plan's name already says "Free",
  // and repeating the word where the price goes costs the columns their shared baseline.
  if (price.unitAmount === 0) return { amount: formatAmount(price), unit: "forever" };
  return { amount: formatAmount(price), unit: `per user / ${words.unit}` };
}

/** A plan a customer pays for, as opposed to the mirrored Free tier. Only these carry a trial. */
export function isPaidPrice(price: PublicBillingPlanPrice | null): boolean {
  return price !== null && price.unitAmount > 0;
}

export interface PlanAction {
  /** The visible button text. Short enough to fit a narrow plan column at any plan name length. */
  label: string;
  /** The accessible name. Always contains `label`, so it satisfies WCAG 2.5.3 Label in Name, and
   * always names the plan, so two plans never present the same name to a screen reader or test. */
  name: string;
  disabled: boolean;
}

export function planAction(input: {
  planName: string;
  price: PublicBillingPlanPrice | null;
  isCurrent: boolean;
  trialEligible: boolean;
}): PlanAction {
  if (input.isCurrent) {
    return { label: "Current plan", name: `Current plan: ${input.planName}`, disabled: true };
  }
  if (input.price === null) {
    return { label: "Not available", name: `Not available: ${input.planName}`, disabled: true };
  }
  if (input.trialEligible && isPaidPrice(input.price)) {
    return {
      label: "Start free trial",
      name: `Start free trial with ${input.planName}`,
      disabled: false,
    };
  }
  return { label: `Choose ${input.planName}`, name: `Choose ${input.planName}`, disabled: false };
}

/** The line under a trial button that spells out what happens when the free days run out. Null
 * when there is no trial to explain, so the free plan's column stays quiet. */
export function trialFootnote(
  price: PublicBillingPlanPrice | null,
  interval: BillingPlanPriceInterval,
  trialEligible: boolean,
): string | null {
  if (!trialEligible || !isPaidPrice(price) || price === null) return null;
  return `${TRIAL_DAYS} days free, then ${formatAmount(price)} per user each ${INTERVAL_WORDS[interval].unit}.`;
}

/**
 * The plan the picker leans on: the first paid plan the organization is not already on. Catalog
 * order is the author's order, so "first" is the cheapest entry point they published.
 */
export function recommendedPlanSlug(
  plans: readonly PublicBillingPlan[],
  interval: BillingPlanPriceInterval,
  currentPlanSlug: string | null,
): string | null {
  const recommended = plans.find(
    (plan) => plan.slug !== currentPlanSlug && isPaidPrice(plan.prices[interval]),
  );
  return recommended?.slug ?? null;
}

export interface SubscriptionSummary {
  /** The plan the organization is billed on, or null before provisioning stamps one. */
  planName: string | null;
  /** The Stripe status pill. Null when no live subscription exists, which is the normal state
   * for a free organization and for one whose subscription was cancelled. */
  status: { tone: StatusTone; label: string } | null;
  /** One sentence naming the next thing that will happen to this subscription. */
  detail: string;
}

export function subscriptionSummary(
  subscription: BillingOverviewView["subscription"],
): SubscriptionSummary {
  return {
    planName: subscription.planName,
    status:
      subscription.status === null
        ? null
        : { tone: statusTone(subscription.status), label: statusText(subscription.status) },
    detail: subscriptionDetail(subscription),
  };
}

function subscriptionDetail(subscription: BillingOverviewView["subscription"]): string {
  if (subscription.planName === null) return "Pick a plan to get started.";
  if (subscription.status === null) return "No subscription — upgrade whenever you're ready.";
  if (subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd !== null) {
    return `Cancels on ${formatDate(subscription.currentPeriodEnd)}.`;
  }
  if (subscription.trialEnd !== null) return `Trial ends ${formatDate(subscription.trialEnd)}.`;
  if (subscription.currentPeriodEnd !== null) {
    return `Renews on ${formatDate(subscription.currentPeriodEnd)}.`;
  }
  return "Active subscription.";
}

function formatAmount(price: PublicBillingPlanPrice): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.currency.toUpperCase(),
    minimumFractionDigits: 0,
  }).format(price.unitAmount / 100);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function statusTone(status: string): StatusTone {
  if (status === "active" || status === "trialing") return "success";
  if (status === "past_due" || status === "unpaid" || status === "incomplete") return "warning";
  return "neutral";
}

function statusText(status: string): string {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
