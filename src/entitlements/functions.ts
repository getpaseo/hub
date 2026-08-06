import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
import { logger } from "../logger.js";
import { TenantRouteNotFoundError } from "../projects/access.js";
import { getApplication } from "../server/runtime.js";
import { entitlementOverridesSchema } from "./catalog.js";
import { EntitlementsForbiddenError, type EntitlementsDashboard } from "./dashboard.js";

const organizationScopeSchema = z
  .object({ organizationSlug: z.string().trim().min(1).max(100) })
  .strict();

const overrideInputSchema = z
  .object({
    organizationSlug: z.string().trim().min(1).max(100),
    patch: entitlementOverridesSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const entitlementsSnapshot = createServerFn({ method: "GET" })
  .validator(organizationScopeSchema)
  .handler(
    async ({ data }): Promise<Result<Awaited<ReturnType<EntitlementsDashboard["snapshot"]>>>> => {
      try {
        const dashboard = (await getApplication()).entitlementsDashboard;
        if (dashboard === null) throw new Error("entitlements dashboard unavailable");
        return respondOk(await dashboard.snapshot(getRequest(), data));
      } catch (error) {
        logger.error({ err: error, data }, "entitlements snapshot read failed");
        return respondError({
          message:
            error instanceof TenantRouteNotFoundError
              ? "Organization unavailable."
              : "We couldn't load this organization's entitlements.",
        });
      }
    },
  );

export const entitlementsOverride = createServerFn({ method: "POST" })
  .validator(overrideInputSchema)
  .handler(
    async ({ data }): Promise<Result<Awaited<ReturnType<EntitlementsDashboard["override"]>>>> => {
      const { organizationSlug, patch, reason } = data;
      try {
        const dashboard = (await getApplication()).entitlementsDashboard;
        if (dashboard === null) throw new Error("entitlements dashboard unavailable");
        return respondOk(
          await dashboard.override(getRequest(), { organizationSlug }, { patch, reason }),
        );
      } catch (error) {
        logger.error({ err: error, organizationSlug }, "entitlements override failed");
        return respondError({ message: overrideErrorMessage(error) });
      }
    },
  );

function overrideErrorMessage(error: unknown): string {
  if (error instanceof EntitlementsForbiddenError) {
    return "You don't have permission to change entitlements.";
  }
  if (error instanceof TenantRouteNotFoundError) return "Organization unavailable.";
  return "We couldn't save that override.";
}
