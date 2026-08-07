import StripeSDK from "stripe";
import type {
  StripeCatalogPrice,
  StripeCatalogProduct,
  StripeCatalogSource,
} from "./stripe-catalog-source.js";

const PASEO_PLAN_METADATA_KEY = "paseo_plan";
const LIST_PAGE_SIZE = 100;

/**
 * The real Stripe SDK behind `StripeCatalogSource`. Fetches every product/price via the List
 * API (not Search — Search has an indexing lag after a write, which would make the boot sync
 * racy right after a dashboard edit; List is strongly consistent) and filters client-side to
 * `metadata.paseo_plan=true`, matching the plan's "which products are Paseo plans" rule.
 *
 * Fetches products regardless of `active` so a product archived in the dashboard is mirrored
 * as inactive rather than silently vanishing from the fetch and going stale in our mirror.
 */
export function createStripeCatalogSource(stripeSecretKey: string): StripeCatalogSource {
  const stripe = new StripeSDK(stripeSecretKey);
  return {
    async listProducts(): Promise<StripeCatalogProduct[]> {
      const products: StripeCatalogProduct[] = [];
      for await (const product of stripe.products.list({ limit: LIST_PAGE_SIZE })) {
        if (product.metadata[PASEO_PLAN_METADATA_KEY] !== "true") continue;
        products.push({
          id: product.id,
          name: product.name,
          active: product.active,
          metadata: product.metadata,
          marketingFeatures: product.marketing_features.flatMap((feature) =>
            feature.name === undefined ? [] : [feature.name],
          ),
        });
      }
      return products;
    },
    async listPrices(): Promise<StripeCatalogPrice[]> {
      const prices: StripeCatalogPrice[] = [];
      for await (const price of stripe.prices.list({ limit: LIST_PAGE_SIZE })) {
        prices.push({
          id: price.id,
          productId: typeof price.product === "string" ? price.product : price.product.id,
          lookupKey: price.lookup_key,
          active: price.active,
          currency: price.currency,
          unitAmount: price.unit_amount,
          interval:
            price.recurring?.interval === "month" || price.recurring?.interval === "year"
              ? price.recurring.interval
              : null,
        });
      }
      return prices;
    },
  };
}
