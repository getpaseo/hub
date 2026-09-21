import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database, SyncBillingPlanInput } from "../db/types.js";
import { composeBilling, type BillingRuntime } from "./index.js";
import type { StripeCatalogSource } from "./stripe-catalog-source.js";
import type { StripeBillingClient, StripeSubscriptionState } from "./stripe-billing-client.js";

/**
 * The public catalog boundary: every active mirrored plan, Free included. Free is the plan a
 * hosted organization lands on and stays on, so the plans endpoint, the billing overview, and the
 * picker all name it. A plan the sync deactivated is the one thing withheld.
 *
 * `included` is the other half of the boundary: the plan's own figures reach a customer, while
 * the entitlement document they were flattened from does not.
 */

const unusedCatalogSource: StripeCatalogSource = {
  listProducts: () => Promise.reject(new Error("unused")),
  listPrices: () => Promise.reject(new Error("unused")),
};
const unusedBillingClient: StripeBillingClient = {
  ensureCustomer: () => Promise.reject(new Error("unused")),
  listCustomerSubscriptions: () => Promise.reject(new Error("unused")),
  createCheckoutSession: () => Promise.reject(new Error("unused")),
  changeSubscriptionPrice: () => Promise.reject(new Error("unused")),
  reportSeatQuantity: () => Promise.reject(new Error("unused")),
  createBillingPortalSession: () => Promise.reject(new Error("unused")),
  getSubscription: (): Promise<StripeSubscriptionState | undefined> =>
    Promise.reject(new Error("unused")),
};

function billingOver(database: Database): BillingRuntime {
  return composeBilling({
    config: { stripeSecretKey: "sk_test_fake", stripeWebhookSecret: "whsec_fake" },
    database,
    catalogSource: unusedCatalogSource,
    billingClient: unusedBillingClient,
    seatUsage: () => Promise.resolve(0),
  });
}

const freePlan: SyncBillingPlanInput = {
  id: "prod_free",
  slug: "free",
  name: "Free",
  template: {
    seats: { max: 1 },
    canInviteMembers: false,
    meters: { "executions.monthly": { limit: 50 } },
  },
  templateHash: "hash-free",
  marketing: {
    included: { seats: 1, executionsPerMonth: 50 },
    features: [{ key: "feature-1", label: "Daemons run on your machines", tooltip: null }],
    priceTooltips: { monthly: null, annual: null },
  },
  active: true,
  prices: [
    {
      id: "price_free_monthly",
      lookupKey: "free_monthly",
      interval: "monthly",
      unitAmount: 0,
      currency: "eur",
      active: true,
    },
  ],
};

const hostedPlan: SyncBillingPlanInput = {
  id: "prod_hosted",
  slug: "hosted",
  name: "Paseo Hub",
  template: {
    seats: { max: null },
    canInviteMembers: true,
    meters: { "executions.monthly": { limit: null } },
  },
  templateHash: "hash-hosted",
  marketing: {
    included: { seats: null, executionsPerMonth: null },
    features: [
      {
        key: "feature-1",
        label: "Unlimited daemons",
        tooltip: "Connect any number of development machines.",
      },
    ],
    priceTooltips: { monthly: "€15 per seat, billed monthly.", annual: null },
  },
  active: true,
  prices: [
    {
      id: "price_hosted_monthly",
      lookupKey: "hosted_monthly",
      interval: "monthly",
      unitAmount: 1500,
      currency: "eur",
      active: true,
    },
  ],
};

describe("BillingRuntime.publicCatalog", () => {
  it("publishes the Free plan alongside the plan a customer pays for", async () => {
    const database = createMemoryDatabase();
    await database.syncBillingPlan(freePlan);
    await database.syncBillingPlan(hostedPlan);

    const catalog = await billingOver(database).publicCatalog();

    assert.deepEqual(
      catalog.map((plan) => plan.slug),
      ["free", "hosted"],
    );
    assert.deepEqual(
      catalog.find((plan) => plan.slug === "free"),
      {
        slug: "free",
        name: "Free",
        billing: { model: "per_unit", unit: { key: "seat", label: "seat" } },
        included: { seats: 1, executionsPerMonth: 50 },
        features: [{ key: "feature-1", label: "Daemons run on your machines", tooltip: null }],
        prices: [
          {
            interval: "monthly",
            intervalCount: 1,
            unitAmount: 0,
            currency: "eur",
            tooltip: null,
          },
        ],
      },
    );
    assert.deepEqual(
      catalog.find((plan) => plan.slug === "hosted"),
      {
        slug: "hosted",
        name: "Paseo Hub",
        billing: {
          model: "per_unit",
          unit: {
            key: "seat",
            label: "seat",
          },
        },
        included: { seats: null, executionsPerMonth: null },
        features: [
          {
            key: "feature-1",
            label: "Unlimited daemons",
            tooltip: "Connect any number of development machines.",
          },
        ],
        prices: [
          {
            interval: "monthly",
            intervalCount: 1,
            unitAmount: 1500,
            currency: "eur",
            tooltip: "€15 per seat, billed monthly.",
          },
        ],
      },
    );
  });

  it("publishes Free on its own when nothing is for sale yet", async () => {
    const database = createMemoryDatabase();
    await database.syncBillingPlan(freePlan);

    assert.deepEqual(
      (await billingOver(database).publicCatalog()).map((plan) => plan.slug),
      ["free"],
    );
  });

  it("withholds a plan the catalog sync deactivated", async () => {
    const database = createMemoryDatabase();
    await database.syncBillingPlan({ ...hostedPlan, active: false });

    assert.deepEqual(await billingOver(database).publicCatalog(), []);
  });

  it("carries the plan's numbers but never the template they came from", async () => {
    const database = createMemoryDatabase();
    await database.syncBillingPlan(freePlan);

    const [plan] = await billingOver(database).publicCatalog();

    assert.notEqual(plan, undefined);
    assert.deepEqual(Object.keys(plan!).sort(), [
      "billing",
      "features",
      "included",
      "name",
      "prices",
      "slug",
    ]);
    // What a customer may know: the figures. Not the document enforcement reads.
    assert.deepEqual(plan?.included, { seats: 1, executionsPerMonth: 50 });
    assert.equal(Reflect.get(plan, "template"), undefined);
    assert.equal(Reflect.get(plan, "meters"), undefined);
  });

  it("prices an interval only from its exact lookup key, so a mismatched price reads unavailable", async () => {
    const database = createMemoryDatabase();
    await database.syncBillingPlan({
      ...hostedPlan,
      prices: [
        {
          id: "price_legacy",
          lookupKey: "hub_monthly",
          interval: "monthly",
          unitAmount: 900,
          currency: "eur",
          active: true,
        },
      ],
    });

    const [plan] = await billingOver(database).publicCatalog();

    assert.deepEqual(plan?.prices, []);
  });
});
