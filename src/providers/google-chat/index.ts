import type { AuthServer } from "../../auth/server.js";
import { connectionReturnUrl } from "../../connections/result-contract.js";
import {
  connectionAccess,
  connectionActionFailure,
  manageConnectionAccess,
  requiredConnectionId,
} from "../../connections/shared.js";
import { DatabaseUnavailableError } from "../../db/errors.js";
import type { Database, GoogleChatConnectionRecord } from "../../db/types.js";
import { outputContextProvider, replyOutputTool } from "../../execution-capabilities/outputs.js";
import { organizationBillingUrl } from "../../triggers/failure-notice.js";
import {
  createGoogleChatBotClient,
  type GoogleChatBotClient,
} from "../../triggers/google-chat/client.js";
import { createGoogleChatTriggerProvider } from "../../triggers/google-chat/provider.js";
import { createGoogleChatPubSubSource } from "../../triggers/google-chat/pubsub.js";
import { createGoogleChatReplyExecutor } from "../../triggers/google-chat/reply.js";
import { createGoogleChatWebhookSource } from "../../triggers/google-chat/webhook.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";
import {
  CHAT_BOT_SCOPE,
  PUBSUB_SCOPE,
  createGoogleAccessTokenSource,
  parseGoogleServiceAccountJson,
  type GoogleServiceAccountCredentials,
} from "./auth.js";
import { createGoogleChatOidcVerifier, type GoogleChatOidcVerifier } from "./oidc.js";

export type GoogleChatRegistrationConfiguration =
  | {
      transport: "pubsub";
      projectId: string;
      appName: string;
      serviceAccountJson: string;
      subscription: string;
    }
  | {
      transport: "webhook";
      projectId: string;
      appName: string;
      serviceAccountJson: string;
      audience?: string;
    };

export interface CreateGoogleChatRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  publicBaseUrl?: string;
  configuration?: GoogleChatRegistrationConfiguration | null;
  botClient?: GoogleChatBotClient;
  oidcVerifier?: GoogleChatOidcVerifier;
  fetch?: typeof fetch;
  configurationVersion?: number;
}

interface GoogleChatConnectionOptions {
  database: Database;
  auth: AuthServer;
  callbackOrigin: string;
  configurationVersion: number;
  configuration: GoogleChatRegistrationConfiguration | undefined;
  credentials: GoogleServiceAccountCredentials | undefined;
}

export function googleChatWebhookUrl(publicBaseUrl: string): string {
  return new URL("/api/integrations/google-chat/events", publicBaseUrl).toString();
}

