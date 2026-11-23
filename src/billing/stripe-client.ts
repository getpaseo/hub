import { createHash } from "node:crypto";
import StripeSDK from "stripe";
import type {
  StripeCatalogPrice,
  StripeCatalogProduct,
  StripeCatalogSource,
} from "./stripe-catalog-source.js";
import type {
  ChangeSubscriptionPriceInput,
  CreateBillingPortalSessionInput,
  CreateCheckoutSessionInput,
  EnsureCustomerInput,
  ReportSeatQuantityInput,
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
export function createStripeBillingClient(
  stripeSecretKey: string,
  options: {
    /** Stripe's API host. Only tests point this anywhere else. */
    apiBaseUrl?: string;
  } = {},
): StripeBillingClient {
  const stripe = new StripeSDK(stripeSecretKey, stripeConnection(options.apiBaseUrl));
  return {
    async ensureCustomer(input: EnsureCustomerInput): Promise<string> {
      const customer = await stripe.customers.create(
        {
          ...(input.email === null ? {} : { email: input.email }),
          ...(input.name === null ? {} : { name: input.name }),
          metadata: { [ORGANIZATION_REFERENCE_METADATA_KEY]: input.organizationId },
        },
        // Keyed on the organization so two concurrent first-checkout attempts collapse onto one
        // customer instead of creating a duplicate — the customer half of "pending checkout
        // creation is idempotent".
        { idempotencyKey: `customer:${input.organizationId}` },
      );
      return customer.id;
    },
    async listCustomerSubscriptions(
      customerId: string,
    ): Promise<readonly StripeSubscriptionState[]> {
      const result: StripeSubscriptionState[] = [];
      for await (const subscription of stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: LIST_PAGE_SIZE,
      })) {
        const organizationId = subscription.metadata[ORGANIZATION_REFERENCE_METADATA_KEY];
        const item = subscription.items.data[0];
        if (organizationId !== undefined && item !== undefined)
          result.push(toSubscriptionState(subscription, organizationId, item));
      }
      return result;
    },
    async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<{ url: string }> {
      const params: StripeSDK.Checkout.SessionCreateParams = {
        mode: "subscription",
        customer: input.customerId,
        line_items: [{ price: input.priceId, quantity: input.quantity }],
        allow_promotion_codes: true,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: input.organizationId,
        metadata: { [ORGANIZATION_REFERENCE_METADATA_KEY]: input.organizationId },
        subscription_data: {
          metadata: { [ORGANIZATION_REFERENCE_METADATA_KEY]: input.organizationId },
        },
      };
      // Identical concurrent attempts collapse onto one session. The key covers every parameter
      // because Stripe rejects a reused key with different parameters for 24 hours, which would
      // otherwise strand a checkout after a seat change or a new Checkout option.
      const session = await stripe.checkout.sessions.create(params, {
        idempotencyKey: `checkout:${input.organizationId}:${requestDigest(params)}`,
      });
      if (session.url === null) throw new Error("Stripe checkout session has no redirect URL");
      // A changed checkout gets a new session, so expire the customer's earlier ones: only the
      // newest link can be paid, and two completed links never make two subscriptions. This runs
      // after the create, because an identical retry replays the session it must keep.
      for await (const open of stripe.checkout.sessions.list({
        customer: input.customerId,
        status: "open",
        limit: LIST_PAGE_SIZE,
      })) {
        if (open.id !== session.id) await stripe.checkout.sessions.expire(open.id);
      }
      return { url: session.url };
    },
    async changeSubscriptionPrice(input: ChangeSubscriptionPriceInput): Promise<void> {
      // A plan change updates the existing subscription's single item onto the new price — never a
      // second subscription. Stripe needs the item id, so retrieve first, then swap its price.
      const subscription = await stripe.subscriptions.retrieve(input.subscriptionId);
      const item = subscription.items.data[0];
      if (item === undefined) {
        throw new Error(`subscription ${input.subscriptionId} has no item to change`);
      }
      await stripe.subscriptions.update(input.subscriptionId, {
        items: [{ id: item.id, price: input.priceId }],
        proration_behavior: "create_prorations",
      });
    },
    async reportSeatQuantity(input: ReportSeatQuantityInput): Promise<void> {
      // Post-paid seat billing: set the item's quantity to the organization's live seat count.
      // The caller only calls this on a change, so the resulting subscription.updated echo carries
      // no delta and reconciliation converges without re-reporting.
      const subscription = await stripe.subscriptions.retrieve(input.subscriptionId);
      const item = subscription.items.data[0];
      if (item === undefined) {
        throw new Error(`subscription ${input.subscriptionId} has no item to report seats on`);
      }
      await stripe.subscriptions.update(input.subscriptionId, {
        items: [{ id: item.id, quantity: input.quantity }],
        proration_behavior: "create_prorations",
      });
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
      return toSubscriptionState(subscription, organizationId, item);
    },
  };
}

function requestDigest(params: object): string {
  return createHash("sha256").update(JSON.stringify(params)).digest("base64url");
}

function stripeConnection(apiBaseUrl: string | undefined): StripeSDK.StripeConfig {
  if (apiBaseUrl === undefined) return {};
  const url = new URL(apiBaseUrl);
  return {
    host: url.hostname,
    port: url.port,
    protocol: url.protocol === "http:" ? "http" : "https",
    maxNetworkRetries: 0,
  };
}

function toSubscriptionState(
  subscription: StripeSDK.Subscription,
  organizationId: string,
  item: StripeSDK.SubscriptionItem,
): StripeSubscriptionState {
  return {
    id: subscription.id,
    customerId:
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
    organizationId,
    priceId: item.price.id,
    quantity: item.quantity ?? 1,
    status: subscription.status,
    currentPeriodEnd: new Date(item.current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
}
