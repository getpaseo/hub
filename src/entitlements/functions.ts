import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
import { logger } from "../logger.js";
import { TenantRouteNotFoundError } from "../projects/access.js";
import { getApplication } from "../server/runtime.js";
import type { EntitlementsDashboard } from "./dashboard.js";

const organizationScopeSchema = z
  .object({ organizationSlug: z.string().trim().min(1).max(100) })
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
