import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterEach, describe, it } from "vitest";
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
import { createProviderApplicationInventory } from "./internal/inventory.js";
import { createProviderRuntimeReconciler } from "./internal/runtime-reconciler.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider runtime reconciliation", () => {
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
          initialSlackVersion: 1,
          environmentManaged: false,
          intervalMs: 5,
        });
        const second = createProviderRuntimeReconciler({
          database: fixture.bundle.runtime,
          store,
          runtime: secondRuntime.owner,
          callbackOrigin: "https://hub.example.test",
          instanceId: "hub-two",
          initialSlackVersion: 1,
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

function recordingRuntime(): { owner: ProviderRuntimeOwner; published: number[] } {
  const published: number[] = [];
  return {
    published,
    owner: {
      identity: () => ({ provider: "slack", id: "A1", name: "Paseo" }),
      slackDeliveryStatus: () => ({ state: "connected", since: new Date(), connectionCount: 1 }),
      prepare: (_provider, _configuration, _origin, _identity, version) =>
        Promise.resolve({
          start: () => Promise.resolve(),
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
