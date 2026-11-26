import { connectionReturnUrl } from "../../../connections/result-contract.js";
import {
  INTEGRATIONS_RETURN_ROUTE,
  callbackConnectionAccess,
  cancelledConnectionResult,
  connectionAccess,
  connectionActionFailure,
  connectionCallbackFailure,
  connectionResult,
  manageConnectionAccess,
  newConnectionState,
  requiredConnectionId,
  stateHash,
} from "../../../connections/shared.js";
import { ConnectionAccessDeniedError } from "../../../db/errors.js";
import { logger } from "../../../logger.js";
import {
  ProviderApplicationError,
  ProviderVerificationError,
  toPublicConnectionView,
  type BindIntegrationConnectionPayload,
  type IntegrationConnectionCapability,
  type IntegrationConnectionRuntime,
  type IntegrationRuntimeContext,
  type IntegrationVerificationContext,
} from "../../contracts.js";
import {
  exchangeNotionOAuthToken,
  fetchNotionMe,
  notionConnectionRequiresReauthorization,
  NotionBotUserSchema,
  NotionOAuthTokenSchema,
  revokeNotionOAuthToken,
} from "./client.js";
import {
  NotionConfigSchema,
  NotionIdentitySchema,
  type NotionConfig,
  type NotionIdentity,
} from "./contracts.js";

const CONNECTION_ATTEMPT_LIFETIME_MINUTES = 10;