export function createGoogleChatRegistration(
  options: CreateGoogleChatRegistrationOptions,
): ProviderRegistration {
  const configuration = options.configuration ?? null;
  if (configuration === null || options.publicBaseUrl === undefined) {
    return emptyGoogleChatRegistration(options);
  }

  const credentials = parseGoogleServiceAccountJson(configuration.serviceAccountJson);
  const database = options.database;
  const accept =
    database === null
      ? () => Promise.reject(new DatabaseUnavailableError())
      : (
          input: Omit<
            Parameters<Database["acceptGoogleChatEvent"]>[0],
            "providerApplicationId" | "providerConfigurationVersion"
          >,
        ) =>
          database.acceptGoogleChatEvent({
            ...input,
            providerApplicationId: configuration.projectId,
            providerConfigurationVersion: options.configurationVersion ?? 0,
          });

  const chatTokenSource = createGoogleAccessTokenSource({
    credentials,
    scopes: [CHAT_BOT_SCOPE],
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const botClient =
    options.botClient ??
    createGoogleChatBotClient({
      tokenSource: chatTokenSource,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });

  const transportCapabilities = createTransportCapabilities({
    configuration,
    credentials,
    publicBaseUrl: options.publicBaseUrl,
    accept,
    ...(options.oidcVerifier === undefined ? {} : { oidcVerifier: options.oidcVerifier }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  if (database === null) {
    return {
      connection: googleChatConnectionStatus(true),
      triggerProviders: [],
      sources: transportCapabilities.sources,
      outputs: [],
      requests: transportCapabilities.requests,
    };
  }

  const connection =
    options.auth === null
      ? googleChatConnectionStatus(true)
      : createGoogleChatConnection({
          database,
          auth: options.auth,
          callbackOrigin: options.publicBaseUrl,
          configurationVersion: options.configurationVersion ?? 0,
          configuration,
          credentials,
        });

  return {
    configurationSnapshot: {
      version: options.configurationVersion ?? 0,
      callbackOrigin: options.publicBaseUrl,
    },
    connection,
    triggerProviders: [
      ({ configurationStoreForProject }) =>
        createGoogleChatTriggerProvider({
          configurationStoreForProject,
          billingUrlForOrganization: (organizationId) =>
            organizationBillingUrl(database, options.publicBaseUrl!, organizationId),
          client: botClient,
        }),
    ],
    sources: transportCapabilities.sources,
    outputs: [
      {
        type: "google-chat.reply",
        tool: replyOutputTool,
        available: outputContextProvider("google-chat"),
        execute: createGoogleChatReplyExecutor({ client: botClient }),
      },
    ],
    requests: transportCapabilities.requests,
  };
}

function createTransportCapabilities(input: {
  configuration: GoogleChatRegistrationConfiguration;
  credentials: GoogleServiceAccountCredentials;
  publicBaseUrl: string;
  accept: Parameters<typeof createGoogleChatPubSubSource>[0]["accept"];
  oidcVerifier?: GoogleChatOidcVerifier;
  fetch?: typeof fetch;
}): Pick<ProviderRegistration, "sources" | "requests"> {
  if (input.configuration.transport === "pubsub") {
    const pubsubTokenSource = createGoogleAccessTokenSource({
      credentials: input.credentials,
      scopes: [PUBSUB_SCOPE],
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
    const pubsubSource = createGoogleChatPubSubSource({
      projectId: input.configuration.projectId,
      subscription: input.configuration.subscription,
      tokenSource: pubsubTokenSource,
      accept: input.accept,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
    return {
      sources: [pubsubSource],
      requests: [],
    };
  }

  const expectedAudience =
    input.configuration.audience !== undefined && input.configuration.audience.length > 0
      ? input.configuration.audience
      : googleChatWebhookUrl(input.publicBaseUrl);
  const verifier =
    input.oidcVerifier ??
    createGoogleChatOidcVerifier({
      expectedAudience,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
  const webhookSource = createGoogleChatWebhookSource({
    projectId: input.configuration.projectId,
    verifier,
    accept: input.accept,
  });
  return {
    sources: [webhookSource],
    requests: [{ name: "google-chat.events", handle: (request) => webhookSource.handle(request) }],
  };
}

function emptyGoogleChatRegistration(
  options: Pick<CreateGoogleChatRegistrationOptions, "database" | "auth" | "applicationBaseUrl">,
): ProviderRegistration {
  const connection =
    options.database === null || options.auth === null
      ? googleChatConnectionStatus(false)
      : createGoogleChatConnection({
          database: options.database,
          auth: options.auth,
          callbackOrigin: options.applicationBaseUrl,
          configurationVersion: 0,
          configuration: undefined,
          credentials: undefined,
        });
  return {
    connection,
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests: [],
  };
}

function googleChatConnectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "google-chat",
    status: (connections) => googleChatStatus(configured, connections.googleChat),
    actions: {},
  };
}

function createGoogleChatConnection(
  options: GoogleChatConnectionOptions,
): ProviderConnectionRegistration {
  const configured = options.configuration !== undefined && options.credentials !== undefined;

  const start = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      if (options.configuration === undefined || options.credentials === undefined) {
        return Response.json({ error: "provider_not_configured" }, { status: 409 });
      }
      await options.database.bindGoogleChatConnection({
        access: connectionAccess(access),
        providerApplicationId: options.configuration.projectId,
        configurationVersion: options.configurationVersion,
        projectId: options.configuration.projectId,
        appName: options.configuration.appName,
        clientEmail: options.credentials.clientEmail,
      });
      const redirectUrl = connectionReturnUrl(options.callbackOrigin, access.returnRoute, {
        provider: "google-chat",
        result: "google-chat_connected",
      });
      return Response.json({ url: redirectUrl.toString() });
    } catch (error) {
      return connectionActionFailure(error, "google-chat", "start");
    }
  };

  const disconnect = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      await options.database.disconnectConnection(
        "google-chat",
        requiredConnectionId(request),
        connectionAccess(access),
      );
      return Response.json({ disconnected: true });
    } catch (error) {
      return connectionActionFailure(error, "google-chat", "disconnect");
    }
  };

  return {
    name: "google-chat",
    status: (connections) => googleChatStatus(configured, connections.googleChat),
    actions: {
      start,
      disconnect,
    },
  };
}

function googleChatStatus(configured: boolean, bindings: readonly GoogleChatConnectionRecord[]) {
  if (!configured) return { status: "notConfigured" as const };
  return bindings.length === 0
    ? { status: "disconnected" as const }
    : { status: "connected" as const };
}
