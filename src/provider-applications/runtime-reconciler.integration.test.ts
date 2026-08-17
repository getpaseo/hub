import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterEach, describe, it } from "vitest";
import { WebSocketServer, type RawData } from "ws";
import { runWithFailureTracking } from "../failures/index.js";
import { createLogger } from "../logger.js";
import { FailureLogStream } from "../test-utils/failure-logs.js";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { createDatabase } from "../db/pg.js";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  type DatabaseRuntimeBundle,
} from "../db/runtime/index.js";
import type {
  ProviderApplicationStore,
  ProviderRuntimeOwner,
  StoredProviderApplication,
} from "./index.js";
import { createProviderApplications } from "./index.js";
import { createProviderApplicationInventory } from "./internal/inventory.js";
import { createProviderRuntimeReconciler } from "./internal/runtime-reconciler.js";
import { DynamicProviderRuntime } from "./internal/runtime-owner.js";
import type { SlackDeliveryStatus } from "../triggers/slack/source/index.js";
import { createSlackEventSource } from "../triggers/slack/source/index.js";
import type { TriggerSource } from "../triggers/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider runtime reconciliation", () => {
  it("shares local-save publication ownership with reconciliation over a real Socket", async () => {
    const fixture = await databaseFixture("PGlite");
    const slack = await countingSlackFixture();
    let reconciler: ReturnType<typeof createProviderRuntimeReconciler> | undefined;
    let stableSource: TriggerSource | undefined;
    try {
      await fixture.bundle.runtime.migrate();
      let stored: StoredProviderApplication | undefined;
      const store = localSaveStore(
        () => stored,
        async (value) => {
          stored = value;
          await activate(fixture.bundle, value);
        },
      );
      const runtime = new DynamicProviderRuntime({
        database: createMemoryDatabase(),
        auth: operatorAuth(),
        applicationBaseUrl: "https://hub.example.test",
        slackSocket: { apiUrl: slack.openUrl },
      });
      stableSource = runtime
        .registrations()
        .find((registration) => registration.connection.name === "slack")!.sources[0]!;
      await stableSource.start(() => Promise.resolve());
      const applications = createProviderApplications({
        auth: operatorAuth(),
        store,
        environment: {},
        runtime,
        verifier: { verify: () => Promise.reject(new Error("unused")) },
        slackSocketVerifier: {
          verify: (_appToken, botToken) =>
            Promise.resolve({
              appId: "A1",
              teamId: "T1",
              teamName: "Acme",
              botId: "B1",
              botUserId: "U1",
              botAccessToken: botToken,
              scopes: ["app_mentions:read", "chat:write"],
            }),
        },
        inventory: {
          connectedIdentities: () => Promise.resolve([]),
          claimLegacyConnections: () => Promise.resolve(true),
          lastEventAt: () => Promise.resolve(null),
        },
        callbackOrigin: () => Promise.resolve("https://hub.example.test"),
        beginCandidateConnection: (_request, _organizationId, _returnRoute, begin) =>
          begin(new Request("https://hub.example.test")),
      });

      const saved = await applications.configureSlackSocket(
        new Request("https://hub.example.test/apps", { method: "POST" }),
        { appToken: "xapp-local-save", botToken: "xoxb-local-save" },
      );
      assert.equal(saved.configurationVersion, 1);
      await eventually(() => slack.connectionCount() === 1);

      reconciler = createProviderRuntimeReconciler({
        database: fixture.bundle.runtime,
        store,
        runtime,
        callbackOrigin: "https://hub.example.test",
        instanceId: "hub-local-real-socket",
        environmentManaged: false,
        intervalMs: 5,
      });
      reconciler.start();
      await new Promise((resolve) => setTimeout(resolve, 75));

      assert.equal(slack.connectionCount(), 1);
      assert.equal(runtime.publishedApplication("slack")?.configurationVersion, 1);
    } finally {
      await reconciler?.stop();
      await stableSource?.stop();
      await stableSource?.drain?.();
      await slack.close();
      await fixture.close();
    }
  });

  it("does not republish the version already applied by a local save", async () => {
    const fixture = await databaseFixture("PGlite");
    try {
      await fixture.bundle.runtime.migrate();
      const stored = socketApplication(2);
      await activate(fixture.bundle, stored);
      const runtime = recordingRuntime([2]);
      const reconciler = createProviderRuntimeReconciler({
        database: fixture.bundle.runtime,
        store: readOnlyStore(() => stored),
        runtime: runtime.owner,
        callbackOrigin: "https://hub.example.test",
        instanceId: "hub-local-save",
        environmentManaged: false,
        intervalMs: 5,
      });

      reconciler.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await reconciler.stop();

      assert.deepEqual(runtime.published, [2]);
    } finally {
      await fixture.close();
    }
  });

  it("observes the published runtime version when desired persistence is newer", async () => {
    const fixture = await databaseFixture("PGlite");
    try {
      await fixture.bundle.runtime.migrate();
      const published = socketApplication(1);
      const desired = socketApplication(3);
      await activate(fixture.bundle, socketApplication(2));
      const runtime = recordingRuntime([published.version]);
      const reconciler = createProviderRuntimeReconciler({
        database: fixture.bundle.runtime,
        store: readOnlyStore(() => desired),
        runtime: runtime.owner,
        callbackOrigin: "https://hub.example.test",
        instanceId: "hub-failed-replacement",
        environmentManaged: false,
        intervalMs: 5,
      });

      reconciler.start();
      await eventually(async () => {
        const observation = await fixture.bundle.runtime.query<{
          configuration_version: number;
        }>(
          `select configuration_version from runtime_provider_instances
           where provider = 'slack' and instance_id = 'hub-failed-replacement'`,
        );
        return observation.rows[0]?.configuration_version === published.version;
      });
      await reconciler.stop();
    } finally {
      await fixture.close();
    }
  });

  it("keeps failed remote replacement health on the old published version", async () => {
    const fixture = await databaseFixture("PGlite");
    try {
      await fixture.bundle.runtime.migrate();
      const stored = socketApplication(2);
      await activate(fixture.bundle, stored);
      const runtime = recordingRuntime([1], undefined, 2);
      const reconciler = createProviderRuntimeReconciler({
        database: fixture.bundle.runtime,
        store: readOnlyStore(() => stored),
        runtime: runtime.owner,
        callbackOrigin: "https://hub.example.test",
        instanceId: "hub-replacement-failed",
        environmentManaged: false,
        intervalMs: 5,
      });

      reconciler.start();
      await eventually(async () => {
        const observation = await fixture.bundle.runtime.query<{
          configuration_version: number;
        }>(
          `select configuration_version from runtime_provider_instances
           where provider = 'slack' and instance_id = 'hub-replacement-failed'`,
        );
        return observation.rows[0]?.configuration_version === 1;
      });
      assert.deepEqual(runtime.published, [1]);
      await reconciler.stop();
    } finally {
      await fixture.close();
    }
  });

  it("owns remote Socket replacement attempts by desired version across real HTTP and WebSockets", async () => {
    const fixture = await databaseFixture("PGlite");
    const slack = await versionedSlackFixture({
      "xapp-terminal": ["invalid_auth"],
      "xapp-transient": ["service_unavailable", "service_unavailable"],
      "xapp-superseded": ["service_unavailable"],
    });
    const stream = new FailureLogStream();
    let reconciler: ReturnType<typeof createProviderRuntimeReconciler> | undefined;
    let stableSource: TriggerSource | undefined;
    try {
      await fixture.bundle.runtime.migrate();
      let stored = socketApplicationWithToken(2, "xapp-terminal");
      await activate(fixture.bundle, stored);
      const runtime = new DynamicProviderRuntime({
        database: createMemoryDatabase(),
        auth: operatorAuth(),
        applicationBaseUrl: "https://hub.example.test",
        slackSocket: {
          apiUrl: slack.openUrl,
          readinessTimeoutMs: 20,
          connectTimeoutMs: 100,
          random: () => 1,
        },
      });
      stableSource = runtime
        .registrations()
        .find((registration) => registration.connection.name === "slack")!.sources[0]!;
      await stableSource.start(() => Promise.resolve());
      const initial = await runtime.prepare(
        "slack",
        socketApplicationWithToken(1, "xapp-working").configuration,
        "https://hub.example.test",
        { provider: "slack", id: "A1", name: "Paseo" },
        1,
      );
      await initial.start();
      initial.publish();
      await slack.waitForActive("xapp-working", 1);

      reconciler = createProviderRuntimeReconciler({
        database: fixture.bundle.runtime,
        store: readOnlyStore(() => stored),
        runtime,
        callbackOrigin: "https://hub.example.test",
        instanceId: "hub-version-owned-attempts",
        environmentManaged: false,
        intervalMs: 5,
        retryBaseMs: 200,
      });

      runWithFailureTracking(() => reconciler!.start(), createLogger(stream));
      await eventually(() => slack.requestCount("xapp-terminal") === 1);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(slack.requestCount("xapp-terminal"), 1);
      assert.equal(runtime.publishedApplication("slack")?.configurationVersion, 1);
      assert.equal(slack.activeCount("xapp-working"), 1);
      assert.equal(stream.records().length, 1);

      stored = socketApplicationWithToken(3, "xapp-transient");
      await activate(fixture.bundle, stored);
      await eventually(() => runtime.publishedApplication("slack")?.configurationVersion === 3);
      const transientAttempts = slack.requestTimes("xapp-transient");
      assert.equal(transientAttempts.length, 3);
      assert.ok(transientAttempts[1]! - transientAttempts[0]! >= 150);
      assert.ok(transientAttempts[2]! - transientAttempts[1]! >= 350);
      assert.equal(slack.activeCount("xapp-working"), 0);
      assert.equal(slack.activeCount("xapp-transient"), 1);

      stored = socketApplicationWithToken(4, "xapp-superseded");
      await activate(fixture.bundle, stored);
      await eventually(() => slack.requestCount("xapp-superseded") === 1);
      const supersededAt = Date.now();
      stored = socketApplicationWithToken(5, "xapp-new-version");
      await activate(fixture.bundle, stored);
      await eventually(() => runtime.publishedApplication("slack")?.configurationVersion === 5);
      assert.ok(slack.requestTimes("xapp-new-version")[0]! - supersededAt < 150);
      assert.equal(slack.activeCount("xapp-transient"), 0);
      assert.equal(slack.activeCount("xapp-new-version"), 1);
    } finally {
      await reconciler?.stop();
      await stableSource?.stop();
      await stableSource?.drain?.();
      await slack.close();
      await fixture.close();
    }
  });

  it.each(["PGlite", "PostgreSQL"] as const)(
    "orders shared workspace degradation and recovery independently of instance expiry in %s",
    async (engine) => {
      const fixture = await databaseFixture(engine);
      try {
        await fixture.bundle.runtime.migrate();
        const database = createDatabase(fixture.bundle.runtime, fixture.bundle.locks);
        await fixture.bundle.runtime.query(
          `insert into runtime_provider_instances
             (provider, instance_id, provider_application_id, configuration_version, state,
              reason, delayed_workspaces, observed_at)
           values
             ('slack', 'hub-a-connected', 'A1', 1, 'connected', null, '[]'::jsonb, now()),
             ('slack', 'hub-a-stale', 'A1', 1, 'connected', null, '[]'::jsonb,
                now() - interval '46 seconds'),
             ('slack', 'hub-b-connected', 'A2', 1, 'connected', null, '[]'::jsonb, now())`,
        );
        await database.recordSlackWorkspaceDelivery({
          providerApplicationId: "A1",
          providerConfigurationVersion: 1,
          teamId: "T1",
          delayed: true,
          providerObservedAt: new Date("2026-01-01T00:00:00Z"),
        });
        await database.recordSlackWorkspaceDelivery({
          providerApplicationId: "A1",
          providerConfigurationVersion: 1,
          teamId: "T2",
          delayed: true,
          providerObservedAt: new Date("2026-01-01T00:00:01Z"),
        });
        await database.recordSlackWorkspaceDelivery({
          providerApplicationId: "A2",
          providerConfigurationVersion: 1,
          teamId: "T9",
          delayed: true,
          providerObservedAt: new Date("2026-01-01T00:00:03Z"),
        });
        const inventory = createProviderApplicationInventory(fixture.bundle.runtime);

        let first = await inventory.slackDeliveryStatus?.("A1", 1);
        const second = await inventory.slackDeliveryStatus?.("A2", 1);
        assert.equal(first?.state, "connected");
        assert.equal(first?.state === "connected" ? first.connectionCount : undefined, 1);
        assert.deepEqual(delayedTeamIds(first), ["T1", "T2"]);
        assert.deepEqual(delayedTeamIds(second), ["T9"]);

        await database.recordSlackWorkspaceDelivery({
          providerApplicationId: "A1",
          providerConfigurationVersion: 1,
          teamId: "T1",
          delayed: false,
          providerObservedAt: new Date("2026-01-01T00:00:03Z"),
        });
        first = await inventory.slackDeliveryStatus?.("A1", 1);
        assert.deepEqual(delayedTeamIds(first), ["T2"]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await database.recordSlackWorkspaceDelivery({
          providerApplicationId: "A1",
          providerConfigurationVersion: 1,
          teamId: "T1",
          delayed: true,
          providerObservedAt: new Date("2026-01-01T00:00:03Z"),
        });
        first = await inventory.slackDeliveryStatus?.("A1", 1);
        assert.deepEqual(delayedTeamIds(first), ["T1", "T2"]);
        await database.recordSlackWorkspaceDelivery({
          providerApplicationId: "A1",
          providerConfigurationVersion: 1,
          teamId: "T1",
          delayed: false,
          providerObservedAt: new Date("2025-01-01T00:00:00Z"),
        });
        first = await inventory.slackDeliveryStatus?.("A1", 1);
        assert.deepEqual(delayedTeamIds(first), ["T2"]);
      } finally {
        await fixture.close();
      }
    },
  );

  it("shares acknowledged workspace recovery across two real PostgreSQL runtimes and WebSockets", async () => {
    const fixture = await databaseFixture("PostgreSQL");
    const secondBundle = await fixture.connect!();
    const slack = await countingSlackFixture();
    let firstSource: ReturnType<typeof createSlackEventSource> | undefined;
    let secondSource: ReturnType<typeof createSlackEventSource> | undefined;
    let dispatches = 0;
    try {
      await fixture.bundle.runtime.migrate();
      const firstDatabase = createDatabase(fixture.bundle.runtime, fixture.bundle.locks);
      const secondDatabase = createDatabase(secondBundle.runtime, secondBundle.locks);
      await fixture.bundle.runtime.query(
        `insert into runtime_provider_instances
           (provider, instance_id, provider_application_id, configuration_version, state,
            reason, delayed_workspaces, observed_at)
         values
           ('slack', 'hub-real-a', 'A1', 1, 'connected', null, '[]'::jsonb, now()),
           ('slack', 'hub-real-b', 'A1', 1, 'connected', null, '[]'::jsonb, now())`,
      );
      const source = (database: typeof firstDatabase) =>
        createSlackEventSource({
          configuration: {
            provider: "slack",
            transport: "socket",
            appId: "A1",
            appToken: "xapp-shared-observation-canary",
          },
          configurationVersion: 1,
          socket: { apiUrl: slack.openUrl },
          recordWorkspaceDelivery: (teamId, delayed, providerObservedAt) =>
            database.recordSlackWorkspaceDelivery({
              providerApplicationId: "A1",
              providerConfigurationVersion: 1,
              teamId,
              delayed,
              providerObservedAt,
            }),
          accept: (input) =>
            Promise.resolve({
              status: "accepted" as const,
              receiptId: `receipt-${input.deliveryId}`,
              events: [
                {
                  providerEventReceiptId: `receipt-${input.deliveryId}`,
                  organizationId: "org",
                  projectId: "project",
                  configurationRevisionId: "revision",
                  deliveryId: input.deliveryId,
                  source: "slack.mention",
                  payload: input.payload,
                  receivedAt: input.receivedAt,
                  connectionId: null,
                  resourceId: input.teamId,
                },
              ],
            }),
        });
      firstSource = source(firstDatabase);
      secondSource = source(secondDatabase);
      await Promise.all([
        firstSource.source.start(() => {
          dispatches += 1;
          return Promise.resolve();
        }),
        secondSource.source.start(() => {
          dispatches += 1;
          return Promise.resolve();
        }),
      ]);
      await slack.waitForConnections(2);

      slack.send(0, rateLimitedEnvelope("limited-t1", "T1"));
      slack.send(0, rateLimitedEnvelope("limited-t2", "T2"));
      await slack.waitForAck("limited-t1");
      await slack.waitForAck("limited-t2");
      slack.send(1, mentionEnvelope("recovered-t1", "event-t1", "T1"));
      await slack.waitForAck("recovered-t1");
      assert.equal(dispatches, 1);

      const status = await createProviderApplicationInventory(
        secondBundle.runtime,
      ).slackDeliveryStatus?.("A1", 1);
      assert.deepEqual(
        status?.state === "connected"
          ? status.delayedWorkspaces?.map((workspace) => workspace.teamId)
          : undefined,
        ["T2"],
      );
    } finally {
      await firstSource?.source.stop();
      await secondSource?.source.stop();
      await slack.close();
      await secondBundle.runtime.close();
      await fixture.close();
    }
  });

  it("persists an app identity action and clears it after corrected runtime health", async () => {
    const fixture = await databaseFixture("PGlite");
    try {
      await fixture.bundle.runtime.migrate();
      const stored = socketApplication(1);
      await activate(fixture.bundle, stored);
      let status: SlackDeliveryStatus = {
        state: "actionNeeded",
        reason: "appIdentityMismatch",
        since: new Date(),
      };
      const runtime = recordingRuntime([1], () => status);
      const reconciler = createProviderRuntimeReconciler({
        database: fixture.bundle.runtime,
        store: readOnlyStore(() => stored),
        runtime: runtime.owner,
        callbackOrigin: "https://hub.example.test",
        instanceId: "hub-app-identity",
        environmentManaged: false,
        intervalMs: 5,
      });
      const inventory = createProviderApplicationInventory(fixture.bundle.runtime);

      reconciler.start();
      await eventually(async () => {
        const delivery = await inventory.slackDeliveryStatus?.("A1", 1);
        return delivery?.state === "actionNeeded" && delivery.reason === "appIdentityMismatch";
      });
      status = { state: "connected", since: new Date(), connectionCount: 1 };
      await eventually(async () => {
        const delivery = await inventory.slackDeliveryStatus?.("A1", 1);
        return delivery?.state === "connected";
      });

      await reconciler.stop();
    } finally {
      await fixture.close();
    }
  });

  it("persists permanent Slack workspace access denial as an actionable observation", async () => {
    const fixture = await databaseFixture("PGlite");
    try {
      await fixture.bundle.runtime.migrate();
      const stored = socketApplication(1);
      await activate(fixture.bundle, stored);
      const runtime = recordingRuntime([1], () => ({
        state: "actionNeeded",
        reason: "workspaceAccessDenied",
        since: new Date(),
      }));
      const reconciler = createProviderRuntimeReconciler({
        database: fixture.bundle.runtime,
        store: readOnlyStore(() => stored),
        runtime: runtime.owner,
        callbackOrigin: "https://hub.example.test",
        instanceId: "hub-app-access-denied",
        environmentManaged: false,
        intervalMs: 5,
      });
      const inventory = createProviderApplicationInventory(fixture.bundle.runtime);

      reconciler.start();
      await eventually(async () => {
        const delivery = await inventory.slackDeliveryStatus?.("A1", 1);
        return delivery?.state === "actionNeeded" && delivery.reason === "workspaceAccessDenied";
      });
      await reconciler.stop();
    } finally {
      await fixture.close();
    }
  });

  it.each(["PGlite", "PostgreSQL"] as const)(
    "converges two instances and aggregates their Socket health in %s",
    async (engine) => {
      const fixture = await databaseFixture(engine);
      try {
        await fixture.bundle.runtime.migrate();
        let stored = socketApplication(1);
        const store = readOnlyStore(() => stored);
        const firstRuntime = recordingRuntime();
        const secondRuntime = recordingRuntime();
        await activate(fixture.bundle, stored);

        const first = createProviderRuntimeReconciler({
          database: fixture.bundle.runtime,
          store,
          runtime: firstRuntime.owner,
          callbackOrigin: "https://hub.example.test",
          instanceId: "hub-one",
          environmentManaged: false,
          intervalMs: 5,
        });
        const second = createProviderRuntimeReconciler({
          database: fixture.bundle.runtime,
          store,
          runtime: secondRuntime.owner,
          callbackOrigin: "https://hub.example.test",
          instanceId: "hub-two",
          environmentManaged: false,
          intervalMs: 5,
        });

        first.start();
        second.start();
        await eventually(async () => {
          const status = await createProviderApplicationInventory(
            fixture.bundle.runtime,
          ).slackDeliveryStatus?.("A1", 1);
          return status?.state === "connected" && status.connectionCount === 2;
        });

        stored = socketApplication(2);
        await activate(fixture.bundle, stored);
        await eventually(
          () => firstRuntime.published.includes(2) && secondRuntime.published.includes(2),
        );
        await eventually(async () => {
          const status = await createProviderApplicationInventory(
            fixture.bundle.runtime,
          ).slackDeliveryStatus?.("A1", 2);
          return status?.state === "connected" && status.connectionCount === 2;
        });

        await Promise.all([first.stop(), second.stop()]);
        const observations = await fixture.bundle.runtime.query(
          "select instance_id from runtime_provider_instances where provider = 'slack'",
        );
        assert.equal(observations.rowCount, 0);
      } finally {
        await fixture.close();
      }
    },
    120_000,
  );
});

