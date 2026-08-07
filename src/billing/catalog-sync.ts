import type { Database, SyncBillingPlanInput, SyncBillingPlanPriceInput } from "../db/types.js";
import { hashTemplate } from "../entitlements/catalog.js";
import { logger } from "../logger.js";
import { parsePlanMetadata } from "./plan-template.js";
import type {
  StripeCatalogPrice,
  StripeCatalogProduct,
  StripeCatalogSource,
} from "./stripe-catalog-source.js";

const MAX_MARKETING_FEATURES = 15;

/**
 * Mirrors the Stripe plan catalog into `billing_plans`/`billing_plan_prices`. Runs on boot and
 * on `product.created`, `product.updated`, `price.created`, `price.updated` — always a full
 * resync rather than an incremental one, since the catalog is a handful of products and this
 * keeps there from being two sync code paths to keep correct.
 *
 * Per product, invalid entitlement metadata rejects only that product's sync: the previously
 * synced row is left untouched and the rejection is logged loudly. Nothing here ever calls
 * `database.syncBillingPlan` with an unvalidated template.
 */
export async function syncBillingCatalog(
  source: StripeCatalogSource,
  database: Database,
): Promise<void> {
  const [products, prices] = await Promise.all([source.listProducts(), source.listPrices()]);
  const pricesByProduct = groupPricesByProduct(prices);
  for (const product of products) {
    await syncProduct(product, pricesByProduct.get(product.id) ?? [], database);
  }
}

async function syncProduct(
  product: StripeCatalogProduct,
  productPrices: readonly StripeCatalogPrice[],
  database: Database,
): Promise<void> {
  const parsed = parsePlanMetadata(product.metadata);
  if (!parsed.success) {
    logger.error(
      { productId: product.id, productName: product.name, reason: parsed.message },
      "billing catalog sync: rejected product with invalid entitlement metadata; keeping the last known good row",
    );
    return;
  }
  const input: SyncBillingPlanInput = {
    id: product.id,
    slug: parsed.data.slug,
    name: product.name,
    template: parsed.data.template,
    templateHash: hashTemplate(parsed.data.template),
    marketing: { features: product.marketingFeatures.slice(0, MAX_MARKETING_FEATURES) },
    active: product.active,
    prices: syncablePrices(product.id, productPrices),
  };
  await database.syncBillingPlan(input);
}

function syncablePrices(
  productId: string,
  prices: readonly StripeCatalogPrice[],
): SyncBillingPlanPriceInput[] {
  return prices.flatMap((price) => {
    if (price.lookupKey === null || price.interval === null) {
      logger.warn(
        { priceId: price.id, productId },
        "billing catalog sync: skipping price without a lookup key or a recurring interval",
      );
      return [];
    }
    return [
      {
        id: price.id,
        lookupKey: price.lookupKey,
        interval: price.interval === "month" ? ("monthly" as const) : ("annual" as const),
        unitAmount: price.unitAmount ?? 0,
        currency: price.currency,
        active: price.active,
      },
    ];
  });
}

function groupPricesByProduct(
  prices: readonly StripeCatalogPrice[],
): Map<string, StripeCatalogPrice[]> {
  const byProduct = new Map<string, StripeCatalogPrice[]>();
  for (const price of prices) {
    const list = byProduct.get(price.productId) ?? [];
    list.push(price);
    byProduct.set(price.productId, list);
  }
  return byProduct;
}
