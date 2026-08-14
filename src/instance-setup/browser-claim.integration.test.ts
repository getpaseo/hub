import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { z } from "zod";
import {
  createDatabase,
  createPostgresPool,
  testDatabaseLocks,
  testDatabaseRuntime,
} from "../db/test-utils/runtime.js";
import type { Database } from "../db/types.js";
import { composeEntitlements, type ComposedEntitlements } from "../auth/entitlements.js";
import { createAuthServer, type AuthServer } from "../auth/server.js";
import type { InstanceAuthPolicy } from "../auth/instance-policy.js";
import { UNLIMITED_PROVISIONING } from "../organizations/provisioning.js";
import { InstanceSetup, type InitialOperator } from "./index.js";

const ORIGIN = "http://localhost:3000";

const operator: InitialOperator = {
  name: "Browser Operator",
  email: "browser.operator@example.test",
  password: "browser-operator-password",
  organizationName: "Browser Organization",
};

const accountStateSchema = z
  .object({
    status: z.string(),
    account: z.object({ email: z.string() }).optional(),
    organization: z.object({ name: z.string() }).optional(),
    isInstanceOperator: z.boolean().optional(),
    registration: z.string().optional(),
  })
  .passthrough();

describe("first-run claim at the browser boundary", () => {
  let postgres: StartedPostgreSqlContainer;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  }, 120_000);

  it("turns a pristine instance into a signed-in operator", async () => {
    const instance = await startInstance(postgres, "browser_claim");
    try {
      assert.equal((await readAccountState(instance.auth)).status, "instanceSetupRequired");

      const claim = await instance.auth.claimInstance!(operator, browserHeaders());
      assert.deepEqual(claim, { status: "claimed" });

      // The claim itself established the browser session — nothing signed in afterwards.
      assert.deepEqual(await sessionsPerOperator(instance), [
        { email: operator.email, sessions: 1 },
      ]);

      // The claimed instance shows ordinary sign-in to anyone without a session.
      const signedOut = await readAccountState(instance.auth);
      assert.equal(signedOut.status, "signedOut");
      assert.equal(signedOut.registration, "invite_only");

      // The chosen password is final: signing in with it lands on the dashboard rather than the
      // temporary-password gate that environment bootstrap requires.
      const cookie = await signIn(instance.auth, operator.email, operator.password);
      const active = await readAccountState(instance.auth, cookie);
      assert.equal(active.status, "active");
      assert.equal(active.account?.email, operator.email);
      assert.equal(active.organization?.name, operator.organizationName);
      assert.equal(active.isInstanceOperator, true);
    } finally {
      await instance.close();
    }
  }, 120_000);

  /**
   * Registration policy is unchanged, but every account it admits is now created under the
   * instance's account-admission lock, so a signup cannot land inside a claim's decision window.
   */
  it("creates generic signup accounts under the instance account-admission lock", async () => {
    const instance = await startInstance(postgres, "browser_claim_signup_lock", "open");
    try {
      let admitted = () => {};
      const holding = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = instanceSetupFor(instance).admitAccountCreation(async () => {
        admitted();
        await released;
      });
      await holding;

      let signedUp = false;
      const signup = (async () => {
        await instance.auth.signUpEmail!(
          { name: "Waiting", email: "waiting@example.test", password: "waiting-password" },
          browserHeaders(),
        );
        signedUp = true;
      })();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(signedUp, false);
      assert.equal(await countUsers(instance), 0);

      release();
      await held;
      await signup;
      assert.equal(signedUp, true);
      assert.equal(await countUsers(instance), 1);
    } finally {
      await instance.close();
    }
  }, 120_000);

  /**
   * The two paths racing for real. Whichever wins, the instance never ends up with a completed
   * claim that was decided against a database someone else had already written an account into.
   */
  it("keeps a concurrent claim and signup consistent", async () => {
    const instance = await startInstance(postgres, "browser_claim_signup_race", "open");
    try {
      const [claim] = await Promise.all([
        instance.auth.claimInstance!(operator, browserHeaders()),
        instance.auth.signUpEmail!(
          { name: "Racing", email: "racing@example.test", password: "racing-password" },
          browserHeaders(),
        ),
      ]);

      const claimed = claim.status === "claimed";
      assert.deepEqual(await claimOutcome(instance), {
        operators: claimed ? 1 : 0,
        completions: claimed ? 1 : 0,
        // The claim only ever provisions on a database it found empty, so a completed claim means
        // the signup landed after it: two accounts. A refused claim leaves only the signup's.
        users: claimed ? 2 : 1,
        completionOwnedByOperator: claimed,
      });
    } finally {
      await instance.close();
    }
  }, 120_000);

  it("refuses a claim that does not come from the browser origin", async () => {
    const instance = await startInstance(postgres, "browser_claim_origin");
    try {
      await assert.rejects(
        instance.auth.claimInstance!(operator, new Headers({ origin: "https://attacker.test" })),
        /invalid origin/u,
      );
      await assert.rejects(
        instance.auth.claimInstance!(operator, new Headers()),
        /invalid origin/u,
      );

      assert.equal(await countUsers(instance), 0);
      assert.equal((await readAccountState(instance.auth)).status, "instanceSetupRequired");
    } finally {
      await instance.close();
    }
  }, 120_000);

  it("keeps ordinary registration from claiming the instance", async () => {
    const instance = await startInstance(postgres, "browser_claim_signup", "open");
    try {
      await instance.auth.signUpEmail!(
        { name: "Ordinary", email: "ordinary@example.test", password: "ordinary-password" },
        browserHeaders(),
      );

      const operators = await instance.database.query<{ count: number }>(
        `select count(*)::integer as count from "user" where is_instance_operator`,
      );
      assert.equal(operators.rows[0]?.count, 0);
      // The account exists, so the instance is no longer provably unowned: setup closes and the
      // welcome journey gives way to sign-in without anyone having claimed operator authority.
      assert.equal((await readAccountState(instance.auth)).status, "signedOut");
      assert.deepEqual(await instance.auth.claimInstance!(operator, browserHeaders()), {
        status: "unavailable",
      });
    } finally {
      await instance.close();
    }
  }, 120_000);
});

