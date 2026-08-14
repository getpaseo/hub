import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase, createPostgresPool } from "../db/test-utils/runtime.js";
import type { DatabaseRuntime } from "../db/runtime/index.js";
import type { InstanceAuthPolicy } from "../auth/instance-policy.js";
import { UNLIMITED_PROVISIONING } from "../organizations/provisioning.js";
import { InstanceSetup, type InitialOperator } from "./index.js";

const policy: InstanceAuthPolicy = {
  registrationMode: "invite_only",
  organizationCreation: "disabled",
  bootstrap: undefined,
};

const operator: InitialOperator = {
  name: "First Operator",
  email: "First.Operator@Example.test",
  password: "first-operator-password",
  organizationName: "First Organization",
};

describe("interactive instance setup", () => {
  let postgres: StartedPostgreSqlContainer;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  }, 120_000);

  it("claims a pristine instance for exactly one operator", async () => {
    const pool = await pristineInstance(postgres, "claim_pristine");
    const setup = instanceSetup(pool);
    assert.equal(await setup.status(), "available");

    assert.deepEqual(await setup.claim(operator), { status: "claimed" });

    const claimed = await instanceState(pool);
    assert.deepEqual(claimed, {
      users: 1,
      credentialAccounts: 1,
      organizations: 1,
      owners: 1,
      projects: 1,
      configurationSources: 1,
      entitlements: 1,
      completedSetups: 1,
      operators: 1,
      operatorEmail: "first.operator@example.test",
      operatorName: "First Operator",
      mustChangePassword: false,
      organizationName: "First Organization",
      completionMatchesOwner: true,
    });
    assert.equal(await setup.status(), "claimed");

    // A second visitor arriving at a stale welcome screen is refused, and writes nothing.
    assert.deepEqual(await setup.claim({ ...operator, email: "second@example.test" }), {
      status: "unavailable",
    });
    assert.deepEqual(await instanceState(pool), claimed);
    await pool.close();
  }, 120_000);

  it("gives concurrent claims exactly one winner and no partial state", async () => {
    const first = await pristineInstance(postgres, "claim_race");
    const second = await createPostgresPool(databaseUrlOf(first));

    const outcomes = await Promise.all([
      instanceSetup(first).claim(operator),
      instanceSetup(second).claim({
        ...operator,
        email: "racing@example.test",
        organizationName: "Racing Organization",
      }),
    ]);

    assert.equal(outcomes.filter(({ status }) => status === "claimed").length, 1);
    assert.equal(outcomes.filter(({ status }) => status === "unavailable").length, 1);
    const state = await instanceState(first);
    assert.equal(state.users, 1);
    assert.equal(state.credentialAccounts, 1);
    assert.equal(state.organizations, 1);
    assert.equal(state.owners, 1);
    assert.equal(state.projects, 1);
    assert.equal(state.configurationSources, 1);
    assert.equal(state.completedSetups, 1);
    assert.equal(state.completionMatchesOwner, true);
    await first.close();
    await second.close();
  }, 120_000);

  it("stays closed for an instance that already has accounts", async () => {
    const pool = await pristineInstance(postgres, "claim_existing_user");
    await pool.query(
      `insert into "user" (id, name, email, email_verified)
       values ('existing', 'Existing', 'existing@example.test', true)`,
    );

    assert.equal(await instanceSetup(pool).status(), "blocked");
    assert.deepEqual(await instanceSetup(pool).claim(operator), { status: "unavailable" });

    const state = await instanceState(pool);
    assert.equal(state.users, 1);
    assert.equal(state.operators, 0);
    assert.equal(state.organizations, 0);
    assert.equal(state.completedSetups, 0);
    await pool.close();
  }, 120_000);

  it("stays closed for an instance that already has tenant data", async () => {
    const pool = await pristineInstance(postgres, "claim_existing_organization");
    await pool.query(
      `insert into organization (id, name, slug) values ('existing', 'Existing', 'existing')`,
    );

    assert.equal(await instanceSetup(pool).status(), "blocked");
    assert.deepEqual(await instanceSetup(pool).claim(operator), { status: "unavailable" });

    const state = await instanceState(pool);
    assert.equal(state.users, 0);
    assert.equal(state.organizations, 1);
    assert.equal(state.completedSetups, 0);
    await pool.close();
  }, 120_000);

  it("stays closed for a half-written setup record", async () => {
    const pool = await pristineInstance(postgres, "claim_partial_state");
    await pool.query(
      `insert into "user" (id, name, email, email_verified)
       values ('half', 'Half written', 'half@example.test', true)`,
    );
    // Ownership recorded without completion: a repair attempt, or hand-edited state. Setup must
    // refuse it rather than treat the missing completion as an unclaimed instance.
    await pool.query(
      `insert into instance_bootstrap (id, owner_user_id) values ('default', 'half')`,
    );

    assert.equal(await instanceSetup(pool).status(), "blocked");
    assert.deepEqual(await instanceSetup(pool).claim(operator), { status: "unavailable" });

    const state = await instanceState(pool);
    assert.equal(state.users, 1);
    assert.equal(state.organizations, 0);
    assert.equal(state.completedSetups, 0);
    await pool.close();
  }, 120_000);

  it("is closed by environment bootstrap", async () => {
    const pool = await pristineInstance(postgres, "claim_after_bootstrap");
    const bootstrapped = new InstanceSetup({
      database: pool,
      policy: {
        ...policy,
        bootstrap: {
          organizationName: "Configured Organization",
          ownerEmail: "configured@example.test",
          ownerPassword: "configured-owner-password",
        },
      },
      provisioningEntitlements: () => Promise.resolve(UNLIMITED_PROVISIONING),
    });
    await bootstrapped.initializeFromPolicy();

    assert.equal(await bootstrapped.status(), "claimed");
    assert.deepEqual(await instanceSetup(pool).claim(operator), { status: "unavailable" });

    const state = await instanceState(pool);
    assert.equal(state.users, 1);
    assert.equal(state.operatorEmail, "configured@example.test");
    // The environment path keeps issuing a temporary password; only the interactive one is final.
    assert.equal(state.mustChangePassword, true);
    await pool.close();
  }, 120_000);
});

