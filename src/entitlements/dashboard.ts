import type { AuthServer } from "../auth/server.js";
import { capabilitiesFor } from "../auth/organization-policy.js";
import type { Database } from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import type { EntitlementPatch } from "./catalog.js";
import type {
  EntitlementChange,
  EntitlementsService,
  OrganizationEntitlements,
} from "./service.js";

const HISTORY_LIMIT = 20;

export interface EntitlementsRouteScope {
  organizationSlug: string;
}

export interface OverrideEntitlementsInput {
  patch: EntitlementPatch;
  reason: string;
}

export class EntitlementsForbiddenError extends Error {
  constructor() {
    super("managing entitlements requires the manage-resources capability");
    this.name = "EntitlementsForbiddenError";
  }
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
    const history = await this.entitlements.history(tenant.organization.id, HISTORY_LIMIT);
    return {
      account: account.account,
      organization: tenant.organization,
      membership: tenant.membership,
      capabilities: capabilitiesFor(tenant.membership.role),
      entitlements: entitlementsView(record),
      history: history.map(historyView),
    };
  }

  async override(
    request: Request,
    scope: EntitlementsRouteScope,
    input: OverrideEntitlementsInput,
  ) {
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug: scope.organizationSlug,
    });
    if (!capabilitiesFor(tenant.membership.role).manageResources) {
      throw new EntitlementsForbiddenError();
    }
    await this.entitlements.override(
      tenant.organization.id,
      input.patch,
      account.account.id,
      input.reason,
    );
    return this.snapshot(request, scope);
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

function historyView(change: EntitlementChange) {
  return {
    id: change.id,
    actor: change.actor,
    actorName: change.actorName,
    source: change.source,
    reason: change.reason,
    effective: change.effective,
    overrides: change.overrides,
    createdAt: change.createdAt.toISOString(),
  };
}
