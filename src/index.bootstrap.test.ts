import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { HubHarness } from "./daemons/test-utils/hub-harness.js";
import { createDatabase } from "./db/pg.js";
import { startProductionRuntime, stopProductionRuntime } from "./index.js";

describe("production Hub runtime", () => {
  let hub: HubHarness;

  beforeEach(async () => {
    hub = await HubHarness.start();
  }, 120_000);

  afterEach(async () => {
    await hub.stop();
  }, 120_000);

  it("starts the manual source that serves production manual runs", async () => {
    await hub.connectDaemon();
    await hub.installConfiguration({ yaml: hub.manualConfigurationYaml() });

    const run = await hub.runManual({ service: "bootstrap" });

    assert.equal(run.status, 200);
    const execution = await hub.waitForPendingExecution();
    await hub.waitForRecoveredExecution(execution.id);
    assert.equal(hub.createdAgentLaunch().prompt, "Deploy the requested service");
  });
});

describe("production Hub cold start", () => {
  let postgres: StartedPostgreSqlContainer;
  let previousDatabaseUrl: string | undefined;
  let previousRegistrationMode: string | undefined;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  beforeEach(() => {
    previousDatabaseUrl = process.env["DATABASE_URL"];
    previousRegistrationMode = process.env["PASEO_REGISTRATION_MODE"];
  });

  afterEach(async () => {
    await stopProductionRuntime();
    restoreEnvironment("DATABASE_URL", previousDatabaseUrl);
    restoreEnvironment("PASEO_REGISTRATION_MODE", previousRegistrationMode);
  });

  afterAll(async () => {
    await postgres.stop();
  }, 120_000);

  it("does not bootstrap an owner without explicit bootstrap settings", async () => {
    const databaseUrl = postgres.getConnectionUri();
    const database = await createDatabase(databaseUrl);
    await database.close();

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(
      `insert into organization (id, name, slug) values ('existing-org', 'Existing', 'existing')`,
    );
    await client.end();

    process.env["DATABASE_URL"] = databaseUrl;
    process.env["PASEO_REGISTRATION_MODE"] = "disabled";

    const runtime = await startProductionRuntime();
    const verification = new Client({ connectionString: databaseUrl });
    await verification.connect();
    const result = await verification.query<{ count: number }>(
      `select count(*)::integer as count from instance_bootstrap`,
    );
    await verification.end();
    assert.equal(result.rows[0]?.count, 0);
    assert.ok(runtime);
  }, 120_000);

  it("runs configured bootstrap before exposing the production runtime", async () => {
    const databaseUrl = await isolatedDatabaseUrl(
      postgres.getConnectionUri(),
      "production_bootstrap",
    );
    const previous = new Map(
      [
        "DATABASE_URL",
        "PASEO_HUB_AUTH_SECRET",
        "PASEO_HUB_APP_URL",
        "PASEO_REGISTRATION_MODE",
        "PASEO_ORGANIZATION_CREATION",
        "PASEO_BOOTSTRAP_ORGANIZATION",
        "PASEO_BOOTSTRAP_OWNER_EMAIL",
        "PASEO_BOOTSTRAP_OWNER_PASSWORD",
      ].map((name) => [name, process.env[name]]),
    );
    process.env["DATABASE_URL"] = databaseUrl;
    process.env["PASEO_HUB_AUTH_SECRET"] = "production-bootstrap-secret-at-least-32-characters";
    process.env["PASEO_HUB_APP_URL"] = "http://localhost:3000";
    process.env["PASEO_REGISTRATION_MODE"] = "invite_only";
    process.env["PASEO_ORGANIZATION_CREATION"] = "disabled";
    process.env["PASEO_BOOTSTRAP_ORGANIZATION"] = "Production Customer";
    process.env["PASEO_BOOTSTRAP_OWNER_EMAIL"] = "production-owner@example.test";
    process.env["PASEO_BOOTSTRAP_OWNER_PASSWORD"] = "production-temporary-password";
    try {
      const runtime = await startProductionRuntime();
      assert.ok(runtime);
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      const result = await client.query<{
        organizations: number;
        owners: number;
        bootstrap: number;
      }>(`
        select
          (select count(*)::integer from organization) as organizations,
          (select count(*)::integer from member where role = 'owner') as owners,
          (select count(*)::integer from instance_bootstrap where completed_at is not null) as bootstrap
      `);
      await client.end();
      assert.deepEqual(result.rows[0], { organizations: 1, owners: 1, bootstrap: 1 });
    } finally {
      for (const [name, value] of previous) restoreEnvironment(name, value);
    }
  }, 120_000);
});

async function isolatedDatabaseUrl(baseUrl: string, name: string): Promise<string> {
  const base = new URL(baseUrl);
  base.pathname = "/postgres";
  const admin = new Client({ connectionString: base.toString() });
  await admin.connect();
  const databaseName = `${name}_${Date.now()}`;
  await admin.query(`create database "${databaseName}"`);
  await admin.end();
  base.pathname = `/${databaseName}`;
  return base.toString();
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