function socketApplication(version: number): StoredProviderApplication {
  return {
    provider: "slack",
    configuration: {
      provider: "slack",
      transport: "socket",
      appId: "A1",
      appToken: "xapp-safe-test-token",
    },
    identity: { provider: "slack", id: "A1", name: "Paseo" },
    version,
    verifiedAt: new Date(0),
    updatedAt: new Date(0),
    updatedByUserId: null,
  };
}

function socketApplicationWithToken(version: number, appToken: string): StoredProviderApplication {
  const application = socketApplication(version);
  return {
    ...application,
    configuration: {
      provider: "slack",
      transport: "socket",
      appId: "A1",
      appToken,
    },
  };
}

function readOnlyStore(
  read: () => StoredProviderApplication,
): Pick<ProviderApplicationStore, "read"> {
  return { read: () => Promise.resolve(read()) };
}

function localSaveStore(
  read: () => StoredProviderApplication | undefined,
  publish: (value: StoredProviderApplication) => Promise<void>,
): ProviderApplicationStore {
  return {
    read: (provider) => Promise.resolve(provider === "slack" ? read() : undefined),
    readAll: () => Promise.resolve(read() === undefined ? [] : [read()!]),
    save: () => Promise.reject(new Error("unused")),
    activate: () => Promise.reject(new Error("unused")),
    completeSlackInstallation: () => Promise.reject(new Error("unused")),
    async completeSlackSocketApplication(input) {
      const value: StoredProviderApplication = {
        provider: "slack",
        configuration: input.configuration,
        identity: input.identity,
        version: (read()?.version ?? 0) + 1,
        verifiedAt: new Date(),
        updatedAt: new Date(),
        updatedByUserId: input.updatedByUserId,
      };
      await publish(value);
      return value;
    },
    bindSlackSocketWorkspace: () => Promise.resolve(),
  };
}

