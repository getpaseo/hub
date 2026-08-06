import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresPool } from "../db/pg.js";
import { z } from "zod";
import * as schema from "../db/schema.js";
import { OrganizationApiKeys } from "./api-keys.js";
import { bootstrapInstance } from "./bootstrap.js";
import {
  defaultInstanceAuthPolicy,
  PASSWORD_MIN_LENGTH,
  type InstanceAuthPolicy,
} from "./instance-policy.js";
import { RegistrationAdmission, RegistrationAdmissionError } from "./registration-admission.js";
import type {
  OrganizationResourceReader,
  OrganizationResources,
} from "../organizations/resources.js";
import {
  countOrganizationSeatUsage,
  OrganizationAccess,
  type AccountAccessValue,
  type AccountSession,
  type OrganizationAccessValue,
} from "./organization-access.js";
import { paseoOrganizationPlugin } from "./organization-policy.js";
import { EntitlementsService } from "../entitlements/service.js";
import type { Database } from "../db/types.js";

export interface AuthServer {
  handle(request: Request): Promise<Response>;
  browserAccount?(request: Request): Promise<Response>;
  signInEmail?(data: { email: string; password: string }, headers: Headers): Promise<void>;
  signUpEmail?(
    data: { name: string; email: string; password: string },
    headers: Headers,
    invitationId?: string,
  ): Promise<void>;
  signOut?(headers: Headers): Promise<void>;
  changePassword?(
    data: { currentPassword: string; newPassword: string },
    headers: Headers,
  ): Promise<void>;
  resources(
    request: Request,
    organizations: OrganizationResources,
  ): Promise<OrganizationResourceReader>;
  resolveOrganizationAccess(request: Request): Promise<OrganizationAccessValue>;
  resolveAccount(request: Request): Promise<AccountAccessValue>;
  rejectCookieMutation(request: Request): Response | undefined;
  initialize?(): Promise<void>;
  apiKeys?: OrganizationApiKeys;
  /**
   * The organization entitlements module, shared with the dashboard so there is one owner.
   * Present whenever a `Database` handle is wired (every real deployment); omitted only by
   * auth-focused test doubles that don't touch entitlements.
   */
  entitlements?: EntitlementsService;
  close(): Promise<void>;
}

interface AuthServerOptions {
  /** Wires entitlements enforcement + the dashboard. Every real composition passes it. */
  database?: Database;
  databaseUrl: string;
  secret: string;
  baseURL: string;
  policy?: InstanceAuthPolicy;
  trustedClientIpHeader?: string;
}

const sessionSchema = z.object({
  session: z
    .object({
      id: z.string(),
      userId: z.string(),
      activeOrganizationId: z.string().nullable().optional(),
    })
    .passthrough(),
  user: z
    .object({
      id: z.string(),
      name: z.string(),
      email: z.string(),
      mustChangePassword: z.boolean().optional(),
    })
    .passthrough(),
});

const RAW_PRODUCT_PATHS = new Set([
  "/api/auth/get-session",
  "/api/auth/sign-up/email",
  "/api/auth/sign-in/email",
  "/api/auth/sign-out",
  "/api/auth/change-password",
]);