class NotionCallbackError extends Error {
  readonly code = "invalidInput";
  constructor(message = "invalid Notion callback") {
    super(message);
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function readNotionEnvironment(env: NodeJS.ProcessEnv): NotionConfig | undefined {
  const mode = nonEmpty(env["NOTION_MODE"]);
  const apiToken = nonEmpty(env["NOTION_API_TOKEN"]);
  const clientId = nonEmpty(env["NOTION_CLIENT_ID"]);
  const clientSecret = nonEmpty(env["NOTION_CLIENT_SECRET"]);
  const supplied = [mode, apiToken, clientId, clientSecret].some((v) => v !== undefined);
  if (!supplied) return undefined;

  if (
    mode === "internal" ||
    (mode === undefined &&
      apiToken !== undefined &&
      clientId === undefined &&
      clientSecret === undefined)
  ) {
    if (apiToken === undefined || clientId !== undefined || clientSecret !== undefined) {
      throw new Error(
        "Notion internal environment configuration requires NOTION_API_TOKEN without OAuth client credentials.",
      );
    }
    return { provider: "notion", mode: "internal", apiToken };
  }

  if (mode !== undefined && mode !== "oauth") {
    throw new Error("Notion environment configuration has an unknown NOTION_MODE value.");
  }
  if (clientId === undefined || clientSecret === undefined || apiToken !== undefined) {
    throw new Error(
      "Notion OAuth environment configuration requires NOTION_CLIENT_ID and NOTION_CLIENT_SECRET.",
    );
  }
  return { provider: "notion", mode: "oauth", clientId, clientSecret };
}

export function notionSensitiveValues(config: NotionConfig): readonly string[] {
  return config.mode === "internal" ? [config.apiToken] : [config.clientSecret];
}

export function notionPublicIdentifiers(config: NotionConfig): Readonly<Record<string, string>> {
  return config.mode === "internal"
    ? { mode: "internal" }
    : { mode: "oauth", clientId: config.clientId };
}

async function fetchBotUserResponse(fetchImpl: typeof fetch, apiToken: string): Promise<Response> {
  try {
    return await fetchNotionMe(fetchImpl, apiToken);
  } catch (error) {
    const isTimeout =
      error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    throw new ProviderVerificationError(isTimeout ? "timeout" : "network", undefined, {
      cause: error,
    });
  }
}

async function parseBotUserResponse(response: Response) {
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new ProviderVerificationError("credentialsRejected", response.status, {
      subject: "botToken",
    });
  }
  if (response.status === 429 || response.status === 529) {
    await response.body?.cancel();
    throw new ProviderVerificationError("rateLimited", response.status);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderVerificationError("upstreamUnavailable", response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProviderVerificationError("invalidResponse", response.status);
  }
  const parsed = NotionBotUserSchema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderVerificationError("invalidResponse", response.status);
  }
  return parsed.data;
}

export async function verifyNotionDirect(
  config: NotionConfig,
  context: Pick<IntegrationVerificationContext, "fetch">,
): Promise<
  | {
      readonly identity: NotionIdentity;
      readonly initialConnection?: BindIntegrationConnectionPayload;
    }
  | undefined
> {
  if (config.mode === "oauth") return undefined;

  const response = await fetchBotUserResponse(context.fetch, config.apiToken);
  const user = await parseBotUserResponse(response);
  const workspaceId = user.bot.workspace_id;
  if (workspaceId === undefined || user.bot.owner.type !== "workspace") {
    throw new ProviderVerificationError("credentialsRejected", response.status, {
      subject: "botToken",
    });
  }

  const workspaceName =
    nonEmpty(user.bot.workspace_name ?? undefined) ??
    nonEmpty(user.name ?? undefined) ??
    "Notion workspace";
  const applicationId = `internal:${user.id}`;
  return {
    identity: {
      provider: "notion",
      id: applicationId,
      name: workspaceName,
    },
    initialConnection: {
      externalId: `${workspaceId}:${user.id}`,
      displayName: workspaceName,
      providerApplicationId: applicationId,
      workspaceId,
      scopes: [],
      credentials: {
        mode: "internal",
        accessToken: config.apiToken,
      },
      metadata: {
        mode: "internal",
        botId: user.id,
        workspaceId,
        workspaceName,
        ownerType: user.bot.owner.type,
      },
    },
  };
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function createNotionConnectionRuntime(
  config: NotionConfig,
  context: IntegrationRuntimeContext,
): IntegrationConnectionRuntime {
  const disconnect = async (request: Request): Promise<Response> => {
    const rejected = context.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(context.auth, context.database, request);
      const removed = await context.database.integrations.disconnect(
        "notion",
        requiredConnectionId(request),
        connectionAccess(access),
      );
      if (
        config.mode === "oauth" &&
        removed.credentials["mode"] === "oauth" &&
        typeof removed.credentials["accessToken"] === "string"
      ) {
        void revokeNotionOAuthToken({
          fetch: context.fetch,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          token: removed.credentials["accessToken"],
        }).catch((error: unknown) => {
          logger.warn(
            { err: error, provider: "notion" },
            "provider cleanup failed after disconnect",
          );
        });
      }
      return Response.json({ disconnected: true });
    } catch (error) {
      return connectionActionFailure(error, "notion", "disconnect");
    }
  };

  if (config.mode === "internal") {
    return {
      async beginConnection(request, access) {
        const resolvedAccess =
          access ??
          connectionAccess(await manageConnectionAccess(context.auth, context.database, request));
        const verified = await verifyNotionDirect(config, { fetch: context.fetch });
        if (verified?.initialConnection === undefined) {
          throw new ConnectionAccessDeniedError();
        }
        await context.database.integrations.bind({
          provider: "notion",
          organizationId: resolvedAccess.organizationId,
          connectedByUserId: resolvedAccess.userId,
          ...verified.initialConnection,
        });
        return {
          url: connectionReturnUrl(context.callbackOrigin, resolvedAccess.returnRoute, {
            provider: "notion",
            result: "notion_connected",
          }).toString(),
        };
      },
      actions: {
        disconnect,
      },
    };
  }

  const redirectUri = new URL(
    "/api/integrations/notion/callback",
    context.callbackOrigin,
  ).toString();

  return {
    async beginConnection(request, access) {
      if (!isHttpsOrigin(context.callbackOrigin)) {
        throw new ProviderApplicationError("httpsRequired", context.callbackOrigin);
      }
      const resolvedAccess =
        access ??
        connectionAccess(await manageConnectionAccess(context.auth, context.database, request));
      const state = newConnectionState();
      await context.database.startConnectionAttempt({
        provider: "notion",
        stateVerifier: stateHash(state),
        access: resolvedAccess,
        lifetimeMinutes: CONNECTION_ATTEMPT_LIFETIME_MINUTES,
        callbackOrigin: context.callbackOrigin,
        configurationVersion: context.configurationVersion,
        providerApplicationId: config.clientId,
        configurationSnapshot: config,
        expectedConfigurationVersion: context.activation?.expectedConfigurationVersion ?? null,
        activateConfiguration: context.activation?.activateConfiguration ?? false,
      });
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        owner: "user",
        state,
      });
      return { url: `https://api.notion.com/v1/oauth/authorize?${params.toString()}` };
    },
    actions: {
      disconnect,
      callback: async (request) => {
        const url = new URL(request.url);
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        if (state !== null && code === null && url.searchParams.get("error") === "access_denied") {
          return cancelledConnectionResult({
            auth: context.auth,
            database: context.database,
            request,
            provider: "notion",
            phase: "notion_authorization",
            state,
            applicationBaseUrl: context.callbackOrigin,
          });
        }
        if (state === null || code === null) {
          return connectionCallbackFailure({
            request,
            error: new NotionCallbackError(),
            provider: "notion",
            phase: "authorization",
            applicationBaseUrl: context.callbackOrigin,
            returnRoute: INTEGRATIONS_RETURN_ROUTE,
          });
        }

        let returnRoute: string = INTEGRATIONS_RETURN_ROUTE;
        let callbackOrigin = context.callbackOrigin;
        try {
          const access = await callbackConnectionAccess(context.auth, request);
          const attempt = await context.database.readConnectionAttempt({
            stateVerifier: stateHash(state),
            phase: "notion_authorization",
            access,
          });
          returnRoute = attempt.returnRoute;
          callbackOrigin = attempt.callbackOrigin;

          const attemptRedirectUri = new URL(
            "/api/integrations/notion/callback",
            callbackOrigin,
          ).toString();
          const { response, json } = await exchangeNotionOAuthToken({
            fetch: context.fetch,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            body: {
              grant_type: "authorization_code",
              code,
              redirect_uri: attemptRedirectUri,
            },
          });
          if (!response.ok) {
            throw new NotionCallbackError(`Notion token exchange failed (${response.status})`);
          }
          const token = NotionOAuthTokenSchema.parse(json);
          const workspaceName = nonEmpty(token.workspace_name ?? undefined) ?? "Notion workspace";
          const ownerUserId = token.owner?.user?.id;
          const expiresAt =
            token.expires_in === undefined
              ? null
              : new Date(context.now().getTime() + token.expires_in * 1000).toISOString();

          const connection: BindIntegrationConnectionPayload = {
            externalId: `${token.workspace_id}:${token.bot_id}`,
            displayName: workspaceName,
            providerApplicationId: config.clientId,
            workspaceId: token.workspace_id,
            scopes: [],
            credentials: {
              mode: "oauth",
              accessToken: token.access_token,
              refreshToken: token.refresh_token ?? null,
              accessTokenExpiresAt: expiresAt,
              botId: token.bot_id,
              workspaceId: token.workspace_id,
              ...(ownerUserId === undefined ? {} : { ownerUserId }),
            },
            metadata: {
              mode: "oauth",
              botId: token.bot_id,
              workspaceId: token.workspace_id,
              workspaceName,
              ...(ownerUserId === undefined ? {} : { ownerUserId }),
            },
          };

          const attemptInput = {
            phase: "notion_authorization" as const,
            stateVerifier: stateHash(state),
            access,
          };
          if (attempt.activateConfiguration && context.onOAuthInstallation !== undefined) {
            await context.onOAuthInstallation({
              provider: "notion",
              configuration: config,
              identity: context.identity,
              expectedConfigurationVersion: attempt.expectedConfigurationVersion ?? undefined,
              callbackOrigin,
              userId: attempt.userId,
              attempt: attemptInput,
              connection,
            });
          } else {
            await context.database.integrations.bind({
              attempt: attemptInput,
              provider: "notion",
              ...connection,
            });
          }
          return connectionResult(callbackOrigin, returnRoute, "notion_connected", "notion");
        } catch (error) {
          return connectionCallbackFailure({
            request,
            error,
            provider: "notion",
            phase: "authorization",
            applicationBaseUrl: callbackOrigin,
            returnRoute,
          });
        }
      },
    },
  };
}