function operatorAuth(): AuthServer {
  return {
    handle: () => Promise.reject(new Error("unused")),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        account: { id: "operator", name: "Operator", email: "operator@example.test" },
        session: {
          id: "session",
          userId: "operator",
          activeOrganizationId: "org",
          expiresAt: new Date(Date.now() + 60_000),
        },
        isInstanceOperator: true,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  } as AuthServer;
}

async function countingSlackFixture(): Promise<{
  openUrl: string;
  connectionCount(): number;
  waitForConnections(count: number): Promise<void>;
  send(index: number, payload: unknown): void;
  waitForAck(envelopeId: string): Promise<void>;
  close(): Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${serverPort(server)}/socket` }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  let opened = 0;
  const clients: import("ws").WebSocket[] = [];
  const acknowledgements = new Set<string>();
  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit("connection", webSocket);
    });
  });
  sockets.on("connection", (socket) => {
    opened += 1;
    clients.push(socket);
    socket.on("message", (data) => {
      const value: unknown = JSON.parse(socketFrameText(data));
      if (value !== null && typeof value === "object") {
        const envelopeId: unknown = Reflect.get(value, "envelope_id");
        if (typeof envelopeId === "string") acknowledgements.add(envelopeId);
      }
    });
    socket.send(
      JSON.stringify({ type: "hello", connection_info: { app_id: "A1" }, num_connections: 1 }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    openUrl: `http://127.0.0.1:${serverPort(server)}/api/apps.connections.open`,
    connectionCount: () => opened,
    waitForConnections: (count) => eventually(() => clients.length >= count),
    send(index, payload) {
      const client = clients[index];
      if (client === undefined) throw new Error(`Slack connection ${index} is unavailable`);
      client.send(JSON.stringify(payload));
    },
    waitForAck: (envelopeId) => eventually(() => acknowledgements.has(envelopeId)),
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    },
  };
}

