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

/** A patch is the set of hand-adjustments an admin applies over the granted template. */
export type EntitlementPatch = EntitlementOverrides;

/** Caps carry a numeric limit checked against a live count by `requireHeadroom`. */
export type CapKey = "seats";

export const UNLIMITED_TEMPLATE: EntitlementTemplate = {
  seats: { max: null },
  canInviteMembers: true,
};

/** The effective limit for a cap, or null when the cap is unlimited. */
export function capLimit(effective: Entitlements, cap: CapKey): number | null {
  const limits: Record<CapKey, number | null> = {
    seats: effective.seats.max,
  };
  return limits[cap];
}

/**
 * Fold a patch into the existing overrides. Leaves in the patch win; keys the patch
 * omits keep their existing override. `granted` is never involved — a plan sync writes
 * `granted`, an admin writes `overrides`, and the two never touch.
 */
export function mergeOverrides(
  existing: EntitlementOverrides,
  patch: EntitlementPatch,
): EntitlementOverrides {
  return entitlementOverridesSchema.parse({
    ...existing,
    ...patch,
    ...(patch.seats === undefined ? {} : { seats: { ...existing.seats, ...patch.seats } }),
  });
}

/**
 * Thrown when a capped entitlement has no headroom left. Mapped to a machine-readable
 * HTTP payload once at each boundary — never caught and reshaped per call site.
 */
export class EntitlementDenied extends Error {
  constructor(
    readonly entitlement: CapKey,
    readonly limit: number,
    readonly current: number,
  ) {
    super(`entitlement denied: ${entitlement} (${current}/${limit})`);
    this.name = "EntitlementDenied";
  }
}

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
