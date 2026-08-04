import type { AuthServer } from "../auth/server.js";
import type { Database, TenantRouteAccess } from "../db/types.js";

export class ProjectTenantResolver {
  constructor(private readonly database: Database) {}

  async resolve(input: {
    userId: string;
    organizationSlug: string;
    projectSlug?: string;
  }): Promise<TenantRouteAccess> {
    const access = await this.database.resolveTenantRouteAccess(
      input.userId,
      input.organizationSlug,
      input.projectSlug,
    );
    if (access === undefined) throw new TenantRouteNotFoundError();
    return access;
  }
}

export async function resolveRouteTenant(
  auth: AuthServer,
  database: Database,
  request: Request,
  scope: { organizationSlug: string; projectSlug?: string },
): Promise<{
  account: Awaited<ReturnType<AuthServer["resolveAccount"]>>;
  tenant: TenantRouteAccess;
}> {
  const account = await auth.resolveAccount(request);
  const tenant = await new ProjectTenantResolver(database).resolve({
    userId: account.account.id,
    organizationSlug: scope.organizationSlug,
    ...(scope.projectSlug === undefined ? {} : { projectSlug: scope.projectSlug }),
  });
  return { account, tenant };
}

export class TenantRouteNotFoundError extends Error {
  constructor() {
    super("tenant route not found");
    this.name = "TenantRouteNotFoundError";
  }
}
