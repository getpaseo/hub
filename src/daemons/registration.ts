import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ProductRequestError, type OrganizationAccessValue } from "../auth/organization-access.js";
import type { AccountAccessValue } from "../auth/organization-access.js";
import { capabilitiesFor } from "../auth/organization-policy.js";
import type { Database, DaemonRecord } from "../db/types.js";
import { INTERNAL_CLIENT_ADDRESS_HEADER } from "../http/client-address.js";
import type { ActiveDaemonRegistry, DaemonClock } from "./registry.js";

const DEVICE_LIFETIME_SECONDS = 10 * 60;
const DEVICE_POLL_INTERVAL_SECONDS = 5;
const DEVICE_PER_FINGERPRINT_LIMIT = 5;
const DEVICE_GLOBAL_LIMIT = 1_000;

const startBody = z.object({ displayName: z.string().trim().min(1).max(100) }).strict();
const pollBody = z.object({ deviceCode: z.string().min(32).max(200) }).strict();
const codeBody = z.object({ userCode: z.string().min(1).max(40) }).strict();
const decisionBody = z.discriminatedUnion("decision", [
  codeBody
    .extend({
      decision: z.literal("approve"),
      displayName: z.string().trim().min(1).max(100),
      organizationId: z.string().min(1),
    })
    .strict(),
  codeBody.extend({ decision: z.literal("deny") }).strict(),
]);
const renameBody = z.object({ displayName: z.string().trim().min(1).max(100) }).strict();
const enrollmentBody = z
  .object({
    daemonId: z.string().uuid(),
    idempotencyKey: z.string(),
    serverId: z.string(),
    daemonPublicKey: z.string(),
    credentialVerifier: z.string(),
    scopes: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export interface BrowserOrganizationAccess {
  resolveOrganizationAccess(request: Request): Promise<OrganizationAccessValue>;
  resolveAccount(request: Request): Promise<AccountAccessValue>;
  rejectCookieMutation(request: Request): Response | undefined;
}

interface DaemonRegistrationOptions {
  database: Database;
  activeDaemons: ActiveDaemonRegistry;
  access?: BrowserOrganizationAccess;
  publicBaseUrl?: string;
}

export class DaemonRegistration {
  constructor(private readonly options: DaemonRegistrationOptions) {}

  async start(request: Request): Promise<Response> {
    const input = await parseRequest(request, startBody);
    if (input instanceof Response) return input;
    const deviceCode = randomBytes(32).toString("base64url");
    const userCode = formatUserCode(base32(randomBytes(8)));
    const authorization = await this.options.database.startDeviceAuthorization({
      id: randomUUID(),
      deviceVerifier: verifier(deviceCode),
      userCodeVerifier: verifier(normalizeUserCode(userCode)),
      fingerprintVerifier: requestFingerprint(request),
      suggestedDisplayName: input.displayName,
      lifetimeSeconds: DEVICE_LIFETIME_SECONDS,
      pollIntervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
      perFingerprintLimit: DEVICE_PER_FINGERPRINT_LIMIT,
      globalLimit: DEVICE_GLOBAL_LIMIT,
    });
    if (authorization === undefined) {
      return Response.json(
        { status: "retry_later", interval: DEVICE_POLL_INTERVAL_SECONDS },
        {
          status: 429,
          headers: { "retry-after": String(DEVICE_POLL_INTERVAL_SECONDS) },
        },
      );
    }
    const verificationUri = new URL("/activate", this.options.publicBaseUrl ?? request.url);
    const complete = new URL(verificationUri);
    complete.searchParams.set("code", userCode);
    return Response.json(
      {
        deviceCode,
        userCode,
        verificationUri: verificationUri.toString(),
        verificationUriComplete: complete.toString(),
        expiresAt: authorization.expiresAt.toISOString(),
        interval: authorization.pollIntervalSeconds,
      },
      { status: 201 },
    );
  }

  async poll(request: Request): Promise<Response> {
    const input = await parseRequest(request, pollBody);
    if (input instanceof Response) return input;
    const enrollmentToken = deriveEnrollmentToken(input.deviceCode);
    const outcome = await this.options.database.pollDeviceAuthorization({
      deviceVerifier: verifier(input.deviceCode),
      enrollmentTokenVerifier: verifier(enrollmentToken),
    });
    return Response.json({
      status: outcome.status,
      interval: outcome.intervalSeconds,
      ...(outcome.status === "approved" ? { enrollmentToken } : {}),
    });
  }

  async inspect(request: Request): Promise<Response> {
    const access = await this.browserAccess(request, true);
    if (access instanceof Response) return access;
    const input = await parseRequest(request, codeBody);
    if (input instanceof Response) return input;
    const authorization = await this.options.database.inspectDeviceAuthorization(
      verifier(normalizeUserCode(input.userCode)),
    );
    if (authorization === undefined) return unavailableAuthorization();
    return Response.json({
      displayName: authorization.suggestedDisplayName,
      expiresAt: authorization.expiresAt.toISOString(),
      organization: access.organization,
      canManage: access.capabilities.manageResources,
    });
  }

  async decide(request: Request): Promise<Response> {
    const access = await this.browserAccess(request, true);
    if (access instanceof Response) return access;
    if (!access.capabilities.manageResources) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const input = await parseRequest(request, decisionBody);
    if (input instanceof Response) return input;
    if (input.decision === "approve" && input.organizationId !== access.organization.id) {
      return Response.json({ error: "organization_required" }, { status: 403 });
    }
    const decisionAccess = {
      sessionId: access.session.id,
      userId: access.account.id,
      membershipId: access.membership.id,
      organizationId: access.organization.id,
    };
    const decision =
      input.decision === "approve"
        ? {
            userCodeVerifier: verifier(normalizeUserCode(input.userCode)),
            decision: input.decision,
            displayName: input.displayName,
            access: decisionAccess,
          }
        : {
            userCodeVerifier: verifier(normalizeUserCode(input.userCode)),
            decision: input.decision,
            access: decisionAccess,
          };
    const outcome = await this.options.database.decideDeviceAuthorization(decision);
    if (outcome === "unavailable") return unavailableAuthorization();
    if (outcome === "forbidden") {
      return Response.json({ error: "organization_required" }, { status: 403 });
    }
    return Response.json({ status: outcome });
  }

  async list(request: Request): Promise<Response> {
    const access = await this.browserRouteAccess(request, false);
    if (access instanceof Response) return access;
    const daemons = await this.options.database.listDaemonsForOrganization(access.organization.id);
    return Response.json({
      daemons: daemons.map(daemonSummary),
      canManage: access.capabilities.manageResources,
    });
  }

  async rename(request: Request, daemonId: string): Promise<Response> {
    const access = await this.browserRouteAccess(request, true);
    if (access instanceof Response) return access;
    if (!access.capabilities.manageResources) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const input = await parseRequest(request, renameBody);
    if (input instanceof Response) return input;
    const daemon = await this.options.database.renameDaemonForOrganization(
      access.organization.id,
      daemonId,
      input.displayName,
    );
    return daemon === undefined ? unavailableDaemon() : Response.json(daemonSummary(daemon));
  }

  async revoke(request: Request, daemonId: string): Promise<Response> {
    const access = await this.browserRouteAccess(request, true);
    if (access instanceof Response) return access;
    if (!access.capabilities.manageResources) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const daemon = await this.options.database.findDaemonForOrganization(
      access.organization.id,
      daemonId,
    );
    if (daemon === undefined) return unavailableDaemon();
    await this.options.database.revokeDaemon(daemon.id);
    await this.options.activeDaemons.revoke(daemon);
    return new Response(null, { status: 204 });
  }

  private async browserAccess(
    request: Request,
    mutation: boolean,
  ): Promise<OrganizationAccessValue | Response> {
    if (this.options.access === undefined) {
      return Response.json({ error: "auth_unavailable" }, { status: 503 });
    }
    if (mutation) {
      const rejected = this.options.access.rejectCookieMutation(request);
      if (rejected !== undefined) return rejected;
    }
    try {
      return await this.options.access.resolveOrganizationAccess(request);
    } catch (error) {
      if (error instanceof ProductRequestError) return error.response();
      throw error;
    }
  }

  private async browserRouteAccess(
    request: Request,
    mutation: boolean,
  ): Promise<OrganizationAccessValue | Response> {
    if (this.options.access === undefined) {
      return Response.json({ error: "auth_unavailable" }, { status: 503 });
    }
    if (mutation) {
      const rejected = this.options.access.rejectCookieMutation(request);
      if (rejected !== undefined) return rejected;
    }
    const organizationSlug = new URL(request.url).searchParams.get("organizationSlug");
    if (organizationSlug === null) {
      return Response.json({ error: "organization_required" }, { status: 403 });
    }
    try {
      const account = await this.options.access.resolveAccount(request);
      const tenant = await this.options.database.resolveTenantRouteAccess(
        account.account.id,
        organizationSlug,
      );
      if (tenant === undefined) {
        return Response.json({ error: "organization_unavailable" }, { status: 404 });
      }
      return {
        session: account.session,
        account: account.account,
        organization: tenant.organization,
        membership: tenant.membership,
        capabilities: capabilitiesFor(tenant.membership.role),
      };
    } catch (error) {
      if (error instanceof ProductRequestError) return error.response();
      throw error;
    }
  }
}

export function normalizeUserCode(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z2-7]/gu, "");
}

