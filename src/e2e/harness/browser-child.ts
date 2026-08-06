import { writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createApplicationRuntime } from "../../application-runtime.js";
import { createAuthServer } from "../../auth/server.js";
import { readInstanceAuthPolicy } from "../../auth/instance-policy.js";
import { createDatabase, createPostgresPool } from "../../db/pg.js";
import { createFetchServer } from "../../http/node-server.js";
import { loadBuiltStartServer } from "../../server/build.js";
import { createGitHubRegistration } from "../../providers/github/index.js";
import { createDiscordRegistration } from "../../providers/discord/index.js";
import { createSlackRegistration } from "../../providers/slack/index.js";
import {
  BrowserDiscordBot,
  BrowserDiscordConnections,
  BrowserGitHubAuth,
  BrowserGitHubConnections,
  BrowserGitHubConfiguration,
  BrowserGitHubReactions,
  type BrowserDiscordEvent,
  type BrowserProviderScenario,
} from "./browser-providers.js";

interface DiscordCommand {
  id: string;
  type: "discord";
  event: BrowserDiscordEvent;
}

interface GitHubConfigurationCommand {
  id: string;
  type: "github-configuration";
  repositoryId: number;
  commitSha: string;
  rawYaml?: string;
}

async function main(): Promise<void> {
  const databaseUrl = requiredEnvironment("DATABASE_URL");
  const publicBaseUrl = requiredEnvironment("PASEO_HUB_APP_URL");
  const scenario = readScenario();
  const database = await createDatabase(databaseUrl);
  const authSecret = requiredEnvironment("PASEO_HUB_AUTH_SECRET");
  const auth = browserAuthEnabled()
    ? createAuthServer({
        database,
        databaseUrl,
        baseURL: requiredEnvironment("PASEO_HUB_APP_URL"),
        secret: authSecret,
        policy: readInstanceAuthPolicy(),
      })
    : null;
  await auth?.initialize?.();
  const machineAuth = machineAuthEnabled();
  const databaseProfile = requiredEnvironment("PASEO_E2E_DATABASE_PROFILE");
  if (auth !== null && machineAuth && databaseProfile === "fresh") {
    await seedMachineAuthTarget(databaseUrl);
  }
  const machineKey =
    auth === null || !machineAuth
      ? undefined
      : await auth.apiKeys?.create("phase-zero", "phase-zero-user", "browser e2e automation", [
          "configuration:install",
          "runs:dispatch",
          "daemons:enroll",
        ]);
  await writeFile(
    requiredEnvironment("PASEO_E2E_MACHINE_KEY_FILE"),
    machineKey?.secret ?? "",
    "utf8",
  );
  const bot = new BrowserDiscordBot();
  const githubConfiguration = new BrowserGitHubConfiguration();
  const githubConfigured = hasBrowserGitHub(scenario);
  const registrations =
    auth === null
      ? []
      : [
          createGitHubRegistration({
            database,
            auth,
            applicationBaseUrl: publicBaseUrl,
            publicBaseUrl,
            configuration: githubConfigured
              ? {
                  appSlug: "paseo",
                  clientId: "client",
                  clientSecret: "secret",
                  webhookSecret: requiredEnvironment("GITHUB_WEBHOOK_SECRET"),
                }
              : null,
            ...(githubConfigured
              ? {
                  appAuth: new BrowserGitHubAuth(),
                  connectionClient: new BrowserGitHubConnections(publicBaseUrl, scenario),
                  configurationProvider: githubConfiguration,
                  reactionClient: new BrowserGitHubReactions(),
                }
              : {}),
          }),
          createDiscordRegistration({
            database,
            auth,
            applicationBaseUrl: publicBaseUrl,
            publicBaseUrl,
            configuration:
              scenario === "not-configured"
                ? null
                : {
                    botToken: "token",
                    clientId: "900",
                    clientSecret: "secret",
                  },
            bot,
            ...(scenario === "not-configured"
              ? {}
              : { connectionClient: new BrowserDiscordConnections(publicBaseUrl, scenario) }),
          }),
          createSlackRegistration({
            database,
            auth,
            applicationBaseUrl: publicBaseUrl,
            publicBaseUrl,
            configuration: null,
          }),
        ];
  const runtime = await createApplicationRuntime({
    database,
    auth,
    publicApi:
      machineKey === undefined || auth?.apiKeys === undefined
        ? { status: "unavailable" }
        : { status: "enabled", authenticator: auth.apiKeys },
    registrations,
    publicBaseUrl,
    completionTokenSecret: requiredEnvironment("PASEO_HUB_AUTH_SECRET"),
    async close() {
      await auth?.close();
      await database.close();
    },
  });
  const start = await loadBuiltStartServer();
  await start.startApplication(() => runtime);
  const server = createFetchServer((request) => start.default.fetch(request));
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void runtime.hub.handleUpgrade?.(request, socket, head);
  });
  server.listen(Number(requiredEnvironment("PORT")), "127.0.0.1");

  process.on("message", (message: unknown) => {
    void acceptCommand(message, bot, githubConfiguration);
  });
  const stop = () => void shutdown(server, () => runtime.stop());
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

