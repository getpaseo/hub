import type { AuthServer } from "../../auth/server.js";
import type { Database, DiscordConnectionRecord } from "../../db/types.js";
import { logger } from "../../logger.js";
import type { ProviderConnectionRegistration, ProviderRegistration } from "../registration.js";
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
import { createDiscordBotClient, type DiscordBotClient } from "../../triggers/discord/bot.js";
import { createDiscordGatewaySource } from "../../triggers/discord/gateway.js";
import { createDiscordTriggerProvider } from "../../triggers/discord/provider.js";
import { createDiscordAttachmentResolver } from "../../triggers/discord/attachments.js";
import { createDiscordReplyExecutor } from "../../triggers/discord/reply.js";
import { outputContextProvider, replyOutputTool } from "../../execution-capabilities/outputs.js";
import {
  createDiscordConnectionClient,
  type DiscordConnectionClient,
  type DiscordGuildIdentity,
} from "./client.js";

export interface DiscordRegistrationConfiguration {
  botToken: string;
  clientId: string;
  clientSecret: string;
}

export interface CreateDiscordRegistrationOptions {
  database: Database | null;
  auth: AuthServer | null;
  applicationBaseUrl: string;
  publicBaseUrl?: string;
  environment?: NodeJS.ProcessEnv;
  configuration?: DiscordRegistrationConfiguration | null;
  bot?: DiscordBotClient;
  connectionClient?: DiscordConnectionClient;
  fetch?: typeof fetch;
}

interface DiscordConnectionOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
}

export function createDiscordRegistration(
  options: CreateDiscordRegistrationOptions,
): ProviderRegistration {
  const configuration =
    options.configuration === undefined
      ? readDiscordConfiguration(options.publicBaseUrl, options.environment ?? process.env)
      : options.configuration;
  if (configuration === null || options.publicBaseUrl === undefined) {
    return emptyDiscordRegistration(options);
  }
  if (options.database === null) {
    return unavailableDiscordRegistration();
  }
  const database = options.database;

  const bot =
    options.bot ??
    createDiscordBotClient({
      token: configuration.botToken,
      clientId: configuration.clientId,
    });
  const client =
    options.connectionClient ??
    createDiscordConnectionClient({
      publicBaseUrl: options.publicBaseUrl,
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
      botToken: configuration.botToken,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  const connection =
    options.auth === null
      ? discordConnectionStatus(true)
      : createDiscordConnection(
          {
            database,
            auth: options.auth,
            applicationBaseUrl: options.applicationBaseUrl,
          },
          client,
        );
  const gateway = createDiscordGatewaySource({
    bot,
    accept: (input) => database.acceptDiscordEvent(input),
    applyGuildDelete: (guildId, unavailable) =>
      applyGuildRemoval(database, client, guildId, unavailable),
  });
  return {
    connection,
    triggerProviders: [
      ({ configurationStoreForProject, attachments }) =>
        createDiscordTriggerProvider({
          configurationStoreForProject,
          ...(attachments === undefined ? {} : { attachments }),
          bot,
        }),
    ],
    sources: [gateway],
    outputs: [
      {
        type: "discord.reply",
        tool: replyOutputTool,
        available: outputContextProvider("discord"),
        execute: createDiscordReplyExecutor({ bot }),
      },
    ],
    requests: [],
    attachment: {
      provider: "discord",
      resolve: createDiscordAttachmentResolver(
        options.fetch === undefined ? {} : { fetch: options.fetch },
      ),
    },
  };
}

function emptyDiscordRegistration(
  options: Pick<CreateDiscordRegistrationOptions, "database" | "auth" | "applicationBaseUrl">,
): ProviderRegistration {
  const { database, auth } = options;
  const connection =
    database === null || auth === null
      ? discordConnectionStatus(false)
      : createDiscordConnection(
          { database, auth, applicationBaseUrl: options.applicationBaseUrl },
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

function unavailableDiscordRegistration(): ProviderRegistration {
  return {
    connection: discordConnectionStatus(true),
    triggerProviders: [],
    sources: [],
    outputs: [],
    requests: [],
  };
}

function discordConnectionStatus(configured: boolean): ProviderConnectionRegistration {
  return {
    name: "discord",
    status: (connections) => discordStatus(configured, connections.discord),
    actions: {},
  };
}

function createDiscordConnection(
  options: DiscordConnectionOptions,
  client: DiscordConnectionClient | undefined,
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
        provider: "discord",
        stateVerifier: stateHash(state),
        access: connectionAccess(access),
        lifetimeMinutes: CONNECTION_ATTEMPT_LIFETIME_MINUTES,
      });
      return Response.json({ url: client.authorizationUrl(state) });
    } catch (error) {
      return connectionActionFailure(error, "discord", "start");
    }
  };

  const disconnect = async (request: Request): Promise<Response> => {
    const rejected = options.auth.rejectCookieMutation(request);
    if (rejected !== undefined) return rejected;
    try {
      const access = await manageConnectionAccess(options.auth, options.database, request);
      const disconnected = await options.database.disconnectConnection(
        "discord",
        requiredConnectionId(request),
        connectionAccess(access),
      );
      if (disconnected.provider === "discord" && disconnected.guildId !== undefined) {
        void client?.leaveGuild(disconnected.guildId).catch((error: unknown) => {
          logger.warn(
            {
              provider: "discord",
              action: "leave",
              errorType: errorType(error),
            },
            "provider cleanup failed after disconnect",
          );
        });
      }
      return Response.json({ disconnected: true });
    } catch (error) {
      return connectionActionFailure(error, "discord", "disconnect");
    }
  };

  return {
    name: "discord",
    status: (connections) => discordStatus(client !== undefined, connections.discord),
    actions: {
      start,
      disconnect,
      callback: (request) => completeAuthorization(options, client, request),
    },
  };
}

