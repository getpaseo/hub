import { createHash, randomBytes } from "node:crypto";
import { ProductRequestError } from "../auth/organization-access.js";
import type { AuthServer } from "../auth/server.js";
import { ConnectionAccessDeniedError, ConnectionConflictError } from "../db/errors.js";
import type {
  ConnectionAccountAccess,
  ConnectionStartAuthority,
  Database,
  TenantRouteAccess,
} from "../db/types.js";
import { logger } from "../logger.js";
import { resolveRouteTenant } from "../projects/access.js";

export const CONNECTION_ATTEMPT_LIFETIME_MINUTES = 10;

export async function manageConnectionAccess(
  auth: AuthServer,
  database: Database,
  request: Request,
): Promise<{
  account: Awaited<ReturnType<AuthServer["resolveAccount"]>>;
  tenant: TenantRouteAccess;
  returnRoute: string;
}> {
  const url = new URL(request.url);
  const organizationSlug = url.searchParams.get("organizationSlug");
  if (organizationSlug === null) throw new ConnectionAccessDeniedError();
  const { account, tenant } = await resolveRouteTenant(auth, database, request, {
    organizationSlug,
  });
  if (tenant.membership.role === "member") throw new ConnectionAccessDeniedError();
  const returnRoute = `/o/${tenant.organization.slug}/connections`;
  return { account, tenant, returnRoute };
}

export function connectionAccess(
  access: Awaited<ReturnType<typeof manageConnectionAccess>>,
): ConnectionStartAuthority {
  return {
    sessionId: access.account.session.id,
    userId: access.account.account.id,
    membershipId: access.tenant.membership.id,
    organizationId: access.tenant.organization.id,
    returnRoute: access.returnRoute,
  };
}

export async function callbackConnectionAccess(
  auth: AuthServer,
  request: Request,
): Promise<ConnectionAccountAccess> {
  const account = await auth.resolveAccount(request);
  return { sessionId: account.session.id, userId: account.account.id };
}

export function newConnectionState(): string {
  return randomBytes(32).toString("base64url");
}

export function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export function connectionResult(
  publicBaseUrl: string,
  returnRoute: string,
  result: string,
): Response {
  const url = new URL(returnRoute, publicBaseUrl);
  url.searchParams.set("result", result);
  return Response.redirect(url, 303);
}

export function connectionActionFailure(
  error: unknown,
  provider: string,
  action: "start" | "disconnect",
): Response {
  if (error instanceof ConnectionAccessDeniedError || error instanceof ProductRequestError) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (error instanceof ConnectionConflictError) {
    return Response.json({ error: "already_connected" }, { status: 409 });
  }
  logger.error(
    {
      provider,
      action,
      errorType: error instanceof Error ? error.name : "UnknownError",
    },
    "connection action unavailable",
  );
  return Response.json({ error: "connection_unavailable" }, { status: 503 });
}

export function positiveInteger(value: string | null): number | undefined {
  if (value === null || !/^[1-9]\d*$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

export function requiredConnectionId(request: Request): string {
  const value = new URL(request.url).searchParams.get("connectionId");
  if (
    value === null ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new ConnectionAccessDeniedError();
  }
  return value;
}

export function readNonEmptyEnvironmentVariable(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name];
  return value === undefined || value.length === 0 ? undefined : value;
}
