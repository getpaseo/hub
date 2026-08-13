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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hub-production-embedded-"));
  previousEnvironment = new Map(ENVIRONMENT_NAMES.map((name) => [name, process.env[name]]));
  delete process.env["DATABASE_URL"];
  process.env["PASEO_HUB_DATA_DIR"] = join(root, "database");
  process.env["PASEO_HUB_AUTH_SECRET"] = "embedded-production-secret-at-least-32-characters";
  process.env["PASEO_HUB_APP_URL"] = "http://localhost:3000";
  process.env["PASEO_REGISTRATION_MODE"] = "invite_only";
  process.env["PASEO_ORGANIZATION_CREATION"] = "disabled";
  process.env["PASEO_BOOTSTRAP_ORGANIZATION"] = "Embedded owner";
  process.env["PASEO_BOOTSTRAP_OWNER_EMAIL"] = "owner@embedded.test";
  process.env["PASEO_BOOTSTRAP_OWNER_PASSWORD"] = "embedded-owner-password";
});

afterEach(async () => {
  await stopProductionRuntime();
  for (const [name, value] of previousEnvironment) restoreEnvironment(name, value);
  await rm(root, { recursive: true, force: true });
});

it("selects embedded storage without DATABASE_URL and preserves it across restarts", async () => {
  await startProductionRuntime();
  await stopProductionRuntime();
  await startProductionRuntime();
  await stopProductionRuntime();

  const bundle = await embeddedDatabaseRuntime(process.env["PASEO_HUB_DATA_DIR"]!);
  const result = await bundle.runtime.query<{ organizations: number; bootstraps: number }>(`
    select
      (select count(*)::integer from organization) as organizations,
      (select count(*)::integer from instance_bootstrap) as bootstraps
  `);
  await bundle.runtime.close();

  assert.deepEqual(result.rows[0], { organizations: 1, bootstraps: 1 });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