async function seedMachineAuthTarget(databaseUrl: string): Promise<void> {
  const pool = createPostgresPool(databaseUrl);
  try {
    await pool.query(`
      insert into organization (id, name, slug)
      values ('phase-zero', 'E2E machine organization', 'phase-zero')
      on conflict (id) do nothing;
      insert into "user" (id, name, email, email_verified)
      values ('phase-zero-user', 'E2E machine user', 'phase-zero@example.test', true)
      on conflict (id) do nothing;
      insert into member (id, organization_id, user_id, role)
      values ('phase-zero-owner', 'phase-zero', 'phase-zero-user', 'owner')
      on conflict (id) do nothing;
    `);
  } finally {
    await pool.end();
  }
}

async function acceptCommand(
  message: unknown,
  bot: BrowserDiscordBot,
  githubConfiguration: BrowserGitHubConfiguration,
): Promise<void> {
  if (isGitHubConfigurationCommand(message)) {
    githubConfiguration.setRevision(message);
    process.send?.({ id: message.id, ok: true });
    return;
  }
  if (!isDiscordCommand(message)) return;
  try {
    await bot.deliver(message.event);
    process.send?.({ id: message.id, ok: true });
  } catch (error) {
    process.send?.({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isGitHubConfigurationCommand(value: unknown): value is GitHubConfigurationCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "type") === "github-configuration" &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "repositoryId") === "number" &&
    typeof Reflect.get(value, "commitSha") === "string" &&
    (Reflect.get(value, "rawYaml") === undefined ||
      typeof Reflect.get(value, "rawYaml") === "string")
  );
}

function isDiscordCommand(value: unknown): value is DiscordCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "type") === "discord" &&
    typeof Reflect.get(value, "id") === "string" &&
    typeof Reflect.get(value, "event") === "object"
  );
}

async function shutdown(
  server: ReturnType<typeof createFetchServer>,
  stopRuntime: () => Promise<void>,
): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
  await stopRuntime();
  server.closeIdleConnections();
  server.closeAllConnections();
  await closed;
  process.exit(0);
}

function readScenario(): BrowserProviderScenario {
  const value = process.env["PASEO_BROWSER_PROVIDER_SCENARIO"] ?? "connected";
  if (
    value === "connected" ||
    value === "approval" ||
    value === "conflict" ||
    value === "not-configured" ||
    value === "discord-only"
  ) {
    return value;
  }
  throw new Error(`invalid browser provider scenario: ${value}`);
}

function hasBrowserGitHub(scenario: BrowserProviderScenario): boolean {
  return scenario !== "not-configured" && scenario !== "discord-only";
}

function browserAuthEnabled(): boolean {
  const value = requiredEnvironment("PASEO_BROWSER_AUTH_ENABLED");
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid browser auth setting: ${value}`);
}

function machineAuthEnabled(): boolean {
  const value = requiredEnvironment("PASEO_MACHINE_AUTH_ENABLED");
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid machine auth setting: ${value}`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
