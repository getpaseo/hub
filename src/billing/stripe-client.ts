import StripeSDK from "stripe";
import type {
  StripeCatalogPrice,
  StripeCatalogProduct,
  StripeCatalogSource,
} from "./stripe-catalog-source.js";
import type {
  CreateBillingPortalSessionInput,
  CreateCheckoutSessionInput,
  EnsureCustomerInput,
  StripeBillingClient,
  StripeSubscriptionState,
} from "./stripe-billing-client.js";

const PASEO_PLAN_METADATA_KEY = "paseo_plan";
const ORGANIZATION_REFERENCE_METADATA_KEY = "organizationId";
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

/**
 * The real Stripe SDK behind `StripeBillingClient`. Every subscription carries
 * `metadata.organizationId` so the webhook can resolve the reference on re-read without trusting
 * event ordering. `getSubscription` reads the period end off the first subscription item, where
 * the current Stripe API keeps it.
 */
export function createStripeBillingClient(stripeSecretKey: string): StripeBillingClient {
  const stripe = new StripeSDK(stripeSecretKey);
  return {
    async ensureCustomer(input: EnsureCustomerInput): Promise<string> {
      const customer = await stripe.customers.create({
        ...(input.email === null ? {} : { email: input.email }),
        ...(input.name === null ? {} : { name: input.name }),
        metadata: { [ORGANIZATION_REFERENCE_METADATA_KEY]: input.organizationId },
      });
      return customer.id;
    },
    async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<{ url: string }> {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: input.customerId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.organizationId,
        subscription_data: {
          metadata: { [ORGANIZATION_REFERENCE_METADATA_KEY]: input.organizationId },
        },
        metadata: { [ORGANIZATION_REFERENCE_METADATA_KEY]: input.organizationId },
      });
      if (session.url === null) throw new Error("Stripe checkout session has no redirect URL");
      return { url: session.url };
    },
    async createBillingPortalSession(
      input: CreateBillingPortalSessionInput,
    ): Promise<{ url: string }> {
      const session = await stripe.billingPortal.sessions.create({
        customer: input.customerId,
        return_url: input.returnUrl,
      });
      return { url: session.url };
    },
    async getSubscription(subscriptionId: string): Promise<StripeSubscriptionState | undefined> {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const organizationId = subscription.metadata[ORGANIZATION_REFERENCE_METADATA_KEY];
      const item = subscription.items.data[0];
      if (organizationId === undefined || item === undefined) return undefined;
      return {
        id: subscription.id,
        customerId:
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id,
        organizationId,
        priceId: item.price.id,
        status: subscription.status,
        currentPeriodEnd: new Date(item.current_period_end * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      };
    },
  };
}
