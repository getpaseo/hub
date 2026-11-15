import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { composeBilling, type BillingRuntime } from "./index.js";
import type { StripeCatalogSource } from "./stripe-catalog-source.js";
import type { StripeBillingClient, StripeSubscriptionState } from "./stripe-billing-client.js";

// What the operator console reads beside an organization. Plan and customer are Hub's own records;
// only the live subscription comes from Stripe, so only it may go missing when Stripe does.

const ORGANIZATION = "org_1";
const CUSTOMER = "cus_123";

const unusedCatalogSource: StripeCatalogSource = {
  listProducts: () => Promise.reject(new Error("unused")),
  listPrices: () => Promise.reject(new Error("unused")),
};

function clientListing(
  listCustomerSubscriptions: StripeBillingClient["listCustomerSubscriptions"],
): StripeBillingClient {
  return {
    ensureCustomer: () => Promise.reject(new Error("unused")),
    listCustomerSubscriptions,
    createCheckoutSession: () => Promise.reject(new Error("unused")),
    changeSubscriptionPrice: () => Promise.reject(new Error("unused")),
    reportSeatQuantity: () => Promise.reject(new Error("unused")),
    createBillingPortalSession: () => Promise.reject(new Error("unused")),
    getSubscription: () => Promise.reject(new Error("unused")),
  };
}

async function billingWithCustomer(client: StripeBillingClient): Promise<BillingRuntime> {
  const database = createMemoryDatabase();
  await database.reconcileOrganizationBilling({
    organizationId: ORGANIZATION,
    stripeCustomerId: CUSTOMER,
  });
  return composeBilling({
    config: { stripeSecretKey: "sk_test_fake", stripeWebhookSecret: "whsec_fake" },
    database,
    catalogSource: unusedCatalogSource,
    billingClient: client,
    seatUsage: () => Promise.resolve(0),
  });
}

describe("BillingRuntime.operatorBilling", () => {
  it("keeps the Stripe customer and marks only the subscription unavailable when Stripe fails", async () => {
    const billing = await billingWithCustomer(
      clientListing(() => Promise.reject(new Error("stripe unreachable"))),
    );

    const view = await billing.operatorBilling(ORGANIZATION);

    assert.equal(view.stripeCustomerId, CUSTOMER);
    assert.deepEqual(view.subscription, { kind: "unavailable" });
  });

  it("marks the subscription unavailable when Stripe does not answer in time", async () => {
    vi.useFakeTimers();
    try {
      const billing = await billingWithCustomer(clientListing(() => new Promise(() => undefined)));

      const pending = billing.operatorBilling(ORGANIZATION);
      await vi.advanceTimersByTimeAsync(5_000);
      const view = await pending;

      assert.equal(view.stripeCustomerId, CUSTOMER);
      assert.deepEqual(view.subscription, { kind: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the live subscription from Stripe when it answers", async () => {
    const subscription: StripeSubscriptionState = {
      id: "sub_1",
      customerId: CUSTOMER,
      organizationId: ORGANIZATION,
      priceId: "price_1",
      quantity: 1,
      status: "active",
      currentPeriodEnd: new Date("2026-12-01T00:00:00.000Z"),
      cancelAtPeriodEnd: true,
    };
    const billing = await billingWithCustomer(clientListing(() => Promise.resolve([subscription])));

    const view = await billing.operatorBilling(ORGANIZATION);

    assert.deepEqual(view.subscription, {
      kind: "loaded",
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: "2026-12-01T00:00:00.000Z",
    });
  });

  it("has no subscription to read for an organization that never subscribed", async () => {
    const billing = composeBilling({
      config: { stripeSecretKey: "sk_test_fake", stripeWebhookSecret: "whsec_fake" },
      database: createMemoryDatabase(),
      catalogSource: unusedCatalogSource,
      billingClient: clientListing(() => Promise.reject(new Error("must not be called"))),
      seatUsage: () => Promise.resolve(0),
    });

    const view = await billing.operatorBilling(ORGANIZATION);

    assert.equal(view.stripeCustomerId, null);
    assert.deepEqual(view.subscription, {
      kind: "loaded",
      status: null,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    });
  });
});