async function versionedSlackFixture(
  failures: Readonly<Record<string, readonly string[]>>,
): Promise<{
  openUrl: string;
  requestCount(token: string): number;
  requestTimes(token: string): readonly number[];
  activeCount(token: string): number;
  waitForActive(token: string, count: number): Promise<void>;
  close(): Promise<void>;
}> {
  const attempts = new Map<string, number>();
  const times = new Map<string, number[]>();
  const active = new Map<string, Set<import("ws").WebSocket>>();
  const socketTokens = new WeakMap<import("ws").WebSocket, string>();
  const server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : authorization;
    const attempt = attempts.get(token) ?? 0;
    attempts.set(token, attempt + 1);
    const tokenTimes = times.get(token) ?? [];
    tokenTimes.push(Date.now());
    times.set(token, tokenTimes);
    const failure = failures[token]?.[attempt];
    response.setHeader("content-type", "application/json");
    if (failure !== undefined) {
      response.end(JSON.stringify({ ok: false, error: failure }));
      return;
    }
    response.end(
      JSON.stringify({
        ok: true,
        url: `ws://127.0.0.1:${serverPort(server)}/socket?token=${encodeURIComponent(token)}`,
      }),
    );
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      const token = new URL(request.url ?? "/", "http://fixture").searchParams.get("token") ?? "";
      socketTokens.set(webSocket, token);
      sockets.emit("connection", webSocket, request);
    });
  });
  sockets.on("connection", (socket) => {
    const token = socketTokens.get(socket) ?? "";
    const tokenSockets = active.get(token) ?? new Set<import("ws").WebSocket>();
    tokenSockets.add(socket);
    active.set(token, tokenSockets);
    socket.once("close", () => tokenSockets.delete(socket));
    socket.send(
      JSON.stringify({ type: "hello", connection_info: { app_id: "A1" }, num_connections: 1 }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    openUrl: `http://127.0.0.1:${serverPort(server)}/api/apps.connections.open`,
    requestCount: (token) => attempts.get(token) ?? 0,
    requestTimes: (token) => times.get(token) ?? [],
    activeCount: (token) => active.get(token)?.size ?? 0,
    waitForActive: (token, count) => eventually(() => (active.get(token)?.size ?? 0) === count),
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    },
  };
}

function serverPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server not listening");
  return address.port;
}

