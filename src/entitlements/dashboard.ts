import type { AuthServer } from "../auth/server.js";
import { capabilitiesFor } from "../auth/organization-policy.js";
import type { Database } from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import type { EntitlementsService, OrganizationEntitlements } from "./service.js";

export interface EntitlementsRouteScope {
  organizationSlug: string;
}

export class EntitlementsDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly entitlements: EntitlementsService,
  ) {}

  async snapshot(request: Request, scope: EntitlementsRouteScope) {
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug: scope.organizationSlug,
    });
    const record = await this.entitlements.read(tenant.organization.id);
    return {
      account: account.account,
      organization: tenant.organization,
      membership: tenant.membership,
      capabilities: capabilitiesFor(tenant.membership.role),
      entitlements: entitlementsView(record),
    };
  }
}

function entitlementsView(record: OrganizationEntitlements) {
  return {
    granted: record.granted,
    overrides: record.overrides,
    effective: record.effective,
    planId: record.planId,
    stampedAt: record.stampedAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
