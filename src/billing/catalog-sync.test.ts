import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "vitest";
import { z } from "zod";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import { hashTemplate } from "../entitlements/catalog.js";
import { runWithFailureTracking } from "../failures/index.js";
import { createLogger } from "../logger.js";
import { syncBillingCatalog as syncBillingCatalogWithPresentations } from "./catalog-sync.js";
import type { BillingPlanPresentations } from "./plan-presentation.js";
import type {
  StripeCatalogPrice,
  StripeCatalogProduct,
  StripeCatalogSource,
} from "./stripe-catalog-source.js";

class FakeCatalogSource implements StripeCatalogSource {
  constructor(
    private products: StripeCatalogProduct[],
    private readonly prices: StripeCatalogPrice[] = [],
  ) {}

  async listProducts(): Promise<StripeCatalogProduct[]> {
    return this.products;
  }

  async listPrices(): Promise<StripeCatalogPrice[]> {
    return this.prices;
  }

  setProducts(products: StripeCatalogProduct[]): void {
    this.products = products;
  }
}

function soloProduct(overrides: Partial<StripeCatalogProduct> = {}): StripeCatalogProduct {
  return {
    id: "prod_solo",
    name: "Solo",
    active: true,
    metadata: {
      paseo_plan: "true",
      paseo_plan_slug: "solo",
      ent_seats_max: "5",
      ent_can_invite: "true",
      ent_executions_monthly_limit: "2000",
    },
    ...overrides,
  };
}

function soloPrices(): StripeCatalogPrice[] {
  return [
    {
      id: "price_solo_monthly",
      productId: "prod_solo",
      lookupKey: "solo_monthly",
      active: true,
      currency: "usd",
      unitAmount: 2900,
      interval: "month",
    },
    {
      id: "price_solo_annual",
      productId: "prod_solo",
      lookupKey: "solo_annual",
      active: true,
      currency: "usd",
      unitAmount: 29000,
      interval: "year",
    },
  ];
}

const TEST_PLAN_PRESENTATIONS: BillingPlanPresentations = {
  solo: {
    name: "Solo",
    features: [
      {
        key: "feature-1",
        label: "Daemons run on your machines",
        tooltip: "Connect any number of development machines.",
      },
    ],
    priceTooltips: { monthly: "Billed monthly for each seat.", annual: null },
  },
};

function syncBillingCatalog(source: StripeCatalogSource, database: Database): Promise<void> {
  return syncBillingCatalogWithPresentations(source, database, TEST_PLAN_PRESENTATIONS);
}