function recordingRuntime(
  initiallyPublished: number[] = [],
  status?: () => ReturnType<NonNullable<ProviderRuntimeOwner["slackDeliveryStatus"]>>,
  failingVersion?: number,
): {
  owner: ProviderRuntimeOwner;
  published: number[];
} {
  const published: number[] = [...initiallyPublished];
  return {
    published,
    owner: {
      identity: () => ({ provider: "slack", id: "A1", name: "Paseo" }),
      publishedApplication: () => {
        const version = published.at(-1);
        return version === undefined
          ? undefined
          : {
              configuration: socketApplication(version).configuration,
              identity: { provider: "slack" as const, id: "A1", name: "Paseo" },
              configurationVersion: version,
            };
      },
      slackDeliveryStatus:
        status ?? (() => ({ state: "connected", since: new Date(), connectionCount: 1 }) as const),
      prepare: (_provider, _configuration, _origin, _identity, version) =>
        Promise.resolve({
          start: () =>
            version === failingVersion
              ? Promise.reject(new Error("replacement start failed"))
              : Promise.resolve(),
          publish: () => published.push(version),
          close: () => Promise.resolve(),
        }),
    },
  };
}

async function activate(
  bundle: DatabaseRuntimeBundle,
  stored: StoredProviderApplication,
): Promise<void> {
  await bundle.runtime.query(
    `insert into runtime_provider_activation
       (provider, provider_application_id, configuration_version, activated_at)
     values ('slack', $1, $2, now())
     on conflict (provider) do update set
       provider_application_id = excluded.provider_application_id,
       configuration_version = excluded.configuration_version,
       activated_at = excluded.activated_at`,
    [stored.identity.id, stored.version],
  );
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
}

