import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AuthServer } from "../../auth/server.js";
import {
  connectionAccess,
  connectionActionFailure,
  manageConnectionAccess,
  requiredConnectionId,
} from "../../connections/shared.js";
import {
  ConnectionAccessDeniedError,
  ForgejoAccountAlreadyConnectedError,
} from "../../db/errors.js";
import type { Database, ForgejoConnectionRecord } from "../../db/types.js";
import { logger } from "../../logger.js";
import type { ProviderConnectionRegistration } from "../registration.js";
import {
  ForgejoApiError,
  ForgejoRedirectRefusedError,
  type ForgejoApiClient,
  type ForgejoCredentials,
} from "./client.js";
import { classifyForgejoInstanceVersion, type ForgejoInstanceIdentity } from "./instance-flavor.js";
import { unwrapForgejoInstanceBlockedError } from "./instance-guard.js";
import { normalizeInstanceBaseUrl, readInstanceBaseUrl } from "./instance-url.js";
import { createForgejoSubscribeAction, deleteConnectionHooksDetached } from "./hooks.js";

export interface CreateForgejoConnectionOptions {
  database: Database;
  auth: AuthServer;
  api: ForgejoApiClient;
  applicationBaseUrl: string;
}

export function createForgejoConnection(
  options: CreateForgejoConnectionOptions,
): ProviderConnectionRegistration {
  const create = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      const body: unknown = await request.json().catch(() => undefined);
      const submitted = readCreateBody(body);
      if (submitted === undefined) {
        return Response.json({ error: "invalid_instance_or_token" }, { status: 400 });
      }

      let viewer: { login: string; id: number };
      try {
        viewer = await options.api.readViewer({
          instanceBaseUrl: submitted.instanceBaseUrl,
          accessToken: submitted.accessToken,
        });
      } catch (error) {
        // the ssrf guard also fires here: a blocked or redirected host never reaches
        // bindForgejoConnection below, so nothing is stored for a refused address
        return tokenVerificationFailure(error);
      }

      const identity = await readForgejoInstanceIdentityOrFailure(options.api, {
        instanceBaseUrl: submitted.instanceBaseUrl,
        accessToken: submitted.accessToken,
      });
      if ("failure" in identity) return identity.failure;

      // bindForgejoConnection always inserts a fresh row, so without this check the same
      // account on the same instance could be bound twice: if both subscribe to
      // overlapping repositories, hub gets two deliveries for the same event and runs
      // every matching trigger twice. not one transaction with the insert below, so two
      // connects racing this closely enough could still both pass it.
      const usage = await options.database.organizationConnectionUsage(
        access.tenant.organization.id,
      );
      const existing = usage.forgejo.find(
        (bound) =>
          bound.instanceBaseUrl === submitted.instanceBaseUrl && bound.accountId === viewer.id,
      );
      if (existing !== undefined) {
        return Response.json(
          {
            error: "account_already_connected",
            connectionId: existing.id,
            connectionSlug: existing.slug,
          },
          { status: 409 },
        );
      }

      const connection = await options.database.bindForgejoConnection({
        access: connectionAccess(access),
        instanceBaseUrl: submitted.instanceBaseUrl,
        instanceHost: new URL(submitted.instanceBaseUrl).host,
        // generated here, never accepted from the caller
        webhookSecret: randomBytes(32).toString("hex"),
        accessToken: submitted.accessToken,
        accountLogin: viewer.login,
        accountId: viewer.id,
        instanceFlavor: identity.identity.flavor,
        instanceVersion: identity.identity.version,
      });
      return Response.json({
        connection: {
          id: connection.id,
          slug: connection.slug,
          instanceBaseUrl: connection.instanceBaseUrl,
          accountLogin: connection.accountLogin,
          webhookSecret: connection.webhookSecret,
          webhookUrl: forgejoWebhookUrl(options.applicationBaseUrl, connection.id),
        },
      });
    } catch (error) {
      // only fires when two connects race past the pre-check above and the database's
      // own unique index stops the second insert; same response shape either way
      if (error instanceof ForgejoAccountAlreadyConnectedError) {
        return Response.json(
          {
            error: "account_already_connected",
            connectionId: error.connectionId,
            connectionSlug: error.connectionSlug,
          },
          { status: 409 },
        );
      }
      return connectionActionFailure(error, "forgejo", "create");
    }
  };

  // hooks are deleted best effort, detached, so an unreachable instance never holds up
  // the response. takes the same hook lease subscribe does, so a racing subscribe can't
  // record a hook against a row this call just deleted.
  const disconnect = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      const connectionId = requiredConnectionId(request);
      await requireOwnForgejoConnection(options.database, access, connectionId);
      return await withForgejoHookLease(
        options.database,
        access.tenant.organization.id,
        connectionId,
        async () => {
          const hooks = await options.database.listForgejoWebhooks(connectionId);
          const result = await options.database.disconnectConnection(
            "forgejo",
            connectionId,
            connectionAccess(access),
          );
          if (
            result.provider === "forgejo" &&
            result.instanceBaseUrl !== undefined &&
            result.accessToken !== undefined
          ) {
            const credentials = {
              instanceBaseUrl: result.instanceBaseUrl,
              accessToken: result.accessToken,
            };
            deleteConnectionHooksDetached(
              options.api,
              credentials,
              forgejoWebhookUrl(options.applicationBaseUrl, connectionId),
              hooks,
              { connectionId },
            );
          }
          return Response.json({ disconnected: true });
        },
      );
    } catch (error) {
      return connectionActionFailure(error, "forgejo", "disconnect");
    }
  };

  // a listing failure answers an empty list with unavailable: true so the
  // "all my repositories" choice still works without it
  const orgs = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      const connection = await requireOwnForgejoConnection(
        options.database,
        access,
        requiredConnectionId(request),
      );
      // sent so the row action's manual fallback never has to rebuild the url from
      // window.location; the secret's already visible to this caller via manageConnectionAccess
      const webhookUrl = forgejoWebhookUrl(options.applicationBaseUrl, connection.id);
      const webhookSecret = connection.webhookSecret;
      try {
        const found = await options.api.listMyOrgs(credentialsFor(connection));
        return Response.json({ orgs: found, unavailable: false, webhookUrl, webhookSecret });
      } catch (error) {
        logger.warn(
          { err: error, provider: "forgejo" },
          "forgejo org listing failed, offering none",
        );
        return Response.json({ orgs: [], unavailable: true, webhookUrl, webhookSecret });
      }
    } catch (error) {
      return connectionActionFailure(error, "forgejo", "orgs");
    }
  };

  // fixes a revoked token without disconnect+reconnect, which would orphan the hook
  // already on the instance; the new token still has to name the same account
  const replaceToken = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      const connection = await requireOwnForgejoConnection(
        options.database,
        access,
        requiredConnectionId(request),
      );
      const body: unknown = await request.json().catch(() => undefined);
      const submitted = readReplaceTokenBody(body);
      if (submitted === undefined) {
        return Response.json({ error: "invalid_token" }, { status: 400 });
      }

      let viewer: { login: string; id: number };
      try {
        viewer = await options.api.readViewer({
          instanceBaseUrl: connection.instanceBaseUrl,
          accessToken: submitted.accessToken,
        });
      } catch (error) {
        return tokenVerificationFailure(error);
      }

      if (viewer.id !== connection.accountId) {
        return Response.json({ error: "token_account_mismatch" }, { status: 422 });
      }

      const identity = await readForgejoInstanceIdentityOrFailure(options.api, {
        instanceBaseUrl: connection.instanceBaseUrl,
        accessToken: submitted.accessToken,
      });
      if ("failure" in identity) return identity.failure;

      await options.database.replaceForgejoConnectionToken({
        connectionId: connection.id,
        organizationId: access.tenant.organization.id,
        accessToken: submitted.accessToken,
        instanceFlavor: identity.identity.flavor,
        instanceVersion: identity.identity.version,
      });
      return Response.json({ replaced: true });
    } catch (error) {
      return connectionActionFailure(error, "forgejo", "replaceToken");
    }
  };

  return {
    name: "forgejo",
    status: (connections) => forgejoStatus(true, connections.forgejo),
    actions: {
      create,
      disconnect,
      orgs,
      subscribe: createForgejoSubscribeAction(options),
      replaceToken,
    },
  };
}