describe("syncBillingCatalog", () => {
  it("owns invalid catalog failures with structured, secret-free background diagnostics", async () => {
    const canary = "formatless-catalog-secret-83bd2f99";
    const stream = new CaptureStream();
    const database = createMemoryDatabase();
    const source = new FakeCatalogSource([
      soloProduct({
        name: canary,
        metadata: { ...soloProduct().metadata, ent_seats_max: canary },
      }),
    ]);

    await runWithFailureTracking(() => syncBillingCatalog(source, database), createLogger(stream));

    const records = stream.records();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.["operation"], "billing.catalog.product.validate");
    assert.equal(records[0]?.["component"], "billing");
    assert.equal(records[0]?.["provider"], "stripe");
    const error = logRecordSchema.parse(records[0]?.["err"]);
    assert.equal(error["type"], "Error");
    assert.equal(typeof error["stack"], "string");
    assert.equal(stream.text().includes(canary), false);
  });

  it("mirrors a valid product and its prices into the local catalog", async () => {
    const database = createMemoryDatabase();
    const source = new FakeCatalogSource([soloProduct()], soloPrices());
    await syncBillingCatalog(source, database);

    const [plan] = await database.listBillingPlans();
    assert.ok(plan);
    assert.equal(plan.id, "prod_solo");
    assert.equal(plan.slug, "solo");
    assert.equal(plan.name, "Solo");
    assert.equal(plan.active, true);
    // The plan's figures are flattened out of the validated template once, here, so the public
    // catalog can state them without ever reading the template.
    assert.deepEqual(plan.marketing, {
      included: { seats: 5, executionsPerMonth: 2000 },
      features: [
        {
          key: "feature-1",
          label: "Daemons run on your machines",
          tooltip: "Connect any number of development machines.",
        },
      ],
      priceTooltips: { monthly: "Billed monthly for each seat.", annual: null },
    });
    assert.equal(
      plan.templateHash,
      hashTemplate({
        seats: { max: 5 },
        canInviteMembers: true,
        meters: { "executions.monthly": { limit: 2000 } },
      }),
    );
    assert.equal(plan.prices.length, 2);
    const monthly = plan.prices.find((price) => price.interval === "monthly");
    assert.equal(monthly?.unitAmount, 2900);
    assert.equal(monthly?.lookupKey, "solo_monthly");
  });

  it("rejects a product with invalid metadata and keeps the last known good row", async () => {
    const database = createMemoryDatabase();
    const source = new FakeCatalogSource([soloProduct()], soloPrices());
    await syncBillingCatalog(source, database);
    const [before] = await database.listBillingPlans();
    assert.ok(before);

    source.setProducts([
      soloProduct({ metadata: { ...soloProduct().metadata, ent_seats_max: "not-a-number" } }),
    ]);
    await syncBillingCatalog(source, database);

    const [after] = await database.listBillingPlans();
    assert.deepEqual(after, before);
  });

  it("skips a price without a lookup key without rejecting the whole product", async () => {
    const database = createMemoryDatabase();
    const source = new FakeCatalogSource(
      [soloProduct()],
      [
        ...soloPrices(),
        {
          id: "price_no_key",
          productId: "prod_solo",
          lookupKey: null,
          active: true,
          currency: "usd",
          unitAmount: 100,
          interval: "month",
        },
      ],
    );
    await syncBillingCatalog(source, database);

    const [plan] = await database.listBillingPlans();
    assert.equal(plan?.prices.length, 2);
  });

  it("resyncing with the same catalog leaves the mirrored row equivalent", async () => {
    const database = createMemoryDatabase();
    const source = new FakeCatalogSource([soloProduct()], soloPrices());
    await syncBillingCatalog(source, database);
    await syncBillingCatalog(source, database);

    const plans = await database.listBillingPlans();
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.prices.length, 2);
  });

  it("deactivates a plan whose product left the catalog", async () => {
    const database = createMemoryDatabase();
    const source = new FakeCatalogSource([soloProduct()], soloPrices());
    await syncBillingCatalog(source, database);
    assert.equal((await database.listBillingPlans())[0]?.active, true);

    // The product lost its paseo_plan tag or was deleted: the snapshot no longer contains it.
    source.setProducts([]);
    await syncBillingCatalog(source, database);

    const [plan] = await database.listBillingPlans();
    assert.equal(plan?.id, "prod_solo"); // still mirrored, so it can reactivate later
    assert.equal(plan?.active, false); // but no longer selectable
  });

  it("rejects both products when two claim the same plan slug", async () => {
    const database = createMemoryDatabase();
    const source = new FakeCatalogSource(
      [soloProduct(), soloProduct({ id: "prod_solo_dupe", name: "Solo Duplicate" })],
      soloPrices(),
    );
    await syncBillingCatalog(source, database);

    // Ambiguous identity: neither product is synced rather than an arbitrary winner.
    assert.equal((await database.listBillingPlans()).length, 0);
  });

  it("re-stamps every organization on a plan whose template changed, and leaves overrides alone", async () => {
    const database = createMemoryDatabase();
    const source = new FakeCatalogSource([soloProduct()], soloPrices());
    await syncBillingCatalog(source, database);
    const [plan] = await database.listBillingPlans();
    assert.ok(plan);
    // Two organizations stamped from the plan as it stood, one of them with a hand-set override.
    for (const organizationId of ["org-1", "org-2"]) {
      await database.stampOrganizationEntitlements({
        organizationId,
        granted: plan.template,
        planId: plan.id,
        planVersion: plan.templateHash,
        source: "provisioning",
        actor: null,
        reason: null,
      });
    }
    await database.overrideOrganizationEntitlements({
      organizationId: "org-2",
      patch: { meters: { "executions.monthly": { limit: 9000 } } },
      actor: "operator-1",
      reason: "Pilot allowance",
    });

    // The dashboard edit: the same product, a larger monthly allowance.
    source.setProducts([
      soloProduct({
        metadata: { ...soloProduct().metadata, ent_executions_monthly_limit: "3000" },
      }),
    ]);
    await syncBillingCatalog(source, database);

    const raised = hashTemplate({
      seats: { max: 5 },
      canInviteMembers: true,
      meters: { "executions.monthly": { limit: 3000 } },
    });
    for (const organizationId of ["org-1", "org-2"]) {
      const row = await database.getOrganizationEntitlements(organizationId);
      assert.equal(row?.planVersion, raised);
      assert.deepEqual(row?.granted, {
        seats: { max: 5 },
        canInviteMembers: true,
        meters: { "executions.monthly": { limit: 3000 } },
      });
    }
    // The hand-set deal survives the re-stamp untouched.
    assert.deepEqual(
      await database.getOrganizationEntitlements("org-2").then((row) => row?.overrides),
      {
        meters: { "executions.monthly": { limit: 9000 } },
      },
    );
  });

  it("leaves an organization on another plan alone when a template changes", async () => {
    const database = createMemoryDatabase();
    const source = new FakeCatalogSource([soloProduct()], soloPrices());
    await syncBillingCatalog(source, database);
    const [plan] = await database.listBillingPlans();
    assert.ok(plan);
    await database.stampOrganizationEntitlements({
      organizationId: "org-elsewhere",
      granted: {
        seats: { max: 1 },
        canInviteMembers: false,
        meters: { "executions.monthly": { limit: 50 } },
      },
      planId: "prod_other",
      planVersion: "hash-other",
      source: "plan_stamp",
      actor: null,
      reason: null,
    });

    source.setProducts([
      soloProduct({
        metadata: { ...soloProduct().metadata, ent_executions_monthly_limit: "3000" },
      }),
    ]);
    await syncBillingCatalog(source, database);

    const row = await database.getOrganizationEntitlements("org-elsewhere");
    assert.equal(row?.planVersion, "hash-other");
    assert.equal((await database.listEntitlementChanges("org-elsewhere", 10)).length, 1);
  });

  it("re-stamps once: a resync with an unchanged template writes no second audit row", async () => {
    const database = createMemoryDatabase();
    const source = new FakeCatalogSource([soloProduct()], soloPrices());
    await syncBillingCatalog(source, database);
    const [plan] = await database.listBillingPlans();
    assert.ok(plan);
    await database.stampOrganizationEntitlements({
      organizationId: "org-1",
      granted: plan.template,
      planId: plan.id,
      planVersion: plan.templateHash,
      source: "provisioning",
      actor: null,
      reason: null,
    });

    await syncBillingCatalog(source, database);
    await syncBillingCatalog(source, database);

    assert.equal((await database.listEntitlementChanges("org-1", 10)).length, 1);
  });

  it("keeps the last known good row when a later sync introduces a duplicate slug", async () => {
    const database = createMemoryDatabase();
    const source = new FakeCatalogSource([soloProduct()], soloPrices());
    await syncBillingCatalog(source, database);
    const [before] = await database.listBillingPlans();
    assert.ok(before);

    source.setProducts([soloProduct(), soloProduct({ id: "prod_solo_dupe" })]);
    await syncBillingCatalog(source, database);

    const [after] = await database.listBillingPlans();
    assert.deepEqual(after, before);
  });
});

class CaptureStream extends Writable {
  private readonly chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }

  records(): Record<string, unknown>[] {
    return this.text()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => logRecordSchema.parse(JSON.parse(line)));
  }
}

const logRecordSchema = z.record(z.string(), z.unknown());
