import type { AuthServer } from "../../auth/server.js";
import {
  CONNECTION_ATTEMPT_LIFETIME_MINUTES,
  callbackConnectionAccess,
  connectionAccess,
  connectionActionFailure,
  connectionCallbackFailure,
  connectionResult,
  manageConnectionAccess,
  newConnectionState,
  readNonEmptyEnvironmentVariable,
  requiredConnectionId,
  stateHash,
} from "../../connections/shared.js";
import { DatabaseUnavailableError } from "../../db/errors.js";
import type { Database, SlackConnectionRecord } from "../../db/types.js";
import { logger } from "../../logger.js";
import { createSlackBotClient, type SlackBotClient } from "../../triggers/slack/client.js";
import { createSlackTriggerProvider } from "../../triggers/slack/provider.js";
import { createSlackAttachmentResolver } from "../../triggers/slack/attachments.js";
import { createSlackReplyExecutor } from "../../triggers/slack/reply.js";
import { outputContextProvider, replyOutputTool } from "../../execution-capabilities/outputs.js";
import { createSlackWebhookSource } from "../../triggers/slack/webhook.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";
import {
  createSlackConnectionClient,
  hasRequiredSlackScopes,
  type SlackConnectionClient,
  type SlackInstallation,
} from "./client.js";

export interface SlackRegistrationConfiguration {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

export interface CreateSlackRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  publicBaseUrl?: string;
  environment?: NodeJS.ProcessEnv;
  configuration?: SlackRegistrationConfiguration | null;
  connectionClient?: SlackConnectionClient;
  botClient?: SlackBotClient;
  fetch?: typeof fetch;
}

interface SlackConnectionOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
}

export function createSlackRegistration(
  options: CreateSlackRegistrationOptions,
): ProviderRegistration {
  const configuration =
    options.configuration === undefined
      ? readSlackConfiguration(options.publicBaseUrl, options.environment ?? process.env)
      : options.configuration;
  if (configuration === null || options.publicBaseUrl === undefined) {
    return emptySlackRegistration(options);
  }

  const connectionClient =
    options.connectionClient ??
    createSlackConnectionClient({
      appId: configuration.appId,
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
      publicBaseUrl: options.publicBaseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const database = options.database;
  const accept =
    database === null
      ? () => Promise.reject(new DatabaseUnavailableError())
      : (input: Parameters<Database["acceptSlackEvent"]>[0]) => database.acceptSlackEvent(input);
  const webhook = createSlackWebhookSource({
    appId: configuration.appId,
    signingSecret: configuration.signingSecret,
    accept,
  });
  if (database === null) {
    return {
      connection: slackConnectionStatus(true),
      triggerProviders: [],
      sources: [webhook],
      outputs: [],
      requests: [{ name: "slack.events", handle: (request) => webhook.handle(request) }],
    };
  }

  const bot =
    options.botClient ??
    createSlackBotClient({
      tokenForWorkspace: async (organizationId, teamId) =>
        (await findSlackBindingForOrganization(database, organizationId, teamId))?.botAccessToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const connection =
    options.auth === null
      ? slackConnectionStatus(true)
      : createSlackConnection(
          {
            database,
            auth: options.auth,
            applicationBaseUrl: options.applicationBaseUrl,
          },
          connectionClient,
        );

  return {
    connection,
    triggerProviders: [
      ({ configurationStoreForProject, attachments }) =>
        createSlackTriggerProvider({
          configurationStoreForProject,
          ...(attachments === undefined ? {} : { attachments }),
          botUserIdForWorkspace: async (organizationId, teamId) =>
            (await findSlackBindingForOrganization(database, organizationId, teamId))?.botUserId,
          client: bot,
        }),
    ],
    sources: [webhook],
    outputs: [
      {
        type: "slack.reply",
        tool: replyOutputTool,
        available: outputContextProvider("slack"),
        execute: createSlackReplyExecutor({ client: bot }),
      },
    ],
    requests: [{ name: "slack.events", handle: (request) => webhook.handle(request) }],
    attachment: { provider: "slack", resolve: createSlackAttachmentResolver(bot) },
  };
}

async function findSlackBindingForOrganization(
  database: Database,
  organizationId: string,
  teamId: string,
): Promise<SlackConnectionRecord | undefined> {
  const binding = await database.findSlackConnectionForOrganization(organizationId, teamId);
  return binding?.organizationId === organizationId && hasRequiredSlackScopes(binding.scopes)
    ? binding
    : undefined;
}

function emptySlackRegistration(
  options: Pick<CreateSlackRegistrationOptions, "database" | "auth" | "applicationBaseUrl">,
): ProviderRegistration {
  const connection =
    options.database === null || options.auth === null
      ? slackConnectionStatus(false)
      : createSlackConnection(
          {
            database: options.database,
            auth: options.auth,
            applicationBaseUrl: options.applicationBaseUrl,
          },
          undefined,
        );
  return {
    connection,
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests: [],
  };
}

function slackConnectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "slack",
    status: (connections) => slackStatus(configured, connections.slack),
    actions: {},
  };
}

function createSlackConnection(
  options: SlackConnectionOptions,
  client: SlackConnectionClient | undefined,
): ProviderConnectionRegistration {
  const start = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      if (client === undefined) {
        return Response.json({ error: "provider_not_configured" }, { status: 409 });
      }
      const state = newConnectionState();
      await options.database.startConnectionAttempt({
        provider: "slack",
        stateVerifier: stateHash(state),
        access: connectionAccess(access),
        lifetimeMinutes: CONNECTION_ATTEMPT_LIFETIME_MINUTES,
      });
      return Response.json({ url: client.authorizationUrl(state) });
    } catch (error) {
      return connectionActionFailure(error, "slack", "start");
    }
  };

  const disconnect = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      const disconnected = await options.database.disconnectConnection(
        "slack",
        requiredConnectionId(request),
        connectionAccess(access),
      );
      if (disconnected.provider === "slack" && disconnected.botAccessToken !== undefined) {
        void client?.revoke(disconnected.botAccessToken).catch((error: unknown) => {
          logger.warn(
            { err: error, provider: "slack" },
            "provider cleanup failed after disconnect",
          );
        });
      }
      return Response.json({ disconnected: true });
    } catch (error) {
      return connectionActionFailure(error, "slack", "disconnect");
    }
  };

  return {
    name: "slack",
    status: (connections) => slackStatus(client !== undefined, connections.slack),
    actions: {
      start,
      disconnect,
      callback: (request) => completeAuthorization(options, client, request),
    },
  };
}

