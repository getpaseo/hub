/**
 * The E2E fixture for the Stripe plan catalog. Structurally matches `StripeCatalogSource` from
 * `src/billing/stripe-catalog-source.ts` without importing it — only `browser-child.ts` (this
 * harness's composition root, exempted the same way `src/index.ts` is) needs that import, so
 * the fixture itself stays outside the billing boundary. See the plan's "Testing Stripe"
 * section: no Stripe account, no network, fixtures only.
 */
export interface FixtureBillingProduct {
  id: string;
  name: string;
  active: boolean;
  metadata: Record<string, string>;
  marketingFeatures: string[];
}

export interface FixtureBillingPrice {
  id: string;
  productId: string;
  lookupKey: string | null;
  active: boolean;
  currency: string;
  unitAmount: number | null;
  interval: "month" | "year" | null;
}

export const FIXTURE_BILLING_PRODUCTS: readonly FixtureBillingProduct[] = [
  {
    id: "prod_fixture_free",
    name: "Free",
    active: true,
    metadata: {
      paseo_plan: "true",
      paseo_plan_slug: "free",
      ent_seats_max: "1",
      ent_can_invite: "false",
      ent_executions_monthly_limit: "100",
    },
    marketingFeatures: ["1 seat", "100 executions / month", "Community support"],
  },
  {
    id: "prod_fixture_solo",
    name: "Solo",
    active: true,
    metadata: {
      paseo_plan: "true",
      paseo_plan_slug: "solo",
      ent_seats_max: "unlimited",
      ent_can_invite: "true",
      ent_executions_monthly_limit: "2000",
    },
    marketingFeatures: ["Unlimited seats", "2,000 executions / month", "Email support"],
  },
  {
    id: "prod_fixture_team",
    name: "Team",
    active: true,
    metadata: {
      paseo_plan: "true",
      paseo_plan_slug: "team",
      ent_seats_max: "unlimited",
      ent_can_invite: "true",
      ent_executions_monthly_limit: "unlimited",
    },
    marketingFeatures: ["Unlimited seats", "Unlimited executions", "Priority support"],
  },
];

export const FIXTURE_BILLING_PRICES: readonly FixtureBillingPrice[] = [
  {
    id: "price_fixture_free_monthly",
    productId: "prod_fixture_free",
    lookupKey: "free_monthly",
    active: true,
    currency: "usd",
    unitAmount: 0,
    interval: "month",
  },
  {
    id: "price_fixture_free_annual",
    productId: "prod_fixture_free",
    lookupKey: "free_annual",
    active: true,
    currency: "usd",
    unitAmount: 0,
    interval: "year",
  },
  {
    id: "price_fixture_solo_monthly",
    productId: "prod_fixture_solo",
    lookupKey: "solo_monthly",
    active: true,
    currency: "usd",
    unitAmount: 2900,
    interval: "month",
  },
  {
    id: "price_fixture_solo_annual",
    productId: "prod_fixture_solo",
    lookupKey: "solo_annual",
    active: true,
    currency: "usd",
    unitAmount: 29000,
    interval: "year",
  },
  {
    id: "price_fixture_team_monthly",
    productId: "prod_fixture_team",
    lookupKey: "team_monthly",
    active: true,
    currency: "usd",
    unitAmount: 9900,
    interval: "month",
  },
  {
    id: "price_fixture_team_annual",
    productId: "prod_fixture_team",
    lookupKey: "team_annual",
    active: true,
    currency: "usd",
    unitAmount: 99000,
    interval: "year",
  },
];

/**
 * In-memory, mutable so `setProduct` can simulate a dashboard edit mid-test (see the
 * `billing-catalog` IPC command in `browser-child.ts`). The real webhook HTTP call still drives
 * the resync — this only changes what the next resync would read.
 */
export class FixtureStripeCatalogSource {
  private readonly products = new Map<string, FixtureBillingProduct>(
    FIXTURE_BILLING_PRODUCTS.map((product) => [product.id, product]),
  );
  private readonly prices = [...FIXTURE_BILLING_PRICES];

  setProduct(product: FixtureBillingProduct): void {
    this.products.set(product.id, product);
  }

  async listProducts(): Promise<FixtureBillingProduct[]> {
    return [...this.products.values()].filter(
      (product) => product.metadata["paseo_plan"] === "true",
    );
  }

  async listPrices(): Promise<FixtureBillingPrice[]> {
    return this.prices.map((price) => ({ ...price }));
  }
}
