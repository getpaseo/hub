import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterEach, describe, it } from "vitest";
import { WebSocketServer } from "ws";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
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

  it.each(["PGlite", "PostgreSQL"] as const)(
    "keeps mixed-instance transport connected while workspace degradation recovers in %s",
    async (engine) => {
      const fixture = await databaseFixture(engine);
      try {
        await fixture.bundle.runtime.migrate();
        const stored = socketApplication(1);
        await activate(fixture.bundle, stored);
        let firstStatus: SlackDeliveryStatus = {
          state: "connected" as const,
          since: new Date(),
          connectionCount: 1,
          delayedWorkspaces: [{ teamId: "T1", since: new Date() }],
        };
        const firstRuntime = recordingRuntime([1], () => firstStatus);
        const secondRuntime = recordingRuntime([1]);
        const first = createProviderRuntimeReconciler({
          database: fixture.bundle.runtime,
          store: readOnlyStore(() => stored),
          runtime: firstRuntime.owner,
          callbackOrigin: "https://hub.example.test",
          instanceId: "hub-rate-limited",
          environmentManaged: false,
          intervalMs: 5,
        });
        const second = createProviderRuntimeReconciler({
          database: fixture.bundle.runtime,
          store: readOnlyStore(() => stored),
          runtime: secondRuntime.owner,
          callbackOrigin: "https://hub.example.test",
          instanceId: "hub-connected",
          environmentManaged: false,
          intervalMs: 5,
        });

        first.start();
        second.start();
        const inventory = createProviderApplicationInventory(fixture.bundle.runtime);
        await eventually(async () => {
          const observation = await fixture.bundle.runtime.query<{ state: string }>(
            `select state from runtime_provider_instances
           where provider = 'slack' and instance_id = 'hub-rate-limited'`,
          );
          return observation.rows[0]?.state === "connected";
        });
        await eventually(async () => {
          const status = await inventory.slackDeliveryStatus?.("A1", 1);
          return (
            status?.state === "connected" &&
            status.connectionCount === 2 &&
            status.delayedWorkspaces?.[0]?.teamId === "T1"
          );
        });
        firstStatus = { state: "connected", since: new Date(), connectionCount: 1 };
        await eventually(async () => {
          const status = await inventory.slackDeliveryStatus?.("A1", 1);
          return status?.state === "connected" && status.connectionCount === 2;
        });

        await Promise.all([first.stop(), second.stop()]);
      } finally {
        await fixture.close();
      }
    },
  );

  it.each(["PGlite", "PostgreSQL"] as const)(
    "isolates, expires, and recovers persisted workspace degradation in %s",
    async (engine) => {
      const fixture = await databaseFixture(engine);
      try {
        await fixture.bundle.runtime.migrate();
        const delayedAt = new Date().toISOString();
        await fixture.bundle.runtime.query(
          `insert into runtime_provider_instances
             (provider, instance_id, provider_application_id, configuration_version, state,
              reason, delayed_workspaces, observed_at)
           values
             ('slack', 'hub-a-connected', 'A1', 1, 'connected', null, '[]'::jsonb, now()),
             ('slack', 'hub-a-delayed', 'A1', 1, 'connected', null, $1::jsonb, now()),
             ('slack', 'hub-b-delayed', 'A2', 1, 'connected', null, $2::jsonb, now())`,
          [
            JSON.stringify([{ teamId: "T1", since: delayedAt }]),
            JSON.stringify([{ teamId: "T2", since: delayedAt }]),
          ],
        );
        const inventory = createProviderApplicationInventory(fixture.bundle.runtime);

        let first = await inventory.slackDeliveryStatus?.("A1", 1);
        let second = await inventory.slackDeliveryStatus?.("A2", 1);
        assert.equal(first?.state, "connected");
        assert.equal(first?.state === "connected" ? first.connectionCount : undefined, 2);
        assert.deepEqual(
          first?.state === "connected"
            ? first.delayedWorkspaces?.map((workspace) => workspace.teamId)
            : undefined,
          ["T1"],
        );
        assert.deepEqual(
          second?.state === "connected"
            ? second.delayedWorkspaces?.map((workspace) => workspace.teamId)
            : undefined,
          ["T2"],
        );

        await fixture.bundle.runtime.query(
          `update runtime_provider_instances set delayed_workspaces = '[]'::jsonb
           where instance_id = 'hub-a-delayed'`,
        );
        first = await inventory.slackDeliveryStatus?.("A1", 1);
        assert.equal(first?.state === "connected" ? first.delayedWorkspaces : undefined, undefined);

        await fixture.bundle.runtime.query(
          `update runtime_provider_instances
           set delayed_workspaces = $1::jsonb, observed_at = now() - interval '46 seconds'
           where instance_id = 'hub-a-delayed'`,
          [JSON.stringify([{ teamId: "T1", since: delayedAt }])],
        );
        first = await inventory.slackDeliveryStatus?.("A1", 1);
        assert.equal(first?.state === "connected" ? first.delayedWorkspaces : undefined, undefined);
      } finally {
        await fixture.close();
      }
    },
  );

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
        reason: "appAccessDenied",
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
        return delivery?.state === "actionNeeded" && delivery.reason === "appAccessDenied";
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
  close(): Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${serverPort(server)}/socket` }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  let opened = 0;
  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit("connection", webSocket);
    });
  });
  sockets.on("connection", (socket) => {
    opened += 1;
    socket.send(
      JSON.stringify({ type: "hello", connection_info: { app_id: "A1" }, num_connections: 1 }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    openUrl: `http://127.0.0.1:${serverPort(server)}/api/apps.connections.open`,
    connectionCount: () => opened,
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

async function databaseFixture(engine: "PGlite" | "PostgreSQL"): Promise<{
  bundle: DatabaseRuntimeBundle;
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
    close: async () => {
      await bundle.runtime.close();
      await postgres.stop();
    },
  };
}
