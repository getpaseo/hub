import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "vitest";
import { embeddedDatabaseRuntime } from "./db/runtime/index.js";
import { startProductionRuntime, stopProductionRuntime } from "./index.js";
import { runWithFailureTracking } from "./failures/index.js";
import { createLogger } from "./logger.js";
import { assertOneFailure, FailureLogStream } from "./test-utils/failure-logs.js";
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";

const ENVIRONMENT_NAMES = [
  "DATABASE_URL",
  "PASEO_HUB_DATA_DIR",
  "PASEO_HUB_AUTH_SECRET",
  "PASEO_HUB_APP_URL",
  "PASEO_REGISTRATION_MODE",
  "PASEO_ORGANIZATION_CREATION",
  "PASEO_BOOTSTRAP_ORGANIZATION",
  "PASEO_BOOTSTRAP_OWNER_EMAIL",
  "PASEO_BOOTSTRAP_OWNER_PASSWORD",
  "SLACK_TRANSPORT",
  "SLACK_APP_ID",
  "SLACK_APP_TOKEN",
] as const;

const APP_URL = "http://localhost:3000";

let root: string;
let previousEnvironment: Map<string, string | undefined>;
const originalDirectory = process.cwd();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hub-production-embedded-"));
  process.chdir(root);
  previousEnvironment = new Map(ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]));
  delete process.env["DATABASE_URL"];
  process.env["PASEO_HUB_DATA_DIR"] = join(root, "database");
  delete process.env["PASEO_HUB_AUTH_SECRET"];
  delete process.env["PASEO_HUB_APP_URL"];
  process.env["PASEO_REGISTRATION_MODE"] = "invite_only";
  process.env["PASEO_ORGANIZATION_CREATION"] = "disabled";
  process.env["PASEO_BOOTSTRAP_ORGANIZATION"] = "Embedded owner";
  process.env["PASEO_BOOTSTRAP_OWNER_EMAIL"] = "owner@embedded.test";
  process.env["PASEO_BOOTSTRAP_OWNER_PASSWORD"] = "embedded-owner-password";
});

afterEach(async () => {
  await stopProductionRuntime().catch(() => undefined);
  for (const [name, value] of previousEnvironment) restoreEnvironment(name, value);
  process.chdir(originalDirectory);
  await rm(root, { recursive: true, force: true });
});

it("opens first-run setup when nothing is configured and no data exists", async () => {
  delete process.env["PASEO_BOOTSTRAP_ORGANIZATION"];
  delete process.env["PASEO_BOOTSTRAP_OWNER_EMAIL"];
  delete process.env["PASEO_BOOTSTRAP_OWNER_PASSWORD"];

  const runtime = await startProductionRuntime();
  const state = await runtime.browserAccount!(new Request(`${APP_URL}/api/auth/paseo/state`));

  assert.equal(state.status, 200);
  assert.deepEqual(await state.json(), { status: "instanceSetupRequired" });
});

