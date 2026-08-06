import type { Database, EntitlementChangeSource } from "../db/types.js";
import {
  effectiveEntitlements,
  entitlementOverridesSchema,
  entitlementsSchema,
  hashTemplate,
  type EntitlementOverrides,
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

/**
 * CORE. What an organization is allowed to do. Never imports Stripe or anything
 * billing-related — `src/billing/` is the only writer that knows about plans.
 */
export class EntitlementsService {
  constructor(private readonly database: Database) {}

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
}
