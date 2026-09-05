import { z } from "zod";
import { reportFailure } from "../failures/index.js";
import type { BillingPlanPriceInterval, BillingPlanRecord } from "../db/types.js";
import { selectActivePlanPrice } from "./plan-prices.js";

/**
 * The public plan catalog: name, slug, prices by interval, marketing bullets. The entitlement
 * template never crosses this boundary — see the plan's public plans endpoint section.
 */
export interface PublicBillingPlan {
  slug: string;
  name: string;
  billing: {
    model: "per_unit";
    unit: {
      key: "seat";
      label: "seat";
    };
  };
  features: readonly PublicBillingPlanFeature[];
  prices: readonly PublicBillingPlanPrice[];
}

export interface PublicBillingPlanFeature {
  key: string;
  label: string;
  tooltip: string | null;
}

export interface PublicBillingPlanPrice {
  interval: BillingPlanPriceInterval;
  intervalCount: 1;
  unitAmount: number;
  currency: string;
  tooltip: string | null;
}

const billingPlanMarketingSchema = z.object({
  features: z.array(
    z.object({ key: z.string(), label: z.string(), tooltip: z.string().nullable() }),
  ),
  priceTooltips: z.object({ monthly: z.string().nullable(), annual: z.string().nullable() }),
});

const SEAT_BILLING: PublicBillingPlan["billing"] = {
  model: "per_unit",
  unit: {
    key: "seat",
    label: "seat",
  },
};

/**
 * Turns the catalog mirror into the plans a customer may buy. Two things are withheld: a plan the
 * sync deactivated, and `excludeSlug` — the internal entitlement record (see `FREE_PLAN_SLUG`),
 * which exists so provisioning and cancellation have a template to stamp, not so anyone can
 * purchase it. Withholding it here is what lets every consumer treat "the catalog" as "the offer".
 */
export function publicBillingPlans(
  records: readonly BillingPlanRecord[],
  excludeSlug: string,
): PublicBillingPlan[] {
  return records
    .filter((record) => record.active && record.slug !== excludeSlug)
    .map(publicBillingPlan);
}

function publicBillingPlan(record: BillingPlanRecord): PublicBillingPlan {
  const marketing = billingPlanMarketingSchema.parse(record.marketing);
  return {
    slug: record.slug,
    name: record.name,
    billing: SEAT_BILLING,
    features: marketing.features,
    prices: (["monthly", "annual"] as const).flatMap((interval) => {
      const price = activePriceForInterval(record, interval, marketing.priceTooltips[interval]);
      return price === null ? [] : [price];
    }),
  };
}

function activePriceForInterval(
  record: BillingPlanRecord,
  interval: BillingPlanPriceInterval,
  tooltip: string | null,
): PublicBillingPlanPrice | null {
  // Exact `{slug}_{interval}` lookup-key identity, matching checkout. Ambiguous pricing (two active
  // prices for one key) is surfaced as "unavailable" and logged, never displayed as an arbitrary
  // amount the customer might not be charged.
  try {
    const price = selectActivePlanPrice(record.prices, record.slug, interval);
    return price === undefined
      ? null
      : {
          interval,
          intervalCount: 1,
          unitAmount: price.unitAmount,
          currency: price.currency,
          tooltip,
        };
  } catch (error) {
    reportFailure(
      error,
      { operation: "billing.catalog.price.select", component: "billing", provider: "stripe" },
      { kind: "conflict", diagnostic: { planSlug: record.slug, interval } },
    );
    return null;
  }
}
