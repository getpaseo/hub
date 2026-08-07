import type { BillingConfig } from "./config.js";

export { readBillingConfig, type BillingConfig } from "./config.js";

/**
 * HOSTED. Stripe, plans, subscriptions, checkout, portal, webhooks. Empty today — this slice
 * only establishes the boundary the later slices build behind: `src/billing/` is registered at
 * the composition root only when `readBillingConfig()` returns a config, and nothing outside
 * `src/billing/` or the composition root may import this module (enforced by oxlint).
 *
 * The single coupling to core runs the other way: `billing` will call
 * `entitlements.stamp(organizationId, template, provenance)`. `src/entitlements/` never imports
 * this module.
 */
export class BillingRuntime {
  constructor(private readonly config: BillingConfig) {}
}

export function composeBilling(config: BillingConfig): BillingRuntime {
  return new BillingRuntime(config);
}
