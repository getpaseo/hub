import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { embeddedDatabaseRuntime, type DatabaseRuntime } from "../db/runtime/index.js";
import type { InstanceAuthPolicy } from "../auth/instance-policy.js";
import { UNLIMITED_PROVISIONING } from "../organizations/provisioning.js";
import { InstanceSetup, type InitialOperator } from "./index.js";

const policy: InstanceAuthPolicy = {
  registrationMode: "invite_only",
  organizationCreation: "disabled",
  bootstrap: undefined,
};

const operator: InitialOperator = {
  name: "Embedded Operator",
  email: "embedded.operator@example.test",
  password: "embedded-operator-password",
  organizationName: "Embedded Organization",
};

describe("interactive instance setup on embedded storage", () => {
  let root: string;
  let database: DatabaseRuntime;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hub-instance-setup-embedded-"));
    const bundle = await embeddedDatabaseRuntime(join(root, "database"));
    database = bundle.runtime;
    await database.migrate();
  }, 120_000);

  afterEach(async () => {
    await database.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it("claims a pristine embedded instance once", async () => {
    const setup = instanceSetup(database);
    assert.equal(await setup.status(), "available");

    assert.deepEqual(await setup.claim(operator), { status: "claimed" });

    assert.equal(await setup.status(), "claimed");
    assert.deepEqual(await instanceState(database), {
      users: 1,
      operators: 1,
      organizations: 1,
      owners: 1,
      projects: 1,
      configurationSources: 1,
      completedSetups: 1,
      mustChangePassword: false,
    });
  }, 120_000);

  it("gives concurrent embedded claims exactly one winner", async () => {
    const setup = instanceSetup(database);

    const outcomes = await Promise.all([
      setup.claim(operator),
      setup.claim({ ...operator, email: "racing@example.test" }),
    ]);

    assert.equal(outcomes.filter(({ status }) => status === "claimed").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "unavailable").length, 1);
    assert.deepEqual(await instanceState(database), {
      users: 1,
      operators: 1,
      organizations: 1,
      owners: 1,
      projects: 1,
      configurationSources: 1,
      completedSetups: 1,
      mustChangePassword: false,
    });
  }, 120_000);

  it("stays closed on an embedded instance that already has accounts", async () => {
    await database.query(
      `insert into "user" (id, name, email, email_verified)
       values ('existing', 'Existing', 'existing@example.test', true)`,
    );

    assert.equal(await instanceSetup(database).status(), "blocked");
    assert.deepEqual(await instanceSetup(database).claim(operator), { status: "unavailable" });

    const state = await instanceState(database);
    assert.equal(state.operators, 0);
    assert.equal(state.organizations, 0);
    assert.equal(state.completedSetups, 0);
  }, 120_000);
});

function instanceSetup(database: DatabaseRuntime): InstanceSetup {
  return new InstanceSetup({
    database,
    policy,
    provisioningEntitlements: () => Promise.resolve(UNLIMITED_PROVISIONING),
  });
}

async function instanceState(database: DatabaseRuntime) {
  const result = await database.query<{
    users: number;
    operators: number;
    organizations: number;
    owners: number;
    projects: number;
    configuration_sources: number;
    completed_setups: number;
    must_change_password: boolean | null;
  }>(`
    select
      (select count(*)::integer from "user") as users,
      (select count(*)::integer from "user" where is_instance_operator) as operators,
      (select count(*)::integer from organization) as organizations,
      (select count(*)::integer from member where role = 'owner') as owners,
      (select count(*)::integer from projects where slug = 'default') as projects,
      (select count(*)::integer from project_configuration_sources where kind = 'manual') as configuration_sources,
      (select count(*)::integer from instance_bootstrap where completed_at is not null) as completed_setups,
      (select bool_or(must_change_password) from "user") as must_change_password
  `);
  const row = result.rows[0]!;
  return {
    users: row.users,
    operators: row.operators,
    organizations: row.organizations,
    owners: row.owners,
    projects: row.projects,
    configurationSources: row.configuration_sources,
    completedSetups: row.completed_setups,
    mustChangePassword: row.must_change_password,
  };
}
