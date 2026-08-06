import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The entitlement catalog: caps and flags checked against live state. Meters
 * (executions per month, ...) are a separate table — see the plan's data model.
 */
export const entitlementsSchema = z
  .object({
    seats: z
      .object({
        /** null means unlimited. */
        max: z.number().int().positive().nullable(),
      })
      .strict(),
    canInviteMembers: z.boolean(),
  })
  .strict();

export type Entitlements = z.infer<typeof entitlementsSchema>;

/** A template is entitlements data prior to being stamped onto an organization. */
export type EntitlementTemplate = Entitlements;

export const entitlementOverridesSchema = z
  .object({
    seats: z
      .object({
        max: z.number().int().positive().nullable(),
      })
      .strict()
      .partial(),
    canInviteMembers: z.boolean(),
  })
  .strict()
  .partial();

export type EntitlementOverrides = z.infer<typeof entitlementOverridesSchema>;

export const UNLIMITED_TEMPLATE: EntitlementTemplate = {
  seats: { max: null },
  canInviteMembers: true,
};

/** overrides always wins; a missing key falls back to the granted value. */
export function effectiveEntitlements(
  granted: Entitlements,
  overrides: EntitlementOverrides,
): Entitlements {
  return {
    seats: { max: overrides.seats?.max !== undefined ? overrides.seats.max : granted.seats.max },
    canInviteMembers: overrides.canInviteMembers ?? granted.canInviteMembers,
  };
}

/** Stripe has no version counter, so `plan_version` is a content hash of the template. */
export function hashTemplate(template: EntitlementTemplate): string {
  return createHash("sha256").update(JSON.stringify(template)).digest("hex");
}