async function completeAuthorization(
  options: DiscordConnectionOptions,
  client: DiscordConnectionClient | undefined,
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
      phase: "discord_authorization",
      access,
    });
    returnRoute = attempt.returnRoute;
    const guild = await client.verifyGuild(code);
    if (guild === undefined) {
      await options.database.consumeConnectionAttempt({
        stateVerifier: stateHash(state),
        phase: "discord_authorization",
        access,
      });
      return connectionResult(
        options.applicationBaseUrl,
        attempt.returnRoute,
        "connection_unavailable",
      );
    }
    await bindDiscord(options.database, state, access, guild);
    return connectionResult(options.applicationBaseUrl, attempt.returnRoute, "discord_connected");
  } catch (error) {
    return connectionCallbackFailure({
      error,
      provider: "discord",
      phase: "authorization",
      applicationBaseUrl: options.applicationBaseUrl,
      returnRoute,
    });
  }
}

async function bindDiscord(
  database: Database,
  state: string,
  access: Awaited<ReturnType<typeof callbackConnectionAccess>>,
  guild: DiscordGuildIdentity,
): Promise<void> {
  await database.bindDiscordConnection({
    stateVerifier: stateHash(state),
    phase: "discord_authorization",
    access,
    ...guild,
  });
}

async function applyGuildRemoval(
  database: Database,
  client: DiscordConnectionClient,
  guildId: string,
  unavailable: boolean,
): Promise<void> {
  if (unavailable) return;
  const membership = await client.guildMembership(guildId);
  if (membership === "absent") await database.removeDiscordConnection(guildId);
}

function discordStatus(configured: boolean, bindings: readonly DiscordConnectionRecord[]) {
  if (!configured) return { status: "notConfigured" as const };
  return bindings.length === 0
    ? { status: "disconnected" as const }
    : { status: "connected" as const };
}

function readDiscordConfiguration(
  publicBaseUrl: string | undefined,
  environment: NodeJS.ProcessEnv,
): DiscordRegistrationConfiguration | null {
  if (publicBaseUrl === undefined) return null;
  const botToken = readNonEmptyEnvironmentVariable(environment, "DISCORD_BOT_TOKEN");
  const clientId = readNonEmptyEnvironmentVariable(environment, "DISCORD_CLIENT_ID");
  const clientSecret = readNonEmptyEnvironmentVariable(environment, "DISCORD_CLIENT_SECRET");
  if (botToken === undefined || clientId === undefined || clientSecret === undefined) return null;
  return {
    botToken,
    clientId,
    clientSecret,
  };
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