// a 403 means the instance refused the token reading its own user; everything else
// (bad address, unreachable, garbage token) folds into instance_rejected_token
function tokenVerificationFailure(error: unknown): Response {
  if (unwrapForgejoInstanceBlockedError(error) !== undefined) {
    return Response.json({ error: "instance_address_blocked" }, { status: 400 });
  }
  if (error instanceof ForgejoRedirectRefusedError) {
    return Response.json({ error: "instance_redirected" }, { status: 400 });
  }
  if (error instanceof ForgejoApiError && error.status === 403) {
    return Response.json({ error: "insufficient_token_scopes" }, { status: 422 });
  }
  logger.warn({ err: error, provider: "forgejo" }, "forgejo token verification failed");
  return Response.json({ error: "instance_rejected_token" }, { status: 400 });
}

// a 404 on GET /version reads the same as an unrecognized version string, most
// commonly Gogs, which this integration does not support
async function readForgejoInstanceIdentityOrFailure(
  api: ForgejoApiClient,
  credentials: ForgejoCredentials,
): Promise<{ identity: ForgejoInstanceIdentity } | { failure: Response }> {
  try {
    const { version } = await api.readVersion(credentials);
    const identity = classifyForgejoInstanceVersion(version);
    if (identity === undefined) {
      return { failure: Response.json({ error: "instance_unsupported_flavor" }, { status: 400 }) };
    }
    return { identity };
  } catch (error) {
    if (error instanceof ForgejoApiError && error.status === 404) {
      return { failure: Response.json({ error: "instance_unsupported_flavor" }, { status: 400 }) };
    }
    return { failure: tokenVerificationFailure(error) };
  }
}

