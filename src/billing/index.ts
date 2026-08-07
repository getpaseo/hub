import StripeSDK from "stripe";
import type { BillingPlanRecord, Database } from "../db/types.js";
import { entitlementsSchema, type EntitlementTemplate } from "../entitlements/catalog.js";
import type { EntitlementsService } from "../entitlements/service.js";
import type { ProvisioningEntitlement } from "../organizations/provisioning.js";
import { logger } from "../logger.js";
import { syncBillingCatalog } from "./catalog-sync.js";
import type { BillingConfig } from "./config.js";
import type { StripeCatalogSource } from "./stripe-catalog-source.js";
import type { BillingPlanPriceInterval } from "../db/types.js";
import type { StripeBillingClient } from "./stripe-billing-client.js";

export { readBillingConfig } from "./config.js";
export type { BillingConfig } from "./config.js";
export { createStripeCatalogSource, createStripeBillingClient } from "./stripe-client.js";
export type {
  StripeCatalogSource,
  StripeCatalogProduct,
  StripeCatalogPrice,
} from "./stripe-catalog-source.js";
export type { StripeBillingClient, StripeSubscriptionState } from "./stripe-billing-client.js";

/**
 * The four Stripe events that mean "the plan catalog may have changed" — see the plan's
 * "Mirror, do not fetch" section. Every other event type is acknowledged and ignored.
 */
const CATALOG_SYNC_EVENT_TYPES = new Set([
  "product.created",
  "product.updated",
  "price.created",
  "price.updated",
]);

/**
 * Subscription lifecycle events. Each carries only a reference; the handler re-reads the
 * authoritative subscription state and stamps, so retries and out-of-order delivery converge.
 */
const SUBSCRIPTION_SYNC_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/** Statuses whose plan should be stamped onto the organization. Others leave entitlements as-is
 * (grandfathered) — downgrade on cancellation is slice 7, not this slice. */
const STAMPABLE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

/**
 * The plan a hosted organization gets before it pays. Identified by its `paseo_plan_slug`
 * metadata, mirrored as `billing_plans.slug` — so which product is "free" is set in the Stripe
 * dashboard, not hardcoded here (the plan's "Stripe is the source of truth" rule).
 */
const FREE_PLAN_SLUG = "free";

/**
 * The conservative floor used only when billing is configured but the mirror has no active Free
 * plan — a first boot before the sync lands, or a Stripe account with no Free product. Not a
 * mirror of any Stripe plan: it fails closed (one seat, no invites, a small execution cap) so a
 * new organization can never get everything for free, while `provisioningEntitlement` logs loudly
 * so an operator notices and fixes the catalog. A misconfigured Stripe is recoverable — every
 * organization stamped from this floor re-stamps to the real Free plan the moment it subscribes.
 */
const FREE_TIER_FALLBACK: EntitlementTemplate = {
  seats: { max: 1 },
  canInviteMembers: false,
  meters: { "executions.monthly": { limit: 100 } },
};

export interface ComposeBillingOptions {
  config: BillingConfig;
  database: Database;
  entitlements: EntitlementsService;
  /** Production wires the real Stripe SDK; the E2E harness wires a fixture. See stripe-catalog-source.ts. */
  catalogSource: StripeCatalogSource;
  /** Production wires the real Stripe SDK; the E2E harness wires a fixture. See stripe-billing-client.ts. */
  billingClient: StripeBillingClient;
}

export interface CreateCheckoutInput {
  organizationId: string;
  planSlug: string;
  interval: BillingPlanPriceInterval;
  successUrl: string;
  cancelUrl: string;
  accountEmail: string | null;
  accountName: string | null;
}

export interface CreatePortalInput {
  organizationId: string;
  returnUrl: string;
}

/** The organization's current subscription, resolved against the plan mirror for display. */
export interface CurrentSubscriptionView {
  planSlug: string | null;
  planName: string | null;
  status: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  /** True when a subscription exists, so "Manage billing" (the Stripe portal) can be opened. */
  manageable: boolean;
}

/** Thrown when a checkout is requested for a plan/interval that is not in the mirror. */
export class BillingRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingRequestError";
  }
}