export function createAuthServer(options: AuthServerOptions): AuthServer {
  const pool = createPostgresPool(options.databaseUrl);
  const database = drizzle(pool, { schema });
  const policy = options.policy ?? defaultInstanceAuthPolicy();
  const apiKeys = new OrganizationApiKeys(pool);
  const registration = new RegistrationAdmission(pool, policy);
  const authSchema = {
    user: schema.users,
    session: schema.sessions,
    account: schema.accounts,
    verification: schema.verifications,
    organization: schema.organizations,
    member: schema.members,
    invitation: schema.invitations,
  };
  const auth = betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    ...(options.trustedClientIpHeader === undefined
      ? {}
      : {
          advanced: {
            ipAddress: {
              ipAddressHeaders: [options.trustedClientIpHeader],
            },
          },
        }),
    database: drizzleAdapter(database, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: true, minPasswordLength: PASSWORD_MIN_LENGTH },
    user: {
      additionalFields: {
        mustChangePassword: {
          type: "boolean",
          defaultValue: false,
          input: false,
          returned: true,
        },
      },
    },
    plugins: [paseoOrganizationPlugin(), tanstackStartCookies()],
  });
  const sessions = {
    async read(headers: Headers): Promise<AccountSession | undefined> {
      const value = await auth.api.getSession({ headers });
      const parsed = sessionSchema.safeParse(value);
      if (!parsed.success) return undefined;
      return {
        sessionId: parsed.data.session.id,
        userId: parsed.data.user.id,
        name: parsed.data.user.name,
        email: parsed.data.user.email,
        activeOrganizationId: parsed.data.session.activeOrganizationId ?? null,
        mustChangePassword: parsed.data.user.mustChangePassword ?? false,
      };
    },
  };
  const entitlements =
    options.database === undefined
      ? undefined
      : new EntitlementsService(options.database, {
          seats: (organizationId) => countOrganizationSeatUsage(pool, organizationId),
        });
  const access = new OrganizationAccess({
    pool,
    sessions,
    baseURL: options.baseURL,
    policy,
    apiKeys,
    ...(entitlements === undefined ? {} : { entitlements }),
  });
  const browserOrigin = new URL(options.baseURL).origin;

  return {
    handle(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/auth/paseo/")) {
        const rejected = rejectCrossOriginCookieMutation(request, browserOrigin);
        if (rejected !== undefined) return Promise.resolve(rejected);
        return access.handle(request);
      }
      if (path === "/api/auth/sign-up/email") {
        return registration
          .handleSignUp(request, (admittedRequest) => auth.handler(admittedRequest))
          .catch((error: unknown) => {
            if (error instanceof RegistrationAdmissionError) {
              return Response.json({ error: "registration_closed" }, { status: 403 });
            }
            throw error;
          });
      }
      if (path === "/api/auth/change-password") {
        const rejected = rejectCrossOriginCookieMutation(request, browserOrigin);
        if (rejected !== undefined) return Promise.resolve(rejected);
        return changePassword(request);
      }
      if (!RAW_PRODUCT_PATHS.has(path)) {
        return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
      }
      return auth.handler(request);
    },
    browserAccount: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/change-password") {
        const rejected = rejectCrossOriginCookieMutation(request, browserOrigin);
        return rejected === undefined ? changePassword(request) : Promise.resolve(rejected);
      }
      return access.handle(request);
    },
    async signInEmail(data, headers) {
      requireBrowserOrigin(headers, browserOrigin);
      await auth.api.signInEmail({ body: data, headers });
    },
    async signUpEmail(data, headers, invitationId) {
      requireBrowserOrigin(headers, browserOrigin);
      await registration.withAdmission(data.email, invitationId, async () => {
        await auth.api.signUpEmail({ body: data, headers });
      });
    },
    async signOut(headers) {
      requireBrowserOrigin(headers, browserOrigin);
      await auth.api.signOut({ headers });
    },
    async changePassword(data, headers) {
      requireBrowserOrigin(headers, browserOrigin);
      const session = await sessions.read(headers);
      if (session === undefined) throw new Error("unauthenticated");
      await auth.api.changePassword({
        body: { ...data, revokeOtherSessions: true },
        headers,
      });
      await pool.query(
        `update "user" set must_change_password = false, updated_at = now() where id = $1`,
        [session.userId],
      );
    },
    async resources(request, organizations) {
      return access.resources(request, organizations);
    },
    resolveOrganizationAccess: (request) => access.resolve(request),
    resolveAccount: (request) => access.account(request),
    rejectCookieMutation: (request) => rejectCrossOriginCookieMutation(request, browserOrigin),
    initialize: () => bootstrapInstance(pool, policy),
    apiKeys,
    ...(entitlements === undefined ? {} : { entitlements }),
    close: () => pool.end(),
  };

  async function changePassword(request: Request): Promise<Response> {
    const session = await sessions.read(request.headers);
    const body = await request
      .clone()
      .json()
      .then((value: unknown) => value)
      .catch(() => undefined);
    const response =
      typeof body === "object" && body !== null
        ? await auth.handler(
            new Request(request.url, {
              method: "POST",
              headers: request.headers,
              body: JSON.stringify({ ...body, revokeOtherSessions: true }),
            }),
          )
        : await auth.handler(request);
    if (response.ok && session !== undefined) {
      await pool.query(`update "user" set must_change_password = false where id = $1`, [
        session.userId,
      ]);
    }
    return response;
  }
}

function requireBrowserOrigin(headers: Headers, browserOrigin: string): void {
  const suppliedOrigin = headers.get("origin") ?? headers.get("referer");
  if (suppliedOrigin === null || suppliedOrigin === "null") throw new Error("invalid origin");
  try {
    if (new URL(suppliedOrigin).origin === browserOrigin) return;
  } catch {
    // Invalid browser origins are rejected below.
  }
  throw new Error("invalid origin");
}

function rejectCrossOriginCookieMutation(
  request: Request,
  browserOrigin: string,
): Response | undefined {
  if (request.method !== "POST" || !request.headers.has("cookie")) return undefined;
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return authBoundaryError(
      "Cross-site navigation login blocked. This request appears to be a CSRF attack.",
      "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
    );
  }
  const suppliedOrigin = request.headers.get("origin") ?? request.headers.get("referer");
  if (suppliedOrigin === null || suppliedOrigin === "null") {
    return authBoundaryError("Missing or null Origin", "MISSING_OR_NULL_ORIGIN");
  }
  try {
    if (new URL(suppliedOrigin).origin === browserOrigin) return undefined;
  } catch {
    // Invalid browser origins fail through the same public boundary as hostile origins.
  }
  return authBoundaryError("Invalid origin", "INVALID_ORIGIN");
}

function authBoundaryError(message: string, code: string): Response {
  return Response.json({ message, code }, { status: 403 });
}
