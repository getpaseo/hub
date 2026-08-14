import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "vitest";
import { embeddedDatabaseRuntime } from "./db/runtime/index.js";
import { startProductionRuntime, stopProductionRuntime } from "./index.js";

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
] as const;

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