/**
 * HOSTED. Stripe, plans, subscriptions, checkout, portal, webhooks. `src/billing/` is
 * registered at the composition root only when `readBillingConfig()` returns a config, and
 * nothing outside `src/billing/` or the composition root may import this module (enforced by
 * oxlint).
 *
 * The single coupling to core runs the other way: `billing` calls
 * `entitlements.stamp(organizationId, template, provenance)`. `src/entitlements/` never imports
 * this module.
 */
export class BillingRuntime {
  /** Signature verification only — a fixture's plausible-but-fake secret works identically. */
  private readonly stripe: StripeSDK;

  constructor(
    private readonly config: BillingConfig,
    private readonly database: Database,
    private readonly entitlements: EntitlementsService,
    private readonly catalogSource: StripeCatalogSource,
    private readonly billingClient: StripeBillingClient,
  ) {
    this.stripe = new StripeSDK(config.stripeSecretKey);
  }

  async syncCatalog(): Promise<void> {
    await syncBillingCatalog(this.catalogSource, this.database);
  }

  /**
   * What a hosted organization is stamped with at provisioning: the Free plan's template resolved
   * from the catalog mirror. When no active Free plan is mirrored yet — a first boot before the
   * sync, or a misconfigured Stripe account — it falls back to a conservative floor and logs
   * loudly rather than failing open to unlimited or bricking organization creation. The
   * composition root wires this into the auth server's provisioning resolver; self-hosted
   * (no billing) never reaches here and keeps stamping unlimited.
   */
  async provisioningEntitlement(): Promise<ProvisioningEntitlement> {
    const plans = await this.database.listBillingPlans();
    const free = plans.find((plan) => plan.slug === FREE_PLAN_SLUG && plan.active);
    if (free !== undefined) {
      return { planId: free.id, granted: entitlementsSchema.parse(free.template) };
    }
    logger.error(
      "billing is configured but the catalog mirror has no active Free plan; provisioning new " +
        "organizations with the conservative free-tier fallback until the Free plan syncs",
    );
    return { planId: null, granted: FREE_TIER_FALLBACK };
  }

  /**
   * Start a Checkout Session for `planSlug`/`interval`, reusing the organization's Stripe
   * customer when it already has one. Reference authorization (only a manager may act for the
   * organization) is enforced upstream at the composition root before this is reached.
   */
  async createCheckout(input: CreateCheckoutInput): Promise<{ url: string }> {
    const price = await this.resolvePlanPrice(input.planSlug, input.interval);
    const customerId = await this.resolveCustomer(input);
    return this.billingClient.createCheckoutSession({
      organizationId: input.organizationId,
      customerId,
      priceId: price.priceId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    });
  }

  /** Open the Stripe billing portal for the organization's customer, or undefined when it has
   * no subscription yet (nothing for the portal to manage). */
  async createPortal(input: CreatePortalInput): Promise<{ url: string } | undefined> {
    const subscription = await this.database.getOrganizationSubscription(input.organizationId);
    if (subscription === undefined) return undefined;
    return this.billingClient.createBillingPortalSession({
      customerId: subscription.stripeCustomerId,
      returnUrl: input.returnUrl,
    });
  }

  /** The organization's current plan and subscription status, for the billing section. */
  async subscriptionSnapshot(organizationId: string): Promise<CurrentSubscriptionView> {
    const subscription = await this.database.getOrganizationSubscription(organizationId);
    if (subscription === undefined) {
      return {
        planSlug: null,
        planName: null,
        status: null,
        cancelAtPeriodEnd: false,
        currentPeriodEnd: null,
        manageable: false,
      };
    }
    const plans = await this.database.listBillingPlans();
    const plan = plans.find((candidate) => candidate.id === subscription.planId);
    return {
      planSlug: plan?.slug ?? null,
      planName: plan?.name ?? null,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      manageable: true,
    };
  }

