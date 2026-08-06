import { z } from "zod";
import type { Database, EntitlementChangeSource } from "../db/types.js";
import {
  capLimit,
  effectiveEntitlements,
  EntitlementDenied,
  entitlementOverridesSchema,
  entitlementsSchema,
  hashTemplate,
  mergeOverrides,
  type CapKey,
  type EntitlementOverrides,
  type EntitlementPatch,
  type Entitlements,
  type EntitlementTemplate,
} from "./catalog.js";

export interface Provenance {
  source: EntitlementChangeSource;
  /** The plan that produced this template, or null for self-hosted/hand-provisioned. */
  planId: string | null;
  actor?: string | null;
  reason?: string | null;
}

export interface OrganizationEntitlements {
  organizationId: string;
  granted: Entitlements;
  overrides: EntitlementOverrides;
  effective: Entitlements;
  planId: string | null;
  planVersion: string | null;
  stampedAt: Date;
  updatedAt: Date;
}

/** One entry in the append-only audit trail, resolved into typed, display-ready values. */
export interface EntitlementChange {
  id: string;
  actor: string | null;
  actorName: string | null;
  source: EntitlementChangeSource;
  reason: string | null;
  /** The effective entitlements the organization held immediately after this change. */
  effective: Entitlements;
  overrides: EntitlementOverrides;
  createdAt: Date;
}

/** cap key -> live count of what the cap governs, wired once at composition. */
export type EntitlementCounters = Record<CapKey, (organizationId: string) => Promise<number>>;

/**
 * CORE. What an organization is allowed to do. Never imports Stripe or anything
 * billing-related — `src/billing/` is the only writer that knows about plans.
 *
 * The counter registry is injected so a call site reads `requireHeadroom(orgId, "seats")`
 * and nothing else — the counting query never leaks out of this module.
 */
export class EntitlementsService {
  constructor(
    private readonly database: Database,
    private readonly counters: EntitlementCounters,
  ) {}

  async read(organizationId: string): Promise<OrganizationEntitlements> {
    const row = await this.database.getOrganizationEntitlements(organizationId);
    if (row === undefined) {
      throw new Error(`organization has no entitlements record: ${organizationId}`);
    }
    const granted = entitlementsSchema.parse(row.granted);
    const overrides = entitlementOverridesSchema.parse(row.overrides);
    return {
      organizationId: row.organizationId,
      granted,
      overrides,
      effective: effectiveEntitlements(granted, overrides),
      planId: row.planId,
      planVersion: row.planVersion,
      stampedAt: row.stampedAt,
      updatedAt: row.updatedAt,
    };
  }

  async stamp(
    organizationId: string,
    template: EntitlementTemplate,
    from: Provenance,
  ): Promise<void> {
    const granted = entitlementsSchema.parse(template);
    await this.database.stampOrganizationEntitlements({
      organizationId,
      granted,
      planId: from.planId,
      planVersion: hashTemplate(granted),
      source: from.source,
      actor: from.actor ?? null,
      reason: from.reason ?? null,
    });
  }

  /**
   * Fold a hand-set patch into the organization's overrides. `granted` is untouched, so
   * a later plan re-stamp never clobbers this deal — that split is the whole point.
   */
  async override(
    organizationId: string,
    patch: EntitlementPatch,
    by: string | null,
    reason: string,
  ): Promise<void> {
    const current = await this.read(organizationId);
    const overrides = mergeOverrides(current.overrides, patch);
    await this.database.overrideOrganizationEntitlements({
      organizationId,
      overrides,
      actor: by,
      reason,
    });
  }

  /**
   * Reject the caller when a capped entitlement has no room left for one more. Unlimited
   * caps return immediately; otherwise the module counts the live usage itself.
   */
  async requireHeadroom(organizationId: string, cap: CapKey): Promise<void> {
    const { effective } = await this.read(organizationId);
    const limit = capLimit(effective, cap);
    if (limit === null) return;
    const current = await this.counters[cap](organizationId);
    if (current >= limit) throw new EntitlementDenied(cap, limit, current);
  }

  async history(organizationId: string, limit: number): Promise<EntitlementChange[]> {
    const changes = await this.database.listEntitlementChanges(organizationId, limit);
    return changes.map((change) => {
      const after = auditSnapshotSchema.parse(change.after);
      return {
        id: change.id,
        actor: change.actor,
        actorName: change.actorName,
        source: change.source,
        reason: change.reason,
        effective: effectiveEntitlements(after.granted, after.overrides),
        overrides: after.overrides,
        createdAt: change.createdAt,
      };
    });
  }
}

/** The `{ granted, overrides }` snapshot every audit row stores as its before/after. */
const auditSnapshotSchema = z
  .object({ granted: entitlementsSchema, overrides: entitlementOverridesSchema })
  .strict();