for (const scenario of ["server-error", "hung-open", "hung-open-body", "missing-hello"] as const) {
  it(`exposes the production runtime after bounded Slack ${scenario} readiness failure`, async () => {
    const canary = `xapp-production-${scenario}-canary`;
    const slack = await startUnavailableSlack(scenario);
    process.env["SLACK_TRANSPORT"] = "socket";
    process.env["SLACK_APP_ID"] = "A-PRODUCTION";
    process.env["SLACK_APP_TOKEN"] = canary;
    const stream = new FailureLogStream();

    const runtime = await runWithFailureTracking(
      () =>
        startProductionRuntime({
          environmentSource: "process-only",
          slackSocket: {
            apiUrl: slack.openUrl,
            readinessTimeoutMs: 80,
            connectTimeoutMs: 30,
            helloTimeoutMs: 30,
            random: () => 0,
          },
        }),
      createLogger(stream),
    );

    assert.notEqual(runtime.providerApplications, null);
    assertOneFailure(stream, {
      operation: "slack.socket.connect",
      component: "triggers",
      failureKind: "network",
      canary,
    });
    assert.equal(stream.text().includes("body-canary-never-finished"), false);
    const stopped = await Promise.race([
      stopProductionRuntime().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    assert.equal(stopped, true);
    const requestsAtStop = slack.requestCount;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(slack.requestCount, requestsAtStop);
    await slack.close();
  });
}

it("logs an embedded database startup failure exactly once", async () => {
  const canary = "database-startup-secret-1d42";
  const stream = new FailureLogStream();
  const blockedPath = join(root, canary);
  await writeFile(blockedPath, "not a directory");
  process.env["PASEO_HUB_DATA_DIR"] = blockedPath;

  await assert.rejects(() =>
    runWithFailureTracking(
      () => startProductionRuntime({ environmentSource: "process-only" }),
      createLogger(stream),
    ),
  );

  assertOneFailure(stream, {
    operation: "database.startup",
    component: "database",
    canary,
  });
});

it("keeps an interactive claim across a restart and then shows ordinary sign-in", async () => {
  delete process.env["PASEO_BOOTSTRAP_ORGANIZATION"];
  delete process.env["PASEO_BOOTSTRAP_OWNER_EMAIL"];
  delete process.env["PASEO_BOOTSTRAP_OWNER_PASSWORD"];
  process.env["PASEO_HUB_APP_URL"] = APP_URL;
  const operator = {
    email: "restart-operator@example.test",
    password: "restart-operator-password",
  };

  const first = await startProductionRuntime();
  assert.deepEqual(await first.claimInstance!(operator, new Headers({ origin: APP_URL })), {
    status: "claimed",
  });
  await stopProductionRuntime();

  // A new process against the same embedded storage: setup is over, and the chosen password
  // still signs the operator in without a temporary-password gate.
  const restarted = await startProductionRuntime();
  const state = await restarted.browserAccount!(new Request(`${APP_URL}/api/auth/paseo/state`));
  assert.deepEqual(await state.json(), {
    status: "signedOut",
    registration: "invite_only",
  });
  await restarted.signInEmail!(
    { email: operator.email, password: operator.password },
    new Headers({ origin: APP_URL }),
  );
});

it("releases embedded storage when runtime configuration is invalid", async () => {
  process.env["PASEO_HUB_APP_URL"] = "not a URL";

  await assert.rejects(() => startProductionRuntime(), TypeError);

  await reopenEmbeddedStorage();
});

it("releases embedded storage when auth initialization fails", async () => {
  const bundle = await embeddedDatabaseRuntime(process.env["PASEO_HUB_DATA_DIR"]!);
  await bundle.runtime.migrate();
  await bundle.runtime.query(
    `insert into "user" (id, name, email, email_verified)
     values ('existing-user', 'Existing user', $1, true)`,
    [process.env["PASEO_BOOTSTRAP_OWNER_EMAIL"]!],
  );
  await bundle.runtime.close();

  await assert.rejects(() => startProductionRuntime(), /already belongs/u);

  await reopenEmbeddedStorage();
});

it("selects embedded storage without DATABASE_URL and preserves it across restarts", async () => {
  const firstRuntime = await startProductionRuntime();
  const authResponse = await firstRuntime.auth(
    new Request("http://localhost:3000/api/auth/get-session"),
  );
  assert.notEqual(authResponse.status, 503);
  const authBody = await authResponse.text();
  await stopProductionRuntime();

  const firstSecret = await storedAuthSecret();
  assert.doesNotMatch(authBody, new RegExp(firstSecret, "u"));
  await startProductionRuntime();
  await stopProductionRuntime();

  const bundle = await embeddedDatabaseRuntime(process.env["PASEO_HUB_DATA_DIR"]!);
  const result = await bundle.runtime.query<{
    organizations: number;
    bootstraps: number;
    runtime_configurations: number;
    auth_secret: string;
  }>(`
    select
      (select count(*)::integer from organization) as organizations,
      (select count(*)::integer from instance_bootstrap) as bootstraps,
      (select count(*)::integer from runtime_configuration) as runtime_configurations,
      (select auth_secret from runtime_configuration) as auth_secret
  `);
  await bundle.runtime.close();

  assert.deepEqual(result.rows[0], {
    organizations: 1,
    bootstraps: 1,
    runtime_configurations: 1,
    auth_secret: firstSecret,
  });
});

async function storedAuthSecret(): Promise<string> {
  const bundle = await embeddedDatabaseRuntime(process.env["PASEO_HUB_DATA_DIR"]!);
  const result = await bundle.runtime.query<{ auth_secret: string }>(
    `select auth_secret from runtime_configuration`,
  );
  await bundle.runtime.close();
  const secret = result.rows[0]?.auth_secret;
  assert.ok(secret);
  return secret;
}

async function reopenEmbeddedStorage(): Promise<void> {
  const bundle = await embeddedDatabaseRuntime(process.env["PASEO_HUB_DATA_DIR"]!);
  await bundle.runtime.migrate();
  await bundle.runtime.close();
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function startUnavailableSlack(
  scenario: "server-error" | "hung-open" | "hung-open-body" | "missing-hello",
): Promise<{
  openUrl: string;
  readonly requestCount: number;
  close(): Promise<void>;
}> {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    if (scenario === "hung-open") return;
    response.setHeader("content-type", "application/json");
    if (scenario === "hung-open-body") {
      response.writeHead(200);
      response.write('{"ok":true,"url":"body-canary-never-finished');
      return;
    }
    if (scenario === "server-error") {
      response.writeHead(503);
      response.end(JSON.stringify({ ok: false, error: "temporarily_unavailable" }));
      return;
    }
    response.end(
      JSON.stringify({
        ok: true,
        url: `ws://127.0.0.1:${serverPort(server)}/socket`,
      }),
    );
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (client) =>
      webSockets.emit("connection", client),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    openUrl: `http://127.0.0.1:${serverPort(server)}/api/apps.connections.open`,
    get requestCount() {
      return requestCount;
    },
    async close() {
      for (const socket of webSockets.clients) socket.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function serverPort(server: Server): number {
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return address.port;
}