function delayedTeamIds(status: SlackDeliveryStatus | undefined): string[] | undefined {
  if (status?.state !== "connected") return undefined;
  return status.delayedWorkspaces?.map((workspace) => workspace.teamId);
}

async function databaseFixture(engine: "PGlite" | "PostgreSQL"): Promise<{
  bundle: DatabaseRuntimeBundle;
  connect?: () => Promise<DatabaseRuntimeBundle>;
  close(): Promise<void>;
}> {
  if (engine === "PGlite") {
    const root = await mkdtemp(join(tmpdir(), "hub-provider-runtime-reconciler-"));
    roots.push(root);
    const bundle = await embeddedDatabaseRuntime(root);
    return { bundle, close: () => bundle.runtime.close() };
  }
  const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  const bundle = await postgresDatabaseRuntime(postgres.getConnectionUri());
  return {
    bundle,
    connect: () => postgresDatabaseRuntime(postgres.getConnectionUri()),
    close: async () => {
      await bundle.runtime.close();
      await postgres.stop();
    },
  };
}

function rateLimitedEnvelope(envelopeId: string, teamId: string): unknown {
  return {
    type: "events_api",
    envelope_id: envelopeId,
    payload: { type: "app_rate_limited", team_id: teamId, minute_rate_limited: 1_700_000_000 },
  };
}

function mentionEnvelope(envelopeId: string, eventId: string, teamId: string): unknown {
  return {
    type: "events_api",
    envelope_id: envelopeId,
    payload: {
      type: "event_callback",
      team_id: teamId,
      api_app_id: "A1",
      event_id: eventId,
      event_time: 1_699_999_000,
      event: {
        type: "app_mention",
        user: "U1",
        channel: "C1",
        text: "<@UBOT> hello",
        ts: "1700000000.001",
        event_ts: "1700000000.001",
      },
    },
  };
}

function socketFrameText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
