import StripeSDK from "stripe";
import type { Database } from "../db/types.js";
import { logger } from "../logger.js";
import { syncBillingCatalog } from "./catalog-sync.js";
import type { BillingConfig } from "./config.js";
import type { StripeCatalogSource } from "./stripe-catalog-source.js";

export { readBillingConfig } from "./config.js";
export type { BillingConfig } from "./config.js";
export { createStripeCatalogSource } from "./stripe-client.js";
export type {
  StripeCatalogSource,
  StripeCatalogProduct,
  StripeCatalogPrice,
} from "./stripe-catalog-source.js";

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

export interface ComposeBillingOptions {
  config: BillingConfig;
  database: Database;
  /** Production wires the real Stripe SDK; the E2E harness wires a fixture. See stripe-catalog-source.ts. */
  catalogSource: StripeCatalogSource;
}

/**
 * HOSTED. Stripe, plans, subscriptions, checkout, portal, webhooks. `src/billing/` is
 * registered at the composition root only when `readBillingConfig()` returns a config, and
 * nothing outside `src/billing/` or the composition root may import this module (enforced by
 * oxlint).
 *
 * The single coupling to core runs the other way: `billing` will call
 * `entitlements.stamp(organizationId, template, provenance)`. `src/entitlements/` never
 * imports this module.
 */
export class BillingRuntime {
  /**
   * Signature verification only — never used to call the Stripe API, so a fixture's
   * plausible-looking-but-fake secret key works identically to a real one here. Kept separate
   * from `catalogSource`, which is the actual injected port.
   */
  private readonly stripe: StripeSDK;

  constructor(
    private readonly config: BillingConfig,
    private readonly database: Database,
    private readonly catalogSource: StripeCatalogSource,
  ) {
    this.stripe = new StripeSDK(config.stripeSecretKey);
  }

  async syncCatalog(): Promise<void> {
    await syncBillingCatalog(this.catalogSource, this.database);
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
    return Response.json({ received: true });
  }
}

export function composeBilling(options: ComposeBillingOptions): BillingRuntime {
  return new BillingRuntime(options.config, options.database, options.catalogSource);
}