export const notionConnectionCapability: IntegrationConnectionCapability<
  NotionConfig,
  NotionIdentity
> = {
  configSchema: NotionConfigSchema,
  identitySchema: NotionIdentitySchema,
  readEnvironment: readNotionEnvironment,
  sensitiveValues: notionSensitiveValues,
  publicIdentifiers: notionPublicIdentifiers,
  // PR 3 adds webhook trigger support; PR 2 keeps event admission off.
  acceptsEvents: () => false,
  verifyDirect: verifyNotionDirect,
  oauthAppIdentity(config) {
    return config.mode === "oauth"
      ? { provider: "notion", id: config.clientId, name: "Notion app" }
      : { provider: "notion", id: "internal", name: "Notion internal" };
  },
  connectionStatus(records, now) {
    if (records.length === 0) return { status: "disconnected" };
    if (records.some((record) => notionConnectionRequiresReauthorization(record, now))) {
      return { status: "requiresReauthorization" };
    }
    if (records.some((record) => record.status === "suspended")) {
      return { status: "suspended" };
    }
    return { status: "connected" };
  },
  projectConnection(record, now) {
    const view = toPublicConnectionView(record);
    let status: "connected" | "suspended" | "requiresReauthorization" = "connected";
    if (notionConnectionRequiresReauthorization(record, now)) {
      status = "requiresReauthorization";
    } else if (view.status === "suspended") {
      status = "suspended";
    }
    return {
      id: view.id,
      provider: view.provider,
      slug: view.slug,
      externalId: view.externalId,
      displayName: view.displayName,
      status,
      scopes: view.scopes,
      workspaceId: view.workspaceId,
      metadata: view.metadata,
    };
  },
  createRuntime: createNotionConnectionRuntime,
};
