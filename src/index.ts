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
import {
  composeBilling,
  createStripeBillingClient,
  createStripeCatalogSource,
  readBillingConfig,
  type BillingRuntime,
} from "./billing/index.js";
import { composeEntitlements, type ComposedEntitlements } from "./auth/entitlements.js";
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
  const identity = readHubIdentity();
  const database = await createDatabaseHandle(config.databaseUrl);
  const entitlements = composeEntitlements(database, config.databaseUrl);
  const billingConfig = readBillingConfig();
  const billing =
    billingConfig === undefined
      ? null
      : composeBilling({
          config: billingConfig,
          database,
          catalogSource: createStripeCatalogSource(billingConfig.stripeSecretKey),
          billingClient: createStripeBillingClient(billingConfig.stripeSecretKey),
          seatUsage: entitlements.seatUsage,
        });
  // Sync on boot, per the plan. A Stripe outage here must not block the whole instance from
  // starting — only the marketing catalog goes stale until the next webhook or restart.
  await billing?.syncCatalog().catch((error: unknown) => {
    logger.error({ err: error }, "billing catalog sync failed at boot");
  });
  const auth = createProductionAuthServer(
    entitlements,
    config.databaseUrl,
    config.authPolicy,
    identity,
    config.trustedClientIpHeader,
    billing,
  );
  if (config.authPolicy.bootstrap !== undefined && auth === null) {
    throw new Error("PASEO_HUB_AUTH_SECRET is required when instance bootstrap is configured");
  }
  await auth?.initialize?.();
  const providerOptions = {
    database,
    auth,
    applicationBaseUrl: identity.appUrl,
    publicBaseUrl: identity.appUrl,
  };
  const registrations = [
    createGitHubRegistration(providerOptions),
    createDiscordRegistration(providerOptions),
    createSlackRegistration(providerOptions),
  ];
  return createApplicationRuntime({
    database,
    auth,
    entitlements: entitlements.service,
    billing,
    registrations,
    publicBaseUrl: identity.appUrl,
    ...(identity.authSecret === undefined ? {} : { completionTokenSecret: identity.authSecret }),
    async close() {
      await auth?.close();
      await entitlements.close();
      await database?.close();
    },
  });
}

function createProductionAuthServer(
  entitlements: ComposedEntitlements,
  databaseUrl: string,
  authPolicy: RuntimeConfig["authPolicy"],
  identity: HubIdentity,
  trustedClientIpHeader: string | undefined,
  billing: BillingRuntime | null,
) {
  if (identity.authSecret === undefined) {
    logger.warn("PASEO_HUB_AUTH_SECRET is unset; browser auth routes are closed");
    return null;
  }
  return createAuthServer({
    databaseUrl,
    entitlements: entitlements.service,
    secret: identity.authSecret,
    baseURL: identity.appUrl,
    policy: authPolicy,
    ...(trustedClientIpHeader === undefined ? {} : { trustedClientIpHeader }),
    // Hosted: new organizations start on the Free plan from the catalog mirror. Self-hosted
    // (billing null) keeps the createAuthServer default, which stamps unlimited.
    ...(billing === null
      ? {}
      : {
          provisioningEntitlements: () => billing.provisioningEntitlement(),
          onMembershipChanged: (organizationId: string) => billing.reportSeatUsage(organizationId),
        }),
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

interface HubIdentity {
  appUrl: string;
  authSecret?: string;
}

function readHubIdentity(): HubIdentity {
  const configuredAppUrl = process.env["PASEO_HUB_APP_URL"];
  const configuredAuthSecret = process.env["PASEO_HUB_AUTH_SECRET"];
  return {
    appUrl: new URL(configuredAppUrl ?? "http://localhost:3000").toString(),
    ...(configuredAuthSecret === undefined || configuredAuthSecret.length === 0
      ? {}
      : { authSecret: configuredAuthSecret }),
  };
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
