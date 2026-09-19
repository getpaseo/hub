import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "vitest";
import { z } from "zod";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database, SyncBillingPlanInput } from "../db/types.js";
import type { EntitlementTemplate } from "../entitlements/catalog.js";
import { runWithFailureTracking } from "../failures/index.js";
import { createLogger } from "../logger.js";
import { FailureLogStream } from "../test-utils/failure-logs.js";
import { composeBilling, type BillingRuntime } from "./index.js";
import type { StripeCatalogSource } from "./stripe-catalog-source.js";
import type {
  CreateTrialSubscriptionInput,
  StripeBillingClient,
  StripeSubscriptionState,
} from "./stripe-billing-client.js";

const WEBHOOK_SECRET = "whsec_trial_test";
const FLOOR = {
  seats: { max: 1 },
  canInviteMembers: false,
  meters: { "executions.monthly": { limit: 0 } },
};
const TRIAL_TEMPLATE = {
  seats: { max: null },
  canInviteMembers: true,
  meters: { "executions.monthly": { limit: 2_000 } },
};

const unusedCatalogSource: StripeCatalogSource = {
  listProducts: () => Promise.reject(new Error("unused")),
  listPrices: () => Promise.reject(new Error("unused")),
};

class TrialBillingClient implements StripeBillingClient {
  readonly subscriptions = new Map<string, StripeSubscriptionState>();
  readonly created: CreateTrialSubscriptionInput[] = [];
  throwOnCreate = false;

  async ensureCustomer(input: { organizationId: string }): Promise<string> {
    return `cus_${input.organizationId}`;
  }

  async listCustomerSubscriptions(customerId: string): Promise<readonly StripeSubscriptionState[]> {
    return [...this.subscriptions.values()].filter(
      (subscription) => subscription.customerId === customerId,
    );
  }

  async createTrialSubscription(input: CreateTrialSubscriptionInput): Promise<string> {
    if (this.throwOnCreate) throw new Error("Stripe unavailable");
    this.created.push(input);
    const id = `sub_${input.organizationId}`;
    this.subscriptions.set(id, {
      id,
      customerId: input.customerId,
      organizationId: input.organizationId,
      priceId: input.priceId,
      quantity: input.quantity,
      status: "trialing",
      currentPeriodEnd: new Date("2030-01-15T00:00:00Z"),
      trialEnd: new Date("2030-01-15T00:00:00Z"),
      cancelAtPeriodEnd: false,
    });
    return id;
  }

  async createCheckoutSession(): Promise<{ url: string }> {
    throw new Error("unused");
  }
  async changeSubscriptionPrice(): Promise<void> {
    throw new Error("unused");
  }
  async reportSeatQuantity(): Promise<void> {}
  async createBillingPortalSession(): Promise<{ url: string }> {
    throw new Error("unused");
  }
  async getSubscription(subscriptionId: string): Promise<StripeSubscriptionState | undefined> {
    return this.subscriptions.get(subscriptionId);
  }
}

function plan(
  id: string,
  slug: string,
  template: EntitlementTemplate = TRIAL_TEMPLATE,
): SyncBillingPlanInput {
  return {
    id,
    slug,
    name: slug === "hub" ? "Paseo Hub" : slug,
    template,
    templateHash: `hash-${slug}`,
    marketing: { features: [], priceTooltips: { monthly: null, annual: null } },
    active: true,
    prices: [
      {
        id: `price_${slug}_monthly`,
        lookupKey: `${slug}_monthly`,
        interval: "monthly",
        unitAmount: 2_900,
        currency: "eur",
        active: true,
      },
    ],
  };
}

async function setup(
  publicPlans = [plan("prod_hub", "hub")],
): Promise<{ database: Database; client: TrialBillingClient; billing: BillingRuntime }> {
  const database = createMemoryDatabase();
  await database.syncBillingPlan(plan("prod_free", "free", FLOOR));
  for (const publicPlan of publicPlans) await database.syncBillingPlan(publicPlan);
  await database.stampOrganizationEntitlements({
    organizationId: "org_1",
    granted: FLOOR,
    planId: "prod_free",
    planVersion: "floor",
    source: "provisioning",
    actor: null,
    reason: null,
  });
  const client = new TrialBillingClient();
  return {
    database,
    client,
    billing: composeBilling({
      config: { stripeSecretKey: "sk_test_fake", stripeWebhookSecret: WEBHOOK_SECRET },
      database,
      catalogSource: unusedCatalogSource,
      billingClient: client,
      seatUsage: () => Promise.resolve(1),
    }),
  };
}