interface RunningInstance {
  auth: AuthServer;
  database: ReturnType<typeof testDatabaseRuntime>;
  locks: ReturnType<typeof testDatabaseLocks>;
  close(): Promise<void>;
}

/** The same authority the auth server composed, reached through the same database and locks. */
function instanceSetupFor(instance: RunningInstance): InstanceSetup {
  return new InstanceSetup({
    database: instance.database,
    locks: instance.locks,
    policy: { registrationMode: "open", organizationCreation: "disabled", bootstrap: undefined },
    provisioningEntitlements: () => Promise.resolve(UNLIMITED_PROVISIONING),
  });
}

async function startInstance(
  postgres: StartedPostgreSqlContainer,
  name: string,
  registrationMode: InstanceAuthPolicy["registrationMode"] = "invite_only",
): Promise<RunningInstance> {
  const url = await isolatedDatabaseUrl(postgres.getConnectionUri(), name);
  const database: Database = await createDatabase(url);
  const entitlements: ComposedEntitlements = composeEntitlements(
    database,
    testDatabaseRuntime(database),
  );
  const auth = createAuthServer({
    database: testDatabaseRuntime(database),
    locks: testDatabaseLocks(database),
    entitlements: entitlements.service,
    secret: "first-run-claim-secret-at-least-32-characters",
    baseURL: ORIGIN,
    policy: { registrationMode, organizationCreation: "disabled", bootstrap: undefined },
  });
  return {
    auth,
    database: testDatabaseRuntime(database),
    locks: testDatabaseLocks(database),
    async close() {
      await auth.close();
      await entitlements.close();
      await database.close();
    },
  };
}

function browserHeaders(): Headers {
  return new Headers({ origin: ORIGIN });
}

async function readAccountState(auth: AuthServer, cookie?: string) {
  const response = await auth.browserAccount!(
    new Request(
      `${ORIGIN}/api/auth/paseo/state`,
      cookie === undefined ? {} : { headers: { cookie } },
    ),
  );
  assert.equal(response.status, 200);
  return accountStateSchema.parse(await response.json());
}

/** One row per instance operator with the number of sessions Better Auth has issued to it. */
async function sessionsPerOperator(instance: RunningInstance) {
  const result = await instance.database.query<{ email: string; sessions: number }>(
    `select "user".email,
            (select count(*)::integer from session where session.user_id = "user".id) as sessions
     from "user"
     where "user".is_instance_operator
     order by "user".email`,
  );
  return result.rows;
}

async function claimOutcome(instance: RunningInstance) {
  const result = await instance.database.query<{
    operators: number;
    completions: number;
    users: number;
    completion_owned_by_operator: boolean;
  }>(`
    select
      (select count(*)::integer from "user" where is_instance_operator) as operators,
      (select count(*)::integer from instance_bootstrap where completed_at is not null) as completions,
      (select count(*)::integer from "user") as users,
      exists (
        select 1 from instance_bootstrap
        join "user" on "user".id = instance_bootstrap.owner_user_id
        where instance_bootstrap.completed_at is not null and "user".is_instance_operator
      ) as completion_owned_by_operator
  `);
  const row = result.rows[0]!;
  return {
    operators: row.operators,
    completions: row.completions,
    users: row.users,
    completionOwnedByOperator: row.completion_owned_by_operator,
  };
}

async function countUsers(instance: RunningInstance): Promise<number> {
  const result = await instance.database.query<{ count: number }>(
    `select count(*)::integer as count from "user"`,
  );
  return result.rows[0]?.count ?? -1;
}

async function signIn(auth: AuthServer, email: string, password: string): Promise<string> {
  const response = await auth.handle(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  assert.equal(response.status, 200);
  const cookie = response.headers
    .get("set-cookie")
    ?.match(/^(?:[^;]+);/u)?.[0]
    ?.slice(0, -1);
  if (cookie === undefined) throw new Error("sign-in did not issue a session cookie");
  return cookie;
}

async function isolatedDatabaseUrl(baseUrl: string, name: string): Promise<string> {
  const base = new URL(baseUrl);
  base.pathname = "/postgres";
  const admin = await createPostgresPool(base.toString());
  const databaseName = `${name}_${Date.now()}`;
  await admin.query(`create database "${databaseName}"`);
  await admin.close();
  base.pathname = `/${databaseName}`;
  return base.toString();
}
