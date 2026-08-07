import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The entitlement catalog: caps and flags checked against live state, plus meter limits.
 * Meter *usage* (executions consumed so far this period) lives in `organization_usage`,
 * keyed by period — see the plan's data model. Only the limit lives here, so a meter
 * limit is overridable by an admin exactly like a cap.
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
    meters: z
      .object({
        "executions.monthly": z
          .object({
            /** null means unlimited. */
            limit: z.number().int().positive().nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type Entitlements = z.infer<typeof entitlementsSchema>;

/**
 * Stored entitlement documents can predate any field the catalog added later: `meters`
 * landed after `seats`/`canInviteMembers`, and no migration upgraded the `granted` jsonb or
 * the audit snapshots written before it. Every read parses those documents, so a strict
 * parse throws for every pre-meters organization.
 *
 * This is the single versioned upgrade boundary. It parses leniently, fills the default a
 * later schema version introduced, then commits to the strict shape. When you add a required
 * field to `entitlementsSchema`, add its default here — every historical document keeps
 * reading, which is what stops the missing-backfill class of bug (shipped twice) from
 * recurring. `entitlementsSchema` stays the one authority on the current shape; this only
 * decides how an older shape maps onto it.
 */
const storedEntitlementsSchema = z.object({
  seats: z.object({ max: z.number().int().positive().nullable() }),
  canInviteMembers: z.boolean(),
  meters: z
    .object({
      "executions.monthly": z
        .object({ limit: z.number().int().positive().nullable() })
        .default({ limit: null }),
    })
    .default({ "executions.monthly": { limit: null } }),
});

/** Upgrade a stored entitlements document to the current strict shape. */
export function normalizeStoredEntitlements(raw: unknown): Entitlements {
  return entitlementsSchema.parse(storedEntitlementsSchema.parse(raw));
}

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
    meters: z
      .object({
        "executions.monthly": z
          .object({
            limit: z.number().int().positive().nullable(),
          })
          .strict()
          .partial(),
      })
      .strict()
      .partial(),
  })
  .strict()
  .partial();

export type EntitlementOverrides = z.infer<typeof entitlementOverridesSchema>;

/** A patch is the set of hand-adjustments an admin applies over the granted template. */
export type EntitlementPatch = EntitlementOverrides;

/** Caps carry a numeric limit checked against a live count by `requireHeadroom`. */
export type CapKey = "seats";

/** Meters carry a numeric limit checked against period usage by `consume`. */
export type MeterKey = "executions.monthly";

export const UNLIMITED_TEMPLATE: EntitlementTemplate = {
  seats: { max: null },
  canInviteMembers: true,
  meters: { "executions.monthly": { limit: null } },
};

/** The effective limit for a cap, or null when the cap is unlimited. */
export function capLimit(effective: Entitlements, cap: CapKey): number | null {
  const limits: Record<CapKey, number | null> = {
    seats: effective.seats.max,
  };
  return limits[cap];
}

/** The effective limit for a meter, or null when the meter is unlimited. */
export function meterLimit(effective: Entitlements, meter: MeterKey): number | null {
  const limits: Record<MeterKey, number | null> = {
    "executions.monthly": effective.meters["executions.monthly"].limit,
  };
  return limits[meter];
}

/**
 * The UTC-monthly period a moment in time falls into, as the timestamp of its start.
 * The single named function for period derivation — never inline this at call sites.
 */
export function meterPeriodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
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
    ...(patch.meters === undefined
      ? {}
      : {
          meters: {
            "executions.monthly": {
              ...existing.meters?.["executions.monthly"],
              ...patch.meters["executions.monthly"],
            },
          },
        }),
  });
}

/**
 * Thrown when a capped entitlement or metered usage has no headroom left. Mapped to a
 * machine-readable HTTP payload once at each boundary — never caught and reshaped per
 * call site.
 */
export class EntitlementDenied extends Error {
  constructor(
    readonly entitlement: CapKey | MeterKey,
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
    meters: {
      "executions.monthly": {
        limit:
          overrides.meters?.["executions.monthly"]?.limit !== undefined
            ? overrides.meters["executions.monthly"].limit
            : granted.meters["executions.monthly"].limit,
      },
    },
  };
}

/** Stripe has no version counter, so `plan_version` is a content hash of the template. */
export function hashTemplate(template: EntitlementTemplate): string {
  return createHash("sha256").update(JSON.stringify(template)).digest("hex");
}