function instanceSetup(database: DatabaseRuntime): InstanceSetup {
  return new InstanceSetup({
    database,
    policy,
    provisioningEntitlements: () => Promise.resolve(UNLIMITED_PROVISIONING),
  });
}

const databaseUrls = new WeakMap<DatabaseRuntime, string>();

function databaseUrlOf(pool: DatabaseRuntime): string {
  const url = databaseUrls.get(pool);
  if (url === undefined) throw new Error("pool was not created by this test");
  return url;
}

/** A migrated database with no accounts, organizations, or setup record. */
async function pristineInstance(
  postgres: StartedPostgreSqlContainer,
  name: string,
): Promise<DatabaseRuntime> {
  const base = new URL(postgres.getConnectionUri());
  base.pathname = "/postgres";
  const admin = await createPostgresPool(base.toString());
  const databaseName = `${name}_${Date.now()}`;
  await admin.query(`create database "${databaseName}"`);
  await admin.close();
  base.pathname = `/${databaseName}`;
  const url = base.toString();
  const migrated = await createDatabase(url);
  await migrated.close();
  const pool = await createPostgresPool(url);
  databaseUrls.set(pool, url);
  return pool;
}

async function instanceState(pool: DatabaseRuntime) {
  const result = await pool.query<{
    users: number;
    credential_accounts: number;
    organizations: number;
    owners: number;
    projects: number;
    configuration_sources: number;
    entitlements: number;
    completed_setups: number;
    operators: number;
    operator_email: string | null;
    operator_name: string | null;
    must_change_password: boolean | null;
    organization_name: string | null;
    completion_matches_owner: boolean;
  }>(`
    select
      (select count(*)::integer from "user") as users,
      (select count(*)::integer from account where provider_id = 'credential') as credential_accounts,
      (select count(*)::integer from organization) as organizations,
      (select count(*)::integer from member where role = 'owner') as owners,
      (select count(*)::integer from projects where slug = 'default') as projects,
      (select count(*)::integer from project_configuration_sources where kind = 'manual') as configuration_sources,
      (select count(*)::integer from organization_entitlements) as entitlements,
      (select count(*)::integer from instance_bootstrap where completed_at is not null) as completed_setups,
      (select count(*)::integer from "user" where is_instance_operator) as operators,
      (select email from "user" order by created_at limit 1) as operator_email,
      (select name from "user" order by created_at limit 1) as operator_name,
      (select must_change_password from "user" order by created_at limit 1) as must_change_password,
      (select name from organization limit 1) as organization_name,
      exists (
        select 1 from instance_bootstrap
        join member on member.user_id = instance_bootstrap.owner_user_id
          and member.organization_id = instance_bootstrap.organization_id
        where instance_bootstrap.id = 'default'
          and instance_bootstrap.completed_at is not null
          and member.role = 'owner'
      ) as completion_matches_owner
  `);
  const row = result.rows[0]!;
  return {
    users: row.users,
    credentialAccounts: row.credential_accounts,
    organizations: row.organizations,
    owners: row.owners,
    projects: row.projects,
    configurationSources: row.configuration_sources,
    entitlements: row.entitlements,
    completedSetups: row.completed_setups,
    operators: row.operators,
    operatorEmail: row.operator_email,
    operatorName: row.operator_name,
    mustChangePassword: row.must_change_password,
    organizationName: row.organization_name,
    completionMatchesOwner: row.completion_matches_owner,
  };
}