const CreateBodySchema = z.object({
  instanceBaseUrl: z.string(),
  accessToken: z.string(),
});

function readCreateBody(
  body: unknown,
): { instanceBaseUrl: string; accessToken: string } | undefined {
  const parsed = CreateBodySchema.safeParse(body);
  if (!parsed.success) return undefined;
  const instanceBaseUrl = readInstanceBaseUrl(parsed.data.instanceBaseUrl);
  const accessToken = parsed.data.accessToken.trim();
  if (instanceBaseUrl === undefined || accessToken.length === 0) return undefined;
  return { instanceBaseUrl, accessToken };
}

const ReplaceTokenBodySchema = z.object({ accessToken: z.string() });

function readReplaceTokenBody(body: unknown): { accessToken: string } | undefined {
  const parsed = ReplaceTokenBodySchema.safeParse(body);
  if (!parsed.success) return undefined;
  const accessToken = parsed.data.accessToken.trim();
  if (accessToken.length === 0) return undefined;
  return { accessToken };
}

// built server-side so it's right regardless of which host the operator reached this hub at
export function forgejoWebhookUrl(applicationBaseUrl: string, connectionId: string): string {
  return `${normalizeInstanceBaseUrl(applicationBaseUrl)}/api/integrations/forgejo/events/${connectionId}`;
}

// holds the row-level lease that serializes subscribe and disconnect; a lease someone
// else holds answers 409 straight away instead of waiting
export async function withForgejoHookLease(
  database: Pick<Database, "claimForgejoHookLease" | "releaseForgejoHookLease">,
  organizationId: string,
  connectionId: string,
  operation: () => Promise<Response>,
): Promise<Response> {
  const leaseId = await database.claimForgejoHookLease(connectionId, organizationId);
  if (leaseId === undefined) {
    return Response.json({ error: "operation_in_progress" }, { status: 409 });
  }
  try {
    return await operation();
  } finally {
    await database.releaseForgejoHookLease(connectionId, leaseId).catch((error: unknown) => {
      logger.warn(
        { err: error, provider: "forgejo", connectionId },
        "forgejo hook lease release failed, it expires on its own",
      );
    });
  }
}

export function credentialsFor(connection: ForgejoConnectionRecord): ForgejoCredentials {
  return { instanceBaseUrl: connection.instanceBaseUrl, accessToken: connection.accessToken };
}

// findForgejoConnection is keyed by id alone for the webhook endpoint's sake, so every
// action that touches the stored token checks the organization here first
export async function requireOwnForgejoConnection(
  database: Database,
  access: { tenant: { organization: { id: string } } },
  connectionId: string,
): Promise<ForgejoConnectionRecord> {
  const connection = await database.findForgejoConnection(connectionId);
  if (connection === undefined || connection.organizationId !== access.tenant.organization.id) {
    throw new ConnectionAccessDeniedError();
  }
  return connection;
}

export function forgejoStatus(configured: boolean, bindings: readonly ForgejoConnectionRecord[]) {
  if (!configured) return { status: "notConfigured" as const };
  return bindings.length === 0
    ? { status: "disconnected" as const }
    : { status: "connected" as const };
}