  async handleWebhook(request: Request): Promise<Response> {
    const payload = await request.text();
    const signatureHeader = request.headers.get("stripe-signature");
    if (signatureHeader === null) {
      logger.warn("billing webhook: rejected request with no Stripe-Signature header");
      return new Response("missing signature", { status: 400 });
    }
    let event: StripeSDK.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        payload,
        signatureHeader,
        this.config.stripeWebhookSecret,
      );
    } catch (error) {
      logger.warn({ err: error }, "billing webhook: rejected request with an invalid signature");
      return new Response("invalid signature", { status: 400 });
    }
    if (CATALOG_SYNC_EVENT_TYPES.has(event.type)) {
      await this.syncCatalog();
    }
    if (SUBSCRIPTION_SYNC_EVENT_TYPES.has(event.type)) {
      await this.handleSubscriptionEvent(event);
    }
    return Response.json({ received: true });
  }

  /**
   * Re-read the referenced subscription and materialize it: upsert the local mirror, then stamp
   * the resolved plan's template onto the organization. Idempotent by construction — the stamp
   * is a no-op when the template is unchanged (see the entitlements consolidation), and the read
   * is of live state rather than the event payload, so replays and reordered deliveries all
   * settle on the same result.
   */
  private async handleSubscriptionEvent(event: StripeSDK.Event): Promise<void> {
    const subscriptionId = subscriptionReferenceFromEvent(event);
    if (subscriptionId === undefined) return;
    const state = await this.billingClient.getSubscription(subscriptionId);
    if (state === undefined) return;
    const plan = await this.resolvePlanByPrice(state.priceId);
    await this.database.upsertOrganizationSubscription({
      organizationId: state.organizationId,
      stripeCustomerId: state.customerId,
      stripeSubscriptionId: state.id,
      planId: plan?.id ?? null,
      status: state.status,
      currentPeriodEnd: state.currentPeriodEnd,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    });
    if (plan === undefined) {
      logger.warn(
        { subscriptionId: state.id, priceId: state.priceId },
        "billing webhook: subscription price is not in the plan mirror; skipping entitlement stamp",
      );
      return;
    }
    if (!STAMPABLE_SUBSCRIPTION_STATUSES.has(state.status)) return;
    const template = entitlementsSchema.parse(plan.template);
    await this.entitlements.stamp(state.organizationId, template, {
      source: "plan_stamp",
      planId: plan.id,
    });
  }

  private async resolveCustomer(input: CreateCheckoutInput): Promise<string> {
    const existing = await this.database.getOrganizationSubscription(input.organizationId);
    if (existing !== undefined) return existing.stripeCustomerId;
    return this.billingClient.ensureCustomer({
      organizationId: input.organizationId,
      email: input.accountEmail,
      name: input.accountName,
    });
  }

  private async resolvePlanPrice(
    slug: string,
    interval: BillingPlanPriceInterval,
  ): Promise<{ priceId: string; planId: string }> {
    const plans = await this.database.listBillingPlans();
    const plan = plans.find((candidate) => candidate.slug === slug && candidate.active);
    if (plan === undefined) throw new BillingRequestError(`unknown plan: ${slug}`);
    const price = plan.prices.find(
      (candidate) => candidate.interval === interval && candidate.active,
    );
    if (price === undefined) {
      throw new BillingRequestError(`plan ${slug} has no active ${interval} price`);
    }
    return { priceId: price.id, planId: plan.id };
  }

  private async resolvePlanByPrice(priceId: string): Promise<BillingPlanRecord | undefined> {
    const plans = await this.database.listBillingPlans();
    return plans.find((plan) => plan.prices.some((price) => price.id === priceId));
  }
}

/**
 * The subscription id a lifecycle event references. A subscription event carries it directly;
 * `checkout.session.completed` carries it on the session's `subscription` field.
 */
function subscriptionReferenceFromEvent(event: StripeSDK.Event): string | undefined {
  if (event.type === "checkout.session.completed") {
    const subscription = event.data.object.subscription;
    if (subscription === null) return undefined;
    return typeof subscription === "string" ? subscription : subscription.id;
  }
  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    return event.data.object.id;
  }
  return undefined;
}

export function composeBilling(options: ComposeBillingOptions): BillingRuntime {
  return new BillingRuntime(
    options.config,
    options.database,
    options.entitlements,
    options.catalogSource,
    options.billingClient,
  );
}