function subscriptionWebhook(subscriptionId: string): Request {
  const payload = JSON.stringify({
    id: `evt_${subscriptionId}`,
    type: "customer.subscription.created",
    data: { object: { id: subscriptionId, object: "subscription" } },
  });
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return new Request("http://hub.test/api/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
    body: payload,
  });
}

describe("BillingRuntime.startTrial", () => {
  it("dispatches the trial signup intent to the cardless trial", async () => {
    const { client, billing } = await setup();

    await billing.startSignup({
      intent: "trial",
      organizationId: "org_1",
      accountEmail: "owner@example.com",
      accountName: "Owner",
    });

    assert.equal(client.created.length, 1);
    assert.equal(client.created[0]?.organizationId, "org_1");
  });

  it("creates and synchronously stamps a trial, with a replaying webhook as a no-op", async () => {
    const { database, client, billing } = await setup();

    await billing.startTrial({
      organizationId: "org_1",
      accountEmail: "owner@example.com",
      accountName: "Owner",
    });

    assert.deepEqual(client.created, [
      {
        organizationId: "org_1",
        customerId: "cus_org_1",
        priceId: "price_hub_monthly",
        quantity: 1,
      },
    ]);
    assert.equal(
      (await database.getOrganizationBillingCustomer("org_1"))?.stripeCustomerId,
      "cus_org_1",
    );
    const stamped = await database.getOrganizationEntitlements("org_1");
    assert.equal(stamped?.planId, "prod_hub");
    assert.deepEqual(stamped?.granted, TRIAL_TEMPLATE);
    const changes = await database.listEntitlementChanges("org_1", 10);
    assert.equal(changes.length, 2);
    assert.equal(changes[0]?.source, "plan_stamp");

    const response = await billing.handleWebhook(subscriptionWebhook("sub_org_1"));
    assert.equal(response.status, 200);
    assert.equal((await database.listEntitlementChanges("org_1", 10)).length, 2);
  });

  it("does nothing when the organization already has any subscription", async () => {
    const { client, billing } = await setup();
    client.subscriptions.set("sub_old", {
      id: "sub_old",
      customerId: "cus_org_1",
      organizationId: "org_1",
      priceId: "price_hub_monthly",
      quantity: 1,
      status: "canceled",
      currentPeriodEnd: null,
      trialEnd: null,
      cancelAtPeriodEnd: false,
    });

    await billing.startTrial({ organizationId: "org_1", accountEmail: null, accountName: null });

    assert.equal(client.created.length, 0);
  });

  for (const [label, plans] of [
    ["zero", []],
    ["more than one", [plan("prod_hub", "hub"), plan("prod_team", "team")]],
  ] as const) {
    it(`leaves the floor and reports a failure with ${label} public plans`, async () => {
      const { database, client, billing } = await setup([...plans]);
      const logs = new FailureLogStream();

      await runWithFailureTracking(
        () =>
          billing.startTrial({ organizationId: "org_1", accountEmail: null, accountName: null }),
        createLogger(logs),
      );

      assert.equal(client.created.length, 0);
      assert.equal((await database.getOrganizationEntitlements("org_1"))?.planId, "prod_free");
      const [record] = logs.records();
      assert.equal(record?.["operation"], "billing.trial.start");
      assert.equal(
        z.object({ code: z.string() }).parse(record?.["err"]).code,
        "billing_trial_start_failed",
      );
    });
  }

  it("leaves the floor and never throws when Stripe creation fails", async () => {
    const { database, client, billing } = await setup();
    client.throwOnCreate = true;

    await billing.startTrial({ organizationId: "org_1", accountEmail: null, accountName: null });

    assert.equal((await database.getOrganizationEntitlements("org_1"))?.planId, "prod_free");
    assert.equal((await database.listEntitlementChanges("org_1", 10)).length, 1);
  });
});
