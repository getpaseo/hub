import { Check } from "lucide-react";
import { formatAbsolute } from "../../components/app/relative-time.js";
import { statusLabel, type StatusTone } from "../../components/app/status-pill.js";
import { cn } from "../../lib/utils.js";
import type { BillingPlanPriceInterval } from "../../db/types.js";
import type {
  BillingOverviewView,
  PublicBillingPlan,
  PublicBillingPlanFeature,
  PublicBillingPlanPrice,
} from "../../server/runtime.js";
/**
 * Every word the billing surfaces render: prices, the button on each plan, and the one sentence
 * that says what happens next. The copy is pure and unit-testable; nothing here reaches for the
 * DOM or the network. The one piece of markup is the feature list, which the panel and the plan
 * dialog both render and which is billing's alone — a plan's own words about what it includes.
 */

/**
 * What a plan includes, in the plan author's words. `className` places the list in its parent:
 * the panel runs it in two columns beside a wide card, the picker in one column down a narrow one.
 */
export function FeatureList({
  features,
  className,
}: {
  features: readonly PublicBillingPlanFeature[];
  className?: string;
}) {
  return (
    <ul className={cn("grid content-start gap-2 text-sm", className)}>
      {features.map((feature) => (
        <li key={feature.key} className="flex items-start gap-2">
          <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span title={feature.tooltip ?? undefined}>{feature.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What a plan includes, as a customer reads it: its own figures first, then the words its author
 * wrote. The figures come from `included`, which the catalog sync flattens out of the validated
 * entitlement template, so the allowance on the page and the allowance enforcement stamps cannot
 * drift apart — a Stripe dashboard edit moves both. null is unlimited, everywhere.
 */
export function planFeatures(plan: PublicBillingPlan): PublicBillingPlanFeature[] {
  const { executionsPerMonth, seats } = plan.included;
  return [
    {
      key: "included-executions",
      label:
        executionsPerMonth === null
          ? "Unlimited agent runs"
          : `${executionsPerMonth} agent runs a month`,
      tooltip: null,
    },
    {
      key: "included-seats",
      // Plain digits, the way the meter and the Usage page write the same numbers.
      label: seats === null ? "Unlimited seats" : `${seats} ${seats === 1 ? "seat" : "seats"}`,
      tooltip: null,
    },
    ...plan.features,
  ];
}

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
    plans.some((plan) => isPaidPrice(priceForInterval(plan, interval))),
  );
  return offered.length === 0 ? ["monthly"] : offered;
}

export function priceForInterval(
  plan: PublicBillingPlan,
  interval: BillingPlanPriceInterval,
): PublicBillingPlanPrice | null {
  return plan.prices.find((price) => price.interval === interval) ?? null;
}
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
  return { amount: formatAmount(price), unit: `per seat / ${words.unit}` };
}

/** A plan a customer pays for, as opposed to Free. */
export function isPaidPrice(price: PublicBillingPlanPrice | null): boolean {
  return price !== null && price.unitAmount > 0;
}

/**
 * The plans there is something to buy in. Free is in the catalog and on the page like any other
 * plan, but it is not a purchase, so the page asks "is there anything here this organization is
 * not already on" through this rather than counting the catalog.
 */
export function purchasablePlans(
  plans: readonly PublicBillingPlan[],
): readonly PublicBillingPlan[] {
  return plans.filter((plan) => plan.prices.some(isPaidPrice));
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
}): PlanAction {
  if (input.isCurrent) {
    return { label: "Current plan", name: `Current plan: ${input.planName}`, disabled: true };
  }
  if (input.price === null) {
    return { label: "Not available", name: `Not available: ${input.planName}`, disabled: true };
  }
  return { label: "Subscribe", name: `Subscribe to ${input.planName}`, disabled: false };
}

export interface SubscriptionSummary {
  /** The plan the organization is on — Free included — or null when it has never been stamped. */
  planName: string | null;
  /** The Stripe status pill. Null when no live subscription exists, which is the normal state
   * for a Free organization and for one whose subscription was cancelled. */
  status: { tone: StatusTone; label: string } | null;
  /** One sentence naming the next thing that will happen to this subscription, or null when
   * there is no subscription and so nothing to say about one. */
  detail: string | null;
}

export function subscriptionSummary(
  subscription: BillingOverviewView["subscription"],
): SubscriptionSummary {
  return {
    planName: subscription.planName,
    status:
      subscription.status === null
        ? null
        : { tone: statusTone(subscription.status), label: statusLabel(subscription.status) },
    detail: subscriptionDetail(subscription),
  };
}

/** The headline for an organization the catalog cannot name a plan for — a mirror that has not
 * synced yet. Never a tier: the plans on the page are the plans there are. */
export const NO_PLAN = "No plan";

/**
 * The one sentence about the subscription's next event. Only a live subscription has one: an
 * organization on Free is not counting down to anything.
 */
function subscriptionDetail(subscription: BillingOverviewView["subscription"]): string | null {
  if (!subscription.manageable) return null;
  if (subscription.cancelAtPeriodEnd && subscription.currentPeriodEnd !== null) {
    return `Cancels on ${formatAbsolute(subscription.currentPeriodEnd)}.`;
  }
  if (subscription.currentPeriodEnd !== null) {
    return `Renews on ${formatAbsolute(subscription.currentPeriodEnd)}.`;
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

function statusTone(status: string): StatusTone {
  if (status === "active" || status === "trialing") return "success";
  if (status === "past_due" || status === "unpaid" || status === "incomplete") return "warning";
  return "neutral";
}
