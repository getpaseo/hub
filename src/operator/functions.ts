import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
import { entitlementOverridesSchema } from "../entitlements/catalog.js";
import { logger } from "../logger.js";
import { getApplication } from "../server/runtime.js";
import type { OperatorConsole } from "./console.js";

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

const clearOverrideInputSchema = z
  .object({
    organizationSlug: z.string().trim().min(1).max(100),
    key: z.enum(["seats", "canInviteMembers", "executions.monthly"]),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

async function requireConsole(): Promise<OperatorConsole> {
  const operatorConsole = (await getApplication()).operatorConsole;
  if (operatorConsole === null) throw new Error("operator console unavailable");
  return operatorConsole;
}

export const operatorOrganizations = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<Awaited<ReturnType<OperatorConsole["listOrganizations"]>>>> => {
    try {
      return respondOk(await (await requireConsole()).listOrganizations(getRequest()));
    } catch (error) {
      logger.error({ err: error }, "operator organizations read failed");
      return respondError({ message: operatorErrorMessage(error) });
    }
  },
);

export const operatorSnapshot = createServerFn({ method: "GET" })
  .validator(organizationScopeSchema)
  .handler(async ({ data }): Promise<Result<Awaited<ReturnType<OperatorConsole["snapshot"]>>>> => {
    try {
      return respondOk(await (await requireConsole()).snapshot(getRequest(), data));
    } catch (error) {
      logger.error({ err: error, data }, "operator snapshot read failed");
      return respondError({ message: operatorErrorMessage(error) });
    }
  });

export const operatorOverride = createServerFn({ method: "POST" })
  .validator(overrideInputSchema)
  .handler(async ({ data }): Promise<Result<Awaited<ReturnType<OperatorConsole["override"]>>>> => {
    const { organizationSlug, patch, reason } = data;
    try {
      return respondOk(
        await (
          await requireConsole()
        ).override(getRequest(), { organizationSlug }, { patch, reason }),
      );
    } catch (error) {
      logger.error({ err: error, organizationSlug }, "operator override failed");
      return respondError({ message: operatorErrorMessage(error) });
    }
  });

export const operatorClearOverride = createServerFn({ method: "POST" })
  .validator(clearOverrideInputSchema)
  .handler(
    async ({ data }): Promise<Result<Awaited<ReturnType<OperatorConsole["clearOverride"]>>>> => {
      const { organizationSlug, key, reason } = data;
      try {
        return respondOk(
          await (
            await requireConsole()
          ).clearOverride(getRequest(), { organizationSlug }, { key, reason }),
        );
      } catch (error) {
        logger.error({ err: error, organizationSlug }, "operator clear override failed");
        return respondError({ message: operatorErrorMessage(error) });
      }
    },
  );

function operatorErrorMessage(error: unknown): string {
  // OperatorConsole is constructed in the composition root, which the bundler places in a
  // different chunk than these server functions, so a thrown OperatorForbiddenError can carry a
  // different class identity here than the imported one — `instanceof` is unreliable across that
  // boundary. Map by the stable `name` the console sets, which survives bundling.
  if (error instanceof Error) {
    if (error.name === "OperatorForbiddenError") return "You don't have operator access.";
    if (error.name === "OperatorOrganizationNotFoundError") return "Organization not found.";
  }
  return "We couldn't complete that operator action.";
}