async function completeAuthorization(
  options: SlackConnectionOptions,
  client: SlackConnectionClient | undefined,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (state === null || code === null || client === undefined) {
    return connectionResult(options.applicationBaseUrl, "/", "connection_unavailable");
  }
  let returnRoute = "/";
  try {
    const access = await callbackConnectionAccess(options.auth, request);
    const attempt = await options.database.readConnectionAttempt({
      stateVerifier: stateHash(state),
      phase: "slack_authorization",
      access,
    });
    returnRoute = attempt.returnRoute;
    const installation = await client.exchangeCode(code);
    await bindSlack(options.database, state, access, installation);
    return connectionResult(options.applicationBaseUrl, attempt.returnRoute, "slack_connected");
  } catch (error) {
    return connectionCallbackFailure({
      error,
      provider: "slack",
      phase: "authorization",
      applicationBaseUrl: options.applicationBaseUrl,
      returnRoute,
    });
  }
}

async function bindSlack(
  database: Database,
  state: string,
  access: Awaited<ReturnType<typeof callbackConnectionAccess>>,
  installation: SlackInstallation,
): Promise<void> {
  await database.bindSlackConnection({
    stateVerifier: stateHash(state),
    phase: "slack_authorization",
    access,
    ...installation,
  });
}

function slackStatus(configured: boolean, bindings: readonly SlackConnectionRecord[]) {
  if (!configured) return { status: "notConfigured" as const };
  if (bindings.length === 0) return { status: "disconnected" as const };
  return bindings.some((binding) => !hasRequiredSlackScopes(binding.scopes))
    ? { status: "requiresReauthorization" as const }
    : { status: "connected" as const };
}

function readSlackConfiguration(
  publicBaseUrl: string | undefined,
  environment: NodeJS.ProcessEnv,
): SlackRegistrationConfiguration | null {
  if (publicBaseUrl === undefined) return null;
  const appId = readNonEmptyEnvironmentVariable(environment, "SLACK_APP_ID");
  const clientId = readNonEmptyEnvironmentVariable(environment, "SLACK_CLIENT_ID");
  const clientSecret = readNonEmptyEnvironmentVariable(environment, "SLACK_CLIENT_SECRET");
  const signingSecret = readNonEmptyEnvironmentVariable(environment, "SLACK_SIGNING_SECRET");
  return appId === undefined ||
    clientId === undefined ||
    clientSecret === undefined ||
    signingSecret === undefined
    ? null
    : { appId, clientId, clientSecret, signingSecret };
}
