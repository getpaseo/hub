import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  handleOrganizationTrial,
  isBillingConfigured,
  type OrganizationTrialView,
} from "./runtime.js";

/**
 * Narrow reads the dashboard needs about a hosted feature it must not import. Each resolves
 * through the composition root, so `src/billing/` stays behind its boundary and a caller here
 * learns a boolean or a number — never a plan, a status, or that Stripe exists.
 */

const organizationScopeSchema = z
  .object({ organizationSlug: z.string().trim().min(1).max(100) })
  .strict();

/**
 * Whether the hosted billing feature is mounted on this instance. A capability probe, not billing
 * logic — it never touches Stripe or `src/billing/` — so it lives in core and the dashboard shell
 * can gate the Billing nav entry on it without crossing the billing import boundary. The billing
 * dashboard route reuses it as its loader guard.
 */
export const billingConfigured = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ configured: boolean }> => ({ configured: await isBillingConfigured() }),
);

/** Days left in the organization's trial, for the sidebar's reminder. Null on every state that
 * is not a running trial, self-hosted included, so the reminder needs no second probe. */
export const organizationTrial = createServerFn({ method: "GET" })
  .validator(organizationScopeSchema)
  .handler(
    async ({ data }): Promise<OrganizationTrialView> =>
      handleOrganizationTrial(getRequest(), data.organizationSlug),
  );
