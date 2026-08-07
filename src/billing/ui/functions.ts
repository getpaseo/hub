import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../../contract/respond.js";
import { logger } from "../../logger.js";
import { TenantRouteNotFoundError } from "../../projects/access.js";
import {
  BillingForbiddenError,
  handleBillingCheckout,
  handleBillingOverview,
  handleBillingPortal,
  type BillingOverviewView,
} from "../../server/runtime.js";

/**
 * The dashboard billing surface. It lives under `src/billing/ui/`, inside the feature it belongs
 * to; the billing dashboard route is exempted from the import boundary (like a composition root)
 * so it can mount this. Every function is a thin wrapper over the composition root, which owns
 * Stripe and the `authorizeReference` capability check. The "is billing configured" probe is a
 * core capability check, not billing logic, so it lives in `src/server/capabilities.ts`.
 */
const organizationScopeSchema = z
  .object({ organizationSlug: z.string().trim().min(1).max(100) })
  .strict();

const checkoutSchema = z
  .object({
    organizationSlug: z.string().trim().min(1).max(100),
    planSlug: z.string().trim().min(1).max(100),
    interval: z.enum(["monthly", "annual"]),
  })
  .strict();

export const billingOverview = createServerFn({ method: "GET" })
  .validator(organizationScopeSchema)
  .handler(async ({ data }): Promise<Result<BillingOverviewView>> => {
    try {
      return respondOk(await handleBillingOverview(getRequest(), data.organizationSlug));
    } catch (error) {
      logger.error({ err: error, data }, "billing overview read failed");
      return respondError({
        message:
          error instanceof TenantRouteNotFoundError
            ? "Organization unavailable."
            : "We couldn't load billing for this organization.",
      });
    }
  });

export const billingCheckout = createServerFn({ method: "POST" })
  .validator(checkoutSchema)
  .handler(async ({ data }): Promise<Result<{ url: string }>> => {
    try {
      return respondOk(await handleBillingCheckout(getRequest(), data));
    } catch (error) {
      logger.error({ err: error, data }, "billing checkout failed");
      return respondError({ message: billingActionErrorMessage(error) });
    }
  });

export const billingPortal = createServerFn({ method: "POST" })
  .validator(organizationScopeSchema)
  .handler(async ({ data }): Promise<Result<{ url: string | null }>> => {
    try {
      return respondOk(await handleBillingPortal(getRequest(), data.organizationSlug));
    } catch (error) {
      logger.error({ err: error, data }, "billing portal failed");
      return respondError({ message: billingActionErrorMessage(error) });
    }
  });

function billingActionErrorMessage(error: unknown): string {
  if (error instanceof BillingForbiddenError) {
    return "Only an organization owner or admin can change billing.";
  }
  return "We couldn't reach billing. Please try again.";
}
