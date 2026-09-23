import { z } from "zod";
import { reportFailure } from "../failures/index.js";
import type { BillingPlanPriceInterval, BillingPlanRecord } from "../db/types.js";
import { selectActivePlanPrice } from "./plan-prices.js";

/**
 * The public plan catalog: name, slug, prices by interval, marketing bullets. The entitlement
 * template never crosses this boundary — a plan's allowance is enforced from the stamp and read
 * on the Usage page, never advertised from here.
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
  /** What the plan includes, as figures: the seat cap and the monthly execution allowance, with
   * null meaning unlimited. These are the numbers a customer is shown, and they are the numbers
   * enforcement stamps — both come from the one template, flattened by the catalog sync. */
  included: PublicBillingPlanIncluded;
  features: readonly PublicBillingPlanFeature[];
  prices: readonly PublicBillingPlanPrice[];
}

export interface PublicBillingPlanIncluded {
  seats: number | null;
  executionsPerMonth: number | null;
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

/** The mirrored presentation record, which the catalog sync is the only writer of. Parsed
 * strictly: every sync rewrites it for every product, so a field added here lands on the next
 * boot or product webhook rather than needing a migration. */
const billingPlanMarketingSchema = z.object({
  included: z.object({
    seats: z.number().int().nonnegative().nullable(),
    executionsPerMonth: z.number().int().nonnegative().nullable(),
  }),
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
 * Turns the catalog mirror into the plans Hub offers, Free included — it is the plan a hosted
 * organization lands on, so every consumer names it. The one thing withheld is a plan the sync
 * deactivated, which stops being selectable rather than lingering in the offer.
 */
export function publicBillingPlans(records: readonly BillingPlanRecord[]): PublicBillingPlan[] {
  return records.filter((record) => record.active).map(publicBillingPlan);
}

function publicBillingPlan(record: BillingPlanRecord): PublicBillingPlan {
  const marketing = billingPlanMarketingSchema.parse(record.marketing);
  return {
    slug: record.slug,
    name: record.name,
    billing: SEAT_BILLING,
    included: marketing.included,
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