export async function issueEnrollmentToken(
  _request: Request,
  database: Database,
  organizationId: string,
  issuedByApiKeyId: string,
  clock: DaemonClock,
): Promise<Response> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(clock.nowDate().getTime() + ENROLLMENT_LIFETIME_MS);
  const issued = await database.issueEnrollmentToken({
    id: randomUUID(),
    verifier: verifier(token),
    organizationId,
    issuedByApiKeyId,
    registrationMethod: "operator",
    expiresAt,
    consumedAt: null,
  });
  if (!issued) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ token, expiresAt: expiresAt.toISOString() }, { status: 201 });
}

export async function enrollDaemon(
  request: Request,
  database: Database,
  publicBaseUrl?: string,
  clock: DaemonClock = { nowDate: () => new Date() },
): Promise<Response> {
  const token = bearer(request.headers.get("authorization") ?? undefined);
  if (token === undefined) return Response.json({ error: "unauthorized" }, { status: 401 });
  const input = enrollmentBody.safeParse(await request.json().catch(() => undefined));
  if (!input.success) return Response.json({ error: "invalid enrollment" }, { status: 400 });
  const daemon = await database.enrollDaemon({
    ...input.data,
    scopes: ["hub.execution.*"],
    tokenVerifier: verifier(token),
    now: clock.nowDate(),
  });
  if (daemon === undefined) {
    return Response.json({ error: "invalid enrollment token" }, { status: 401 });
  }
  const webSocketUrl = new URL("/api/daemons/socket", publicBaseUrl ?? request.url);
  webSocketUrl.protocol = webSocketUrl.protocol === "https:" ? "wss:" : "ws:";
  return Response.json({
    daemonId: daemon.id,
    scopes: daemon.scopes,
    webSocketUrl: webSocketUrl.toString(),
  });
}

