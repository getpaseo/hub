import { createServerFn } from "@tanstack/react-start";
import { isBillingConfigured } from "./runtime.js";

/**
 * Narrow reads the dashboard needs about a hosted feature it must not import. Each resolves
 * through the composition root, so `src/billing/` stays behind its boundary and a caller here
 * learns a boolean — never a plan, a status, or that Stripe exists. Anything that needs more
 * than a fact of this shape needs the billing surface itself.
 */

/**
 * Whether the hosted billing feature is mounted on this instance. A capability probe, not billing
 * logic — it never touches Stripe or `src/billing/` — so it lives in core and the dashboard shell
 * can gate the Billing nav entry on it without crossing the billing import boundary. The billing
 * dashboard route reuses it as its loader guard.
 */
export const billingConfigured = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ configured: boolean }> => ({ configured: await isBillingConfigured() }),
);
