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
import { createProviderApplicationStore } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider application persistence", () => {
  it("persists, versions, and reopens write-only provider configuration in PGlite", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-provider-applications-"));
    roots.push(root);
    const first = await embeddedDatabaseRuntime(root);
    await exercisePersistence(first);
    await first.runtime.close();

    const reopened = await embeddedDatabaseRuntime(root);
    await reopened.runtime.migrate();
    const stored = await createProviderApplicationStore(reopened.runtime, reopened.locks).read(
      "github",
    );
    assert.equal(stored?.version, 2);
    assert.equal(stored?.configuration.provider, "github");
    if (stored?.configuration.provider === "github") {
      assert.equal(stored.configuration.clientSecret, "rotated");
    }
    await reopened.runtime.close();
  });

  it("persists and serializes concurrent first saves in PostgreSQL", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    try {
      const bundle = await postgresDatabaseRuntime(postgres.getConnectionUri());
      await exercisePersistence(bundle);
      await bundle.runtime.close();

      const reopened = await postgresDatabaseRuntime(postgres.getConnectionUri());
      const stored = await createProviderApplicationStore(reopened.runtime, reopened.locks).read(
        "github",
      );
      assert.equal(stored?.version, 2);
      await reopened.runtime.close();
    } finally {
      await postgres.stop();
    }
  });
});

async function exercisePersistence(bundle: DatabaseRuntimeBundle) {
  await bundle.runtime.migrate();
  await bundle.runtime.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at,
                         must_change_password, is_instance_operator)
     values ('operator', 'Operator', 'operator@example.test', true, now(), now(), false, true)`,
  );
  const store = createProviderApplicationStore(bundle.runtime, bundle.locks);
  const configuration = {
    provider: "github" as const,
    appId: "42",
    appSlug: "paseo",
    clientId: "client",
    clientSecret: "secret",
    privateKey: "private-key",
    webhookSecret: "webhook-secret",
  };
  const identity = {
    provider: "github" as const,
    id: "42",
    name: "Paseo",
    ownerLogin: "acme",
  };
  const attempts = await Promise.allSettled([
    store.save({
      provider: "github",
      configuration,
      identity,
      expectedVersion: undefined,
      updatedByUserId: "operator",
    }),
    store.save({
      provider: "github",
      configuration,
      identity,
      expectedVersion: undefined,
      updatedByUserId: "operator",
    }),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = attempts.find((result) => result.status === "rejected");
  assert(rejected?.status === "rejected");
  assert.equal(
    rejected.reason instanceof Error ? rejected.reason.name : undefined,
    "ProviderConfigurationConflictError",
  );

  const rotated = await store.save({
    provider: "github",
    configuration: { ...configuration, clientSecret: "rotated" },
    identity,
    expectedVersion: 1,
    updatedByUserId: "operator",
  });
  assert.equal(rotated.version, 2);
}
