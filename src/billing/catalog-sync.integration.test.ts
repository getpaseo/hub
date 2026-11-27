import assert from "node:assert/strict";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createDatabase } from "../db/pg.js";
import { postgresDatabaseRuntime } from "../db/runtime/index.js";
import { syncBillingCatalog } from "./catalog-sync.js";
import type { BillingPlanPresentations } from "./plan-presentation.js";
import type {
  StripeCatalogPrice,
  StripeCatalogProduct,
  StripeCatalogSource,
} from "./stripe-catalog-source.js";

const TEST_PRESENTATIONS: BillingPlanPresentations = {
  solo: {
    name: "Solo",
    features: [{ key: "f1", label: "Solo feature", tooltip: null }],
    priceTooltips: { monthly: null, annual: null },
  },
  team: {
    name: "Team",
    features: [{ key: "f2", label: "Team feature", tooltip: null }],
    priceTooltips: { monthly: null, annual: null },
  },
};

function makeProducts(): StripeCatalogProduct[] {
  return [
    {
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
    },
    {
      id: "prod_team",
      name: "Team",
      active: true,
      metadata: {
        paseo_plan: "true",
        paseo_plan_slug: "team",
        ent_seats_max: "20",
        ent_can_invite: "true",
        ent_executions_monthly_limit: "10000",
      },
    },
  ];
}

function makePrices(): StripeCatalogPrice[] {
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
    {
      id: "price_team_monthly",
      productId: "prod_team",
      lookupKey: "team_monthly",
      active: true,
      currency: "usd",
      unitAmount: 9900,
      interval: "month",
    },
    {
      id: "price_team_annual",
      productId: "prod_team",
      lookupKey: "team_annual",
      active: true,
      currency: "usd",
      unitAmount: 99000,
      interval: "year",
    },
  ];
}

describe("syncBillingCatalog concurrent overlap on Postgres", () => {
  let postgres: StartedPostgreSqlContainer;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  }, 120_000);

  it("serializes concurrent catalog syncs across machines without unique violations or deadlocks", async () => {
    const url = new URL(postgres.getConnectionUri());
    url.pathname = "/billing_catalog_overlap_test";
    const machineA = await postgresDatabaseRuntime(url.toString());
    await machineA.runtime.migrate();
    const machineB = await postgresDatabaseRuntime(url.toString());
    const dbA = createDatabase(machineA.runtime, machineA.locks);
    const dbB = createDatabase(machineB.runtime, machineB.locks);
    const source: StripeCatalogSource = {
      listProducts: async () => makeProducts(),
      listPrices: async () => makePrices(),
    };
    try {
      // Deterministic serialization check: Machine B must wait while Machine A holds the lock.
      let enteredFirst!: () => void;
      const firstEntered = new Promise<void>((resolve) => (enteredFirst = resolve));
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
      const events: string[] = [];
      const gatedSourceA: StripeCatalogSource = {
        listProducts: async () => {
          events.push("A:start");
          enteredFirst();
          await firstGate;
          events.push("A:end");
          return makeProducts();
        },
        listPrices: async () => makePrices(),
      };
      const sourceB: StripeCatalogSource = {
        listProducts: async () => {
          events.push("B:start");
          return makeProducts();
        },
        listPrices: async () => makePrices(),
      };
      const firstSync = syncBillingCatalog(gatedSourceA, dbA, TEST_PRESENTATIONS);
      await firstEntered;
      const secondSync = syncBillingCatalog(sourceB, dbB, TEST_PRESENTATIONS);
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(events, ["A:start"]);
      releaseFirst();
      await Promise.all([firstSync, secondSync]);
      assert.deepEqual(events, ["A:start", "A:end", "B:start"]);

      for (let round = 0; round < 5; round += 1) {
        await Promise.all([
          syncBillingCatalog(source, dbA, TEST_PRESENTATIONS),
          syncBillingCatalog(source, dbB, TEST_PRESENTATIONS),
        ]);
      }
      const plans = await dbA.listBillingPlans();
      assert.equal(plans.length, 2);
      const priceIds: string[] = [];
      for (const plan of plans) {
        for (const price of plan.prices) priceIds.push(price.id);
      }
      assert.deepEqual(priceIds.sort(), [
        "price_solo_annual",
        "price_solo_monthly",
        "price_team_annual",
        "price_team_monthly",
      ]);
    } finally {
      await Promise.allSettled([machineA.runtime.close(), machineB.runtime.close()]);
    }
  }, 120_000);
});
