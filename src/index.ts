import "dotenv/config";
import { validateHeaderName, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import type { RuntimeConfig } from "./config/index.js";
import { DatabaseUnavailableError } from "./db/errors.js";
import { createDatabase } from "./db/pg.js";
import type { Database } from "./db/types.js";
import { logger } from "./logger.js";
import { createFetchServer } from "./http/node-server.js";
import { loadBuiltStartServer } from "./server/build.js";
import { createAuthServer } from "./auth/server.js";
import { startApplication, stopApplication, type ApplicationRuntime } from "./server/runtime.js";
import { createApplicationRuntime } from "./application-runtime.js";
import { createDiscordRegistration } from "./providers/discord/index.js";
import { createGitHubRegistration } from "./providers/github/index.js";
import { createSlackRegistration } from "./providers/slack/index.js";
import { readInstanceAuthPolicy } from "./auth/instance-policy.js";

export function startProductionRuntime(): Promise<ApplicationRuntime> {
  return startApplication(createProductionRuntime);
}

export async function stopProductionRuntime(): Promise<void> {
  await stopApplication();
}

export async function handleDaemonUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const runtime = await startProductionRuntime();
  if (runtime.hub.handleUpgrade === null) {
    socket.destroy();
    return;
  }
  await runtime.hub.handleUpgrade(request, socket, head);
}

async function createProductionRuntime(): Promise<ApplicationRuntime> {
  const config = loadRuntimeConfig();
  const database = await createDatabaseHandle(config.databaseUrl);
  const auth =
    database === null ? null : createProductionAuthServer(config.databaseUrl, config.authPolicy);
  if (config.authPolicy.bootstrap !== undefined && auth === null) {
    throw new Error("BETTER_AUTH_SECRET is required when instance bootstrap is configured");
  }
  await auth?.initialize?.();
  const configuredPublicBaseUrl = readPublicBaseUrlOption().publicBaseUrl;
  const applicationBaseUrl =
    configuredPublicBaseUrl ?? process.env["BETTER_AUTH_URL"] ?? "http://localhost:3000";
  const providerOptions = {
    database,
    auth,
    ...(auth?.apiKeys === undefined ? {} : { operationAuth: auth.apiKeys }),
    applicationBaseUrl,
    ...(configuredPublicBaseUrl === undefined ? {} : { publicBaseUrl: configuredPublicBaseUrl }),
  };
  const registrations = [
    createGitHubRegistration(providerOptions),
    createDiscordRegistration(providerOptions),
    createSlackRegistration(providerOptions),
  ];
  return createApplicationRuntime({
    database,
    auth,
    registrations,
    ...(configuredPublicBaseUrl === undefined ? {} : { publicBaseUrl: configuredPublicBaseUrl }),
    ...readCompletionTokenSecretOption(),
    async close() {
      await auth?.close();
      await database?.close();
    },
  });
}

function createProductionAuthServer(databaseUrl: string, authPolicy: RuntimeConfig["authPolicy"]) {
  const secret = process.env["BETTER_AUTH_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logger.warn("BETTER_AUTH_SECRET is unset; browser auth routes are closed");
    return null;
  }
  return createAuthServer({
    databaseUrl,
    secret,
    baseURL:
      process.env["BETTER_AUTH_URL"] ??
      readPublicBaseUrlOption().publicBaseUrl ??
      "http://localhost:3000",
    policy: authPolicy,
  });
}

async function createDatabaseHandle(databaseUrl: string): Promise<Database> {
  try {
    return await createDatabase(databaseUrl);
  } catch (error) {
    if (!(error instanceof DatabaseUnavailableError)) throw error;
    logger.error(
      { err: error },
      "database unavailable at startup; refusing to start the public server",
    );
    throw error;
  }
}

function loadRuntimeConfig(): RuntimeConfig {
  const trustedClientIpHeader = process.env["PASEO_HUB_TRUSTED_CLIENT_IP_HEADER"];
  if (trustedClientIpHeader !== undefined) validateHeaderName(trustedClientIpHeader);
  return {
    bind: process.env["PASEO_HUB_BIND"] ?? "0.0.0.0",
    databaseUrl:
      process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/paseo_hub",
    ...(trustedClientIpHeader === undefined ? {} : { trustedClientIpHeader }),
    authPolicy: readInstanceAuthPolicy(),
  };
}

function readCompletionTokenSecretOption(): { completionTokenSecret?: string } {
  const value = process.env["PASEO_HUB_COMPLETION_TOKEN_SECRET"];
  return value === undefined || value.length === 0 ? {} : { completionTokenSecret: value };
}

function readPublicBaseUrlOption(): { publicBaseUrl?: string } {
  const value = process.env["PASEO_HUB_PUBLIC_URL"];
  return value === undefined || value.length === 0
    ? {}
    : { publicBaseUrl: new URL(value).toString() };
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const port = readPort();
  const build = await loadBuiltStartServer();
  await build.startProductionRuntime();
  const server = createFetchServer(
    (request) => build.default.fetch(request),
    config.trustedClientIpHeader === undefined
      ? {}
      : { trustedClientIpHeader: config.trustedClientIpHeader },
  );
  server.on("upgrade", (request, socket, head) => {
    void build.handleDaemonUpgrade(request, socket, head);
  });
  server.listen(port, config.bind, () => {
    logger.info({ bind: config.bind, port }, "server started");
  });

  const stop = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await build.stopProductionRuntime();
  };
  const stopAfterSignal = () => {
    void stop().catch((error: unknown) => {
      logger.error({ err: error }, "server shutdown failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", stopAfterSignal);
  process.once("SIGINT", stopAfterSignal);
}

function readPort(): number {
  const value = process.env["PORT"] ?? "3000";
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid PORT value: ${value}`);
  return port;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    logger.fatal(error);
    process.exit(1);
  });
}