export async function revokeDaemon(
  request: Request,
  id: string,
  database: Database,
  registry: ActiveDaemonRegistry,
): Promise<Response> {
  const daemon = await database.findDaemonById(id);
  const credential = bearer(request.headers.get("authorization") ?? undefined);
  if (
    daemon === undefined ||
    credential === undefined ||
    !matchesVerifier(credential, daemon.credentialVerifier)
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  await database.revokeDaemon(id);
  await registry.revoke(daemon);
  return new Response(null, { status: 204 });
}

function deriveEnrollmentToken(deviceCode: string): string {
  return createHash("sha256")
    .update("paseo-device-enrollment\0")
    .update(deviceCode)
    .digest("base64url");
}

function requestFingerprint(request: Request): string {
  return verifier(request.headers.get(INTERNAL_CLIENT_ADDRESS_HEADER) ?? "unknown");
}

function verifier(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function matchesVerifier(value: string, expectedVerifier: string): boolean {
  const actual = Buffer.from(verifier(value));
  const expected = Buffer.from(expectedVerifier);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function bearer(value: string | undefined): string | undefined {
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function base32(value: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  let result = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}

function formatUserCode(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
}

async function parseRequest<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema,
): Promise<z.output<TSchema> | Response> {
  const parsed = schema.safeParse(await request.json().catch(() => undefined));
  return parsed.success
    ? parsed.data
    : Response.json({ error: "invalid_request" }, { status: 400 });
}

function daemonSummary(daemon: DaemonRecord) {
  return {
    id: daemon.id,
    stableIdentity: daemon.id.slice(0, 8),
    slug: daemon.slug,
    displayName: daemon.displayName,
    status: daemon.status,
    presence: daemon.presence,
    connectedAt: daemon.connectedAt?.toISOString() ?? null,
    lastSeenAt: daemon.lastSeenAt.toISOString(),
    registeredAt: daemon.createdAt.toISOString(),
    registrationMethod: daemon.registrationMethod,
  };
}

function unavailableAuthorization(): Response {
  return Response.json({ error: "authorization_unavailable" }, { status: 404 });
}

function unavailableDaemon(): Response {
  return Response.json({ error: "daemon_unavailable" }, { status: 404 });
}

export const ENROLLMENT_LIFETIME_MS = 10 * 60_000;
