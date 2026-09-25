import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { ConnectionAccessDeniedError, ForgejoAccountAlreadyConnectedError } from "./errors.js";
import { createDatabase, createPostgresQueryRuntime } from "./test-utils/runtime.js";
import type { BindForgejoConnectionInput } from "./types.js";

// the pre-check in connection.ts can't catch two requests racing past it, this pins
// the real backstop: the unique index on (organization, instance, account) against real
// postgres, where the constraint violation actually exists
describe("Forgejo connection bind race on Postgres", () => {
  let postgres: StartedPostgreSqlContainer;
  let databaseUrl: string;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    databaseUrl = postgres.getConnectionUri();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  }, 120_000);

  it("translates a unique violation on the second bind into account_already_connected", async () => {
    const database = await createDatabase(databaseUrl);
    const access = await seedAuthority(databaseUrl, "70");

    const input: BindForgejoConnectionInput = {
      access,
      instanceBaseUrl: "https://git.example.test",
      instanceHost: "git.example.test",
      webhookSecret: "hook-secret",
      accessToken: "forgejo-access-token",
      accountLogin: "trillian",
      accountId: 42,
      instanceFlavor: "forgejo",
      instanceVersion: "16.0.5+gitea-1.22.0",
    };

    const first = await database.bindForgejoConnection(input);

    await assert.rejects(
      () => database.bindForgejoConnection({ ...input, webhookSecret: "hook-secret-2" }),
      (error: unknown) => {
        assert.ok(error instanceof ForgejoAccountAlreadyConnectedError);
        assert.equal(error.connectionId, first.id);
        assert.equal(error.connectionSlug, first.slug);
        return true;
      },
    );

    await database.close();
  }, 120_000);

  it("allows the same account bound on a different instance", async () => {
    const database = await createDatabase(databaseUrl);
    const access = await seedAuthority(databaseUrl, "71");

    const first = await database.bindForgejoConnection({
      access,
      instanceBaseUrl: "https://git.example.test",
      instanceHost: "git.example.test",
      webhookSecret: "hook-secret",
      accessToken: "forgejo-access-token",
      accountLogin: "trillian",
      accountId: 42,
      instanceFlavor: "forgejo",
      instanceVersion: "16.0.5+gitea-1.22.0",
    });
    const second = await database.bindForgejoConnection({
      access,
      instanceBaseUrl: "https://other.example.test",
      instanceHost: "other.example.test",
      webhookSecret: "hook-secret",
      accessToken: "forgejo-access-token",
      accountLogin: "trillian",
      accountId: 42,
      instanceFlavor: "forgejo",
      instanceVersion: "16.0.5+gitea-1.22.0",
    });

    assert.notEqual(first.id, second.id);

    await database.close();
  }, 120_000);

  it("lists sibling account ids on the same instance, and only those", async () => {
    const database = await createDatabase(databaseUrl);
    const access = await seedAuthority(databaseUrl, "75");

    const first = await database.bindForgejoConnection({
      access,
      instanceBaseUrl: "https://git.example.test",
      instanceHost: "git.example.test",
      webhookSecret: "hook-secret",
      accessToken: "forgejo-access-token",
      accountLogin: "trillian",
      accountId: 201,
      instanceFlavor: "forgejo",
      instanceVersion: "16.0.5+gitea-1.22.0",
    });
    const second = await database.bindForgejoConnection({
      access,
      instanceBaseUrl: "https://git.example.test",
      instanceHost: "git.example.test",
      webhookSecret: "hook-secret-2",
      accessToken: "forgejo-access-token-2",
      accountLogin: "zaphod",
      accountId: 202,
      instanceFlavor: "forgejo",
      instanceVersion: "16.0.5+gitea-1.22.0",
    });
    // a different instance is never a sibling, even in the same org
    await database.bindForgejoConnection({
      access,
      instanceBaseUrl: "https://other.example.test",
      instanceHost: "other.example.test",
      webhookSecret: "hook-secret-3",
      accessToken: "forgejo-access-token-3",
      accountLogin: "trillian",
      accountId: 203,
      instanceFlavor: "forgejo",
      instanceVersion: "16.0.5+gitea-1.22.0",
    });

    const siblingsOfFirst = await database.listForgejoSiblingAccountIds({
      organizationId: access.organizationId,
      instanceBaseUrl: "https://git.example.test",
      excludeConnectionId: first.id,
    });
    assert.deepEqual(siblingsOfFirst, [202]);

    const siblingsOfSecond = await database.listForgejoSiblingAccountIds({
      organizationId: access.organizationId,
      instanceBaseUrl: "https://git.example.test",
      excludeConnectionId: second.id,
    });
    assert.deepEqual(siblingsOfSecond, [201]);

    await database.close();
  }, 120_000);

  // uniqueConnectionSlug reads a snapshot before either insert commits, so two distinct
  // owners binding the same instance host can compute the same candidate slug. this
  // doesn't force the race every run, only lets it happen; a winner-then-retry isn't
  // observable from the caller's side either way.
  it("still lets two owners connect the same instance host at once", async () => {
    const organizationId = "forgejo-bind-org-race";
    const [accessA, accessB] = await seedTwoOwners(databaseUrl, organizationId, "race-a", "race-b");
    const databaseA = await createDatabase(databaseUrl);
    const databaseB = await createDatabase(databaseUrl);

    const [first, second] = await Promise.all([
      databaseA.bindForgejoConnection({
        access: accessA,
        instanceBaseUrl: "https://git.example.test",
        instanceHost: "git.example.test",
        webhookSecret: "hook-secret-a",
        accessToken: "forgejo-access-token-a",
        accountLogin: "trillian",
        accountId: 101,
        instanceFlavor: "forgejo",
        instanceVersion: "16.0.5+gitea-1.22.0",
      }),
      databaseB.bindForgejoConnection({
        access: accessB,
        instanceBaseUrl: "https://git.example.test",
        instanceHost: "git.example.test",
        webhookSecret: "hook-secret-b",
        accessToken: "forgejo-access-token-b",
        accountLogin: "zaphod",
        accountId: 102,
        instanceFlavor: "forgejo",
        instanceVersion: "16.0.5+gitea-1.22.0",
      }),
    ]);

    assert.notEqual(first.id, second.id);
    assert.notEqual(first.slug, second.slug);

    await databaseA.close();
    await databaseB.close();
  }, 120_000);

  // replaceForgejoToken scopes its update to (connectionId, organizationId), same as disconnectConnection
  it("replaces the token when the organization actually owns the connection", async () => {
    const database = await createDatabase(databaseUrl);
    const access = await seedAuthority(databaseUrl, "80");
    const connection = await database.bindForgejoConnection({
      access,
      instanceBaseUrl: "https://git.example.test",
      instanceHost: "git.example.test",
      webhookSecret: "hook-secret",
      accessToken: "forgejo-access-token",
      accountLogin: "trillian",
      accountId: 42,
      instanceFlavor: "forgejo",
      instanceVersion: "16.0.5+gitea-1.22.0",
    });

    await database.replaceForgejoConnectionToken({
      connectionId: connection.id,
      organizationId: access.organizationId,
      accessToken: "forgejo-access-token-2",
      instanceFlavor: "forgejo",
      instanceVersion: "16.0.5+gitea-1.22.0",
    });

    const reloaded = await database.findForgejoConnection(connection.id);
    assert.equal(reloaded?.accessToken, "forgejo-access-token-2");

    await database.close();
  }, 120_000);

  it("refuses to replace a token for a connection a different organization owns", async () => {
    const database = await createDatabase(databaseUrl);
    const access = await seedAuthority(databaseUrl, "81");
    const otherAccess = await seedAuthority(databaseUrl, "82");
    const connection = await database.bindForgejoConnection({
      access,
      instanceBaseUrl: "https://git.example.test",
      instanceHost: "git.example.test",
      webhookSecret: "hook-secret",
      accessToken: "forgejo-access-token",
      accountLogin: "trillian",
      accountId: 42,
      instanceFlavor: "forgejo",
      instanceVersion: "16.0.5+gitea-1.22.0",
    });

    await assert.rejects(
      () =>
        database.replaceForgejoConnectionToken({
          connectionId: connection.id,
          organizationId: otherAccess.organizationId,
          accessToken: "forgejo-access-token-stolen",
          instanceFlavor: "forgejo",
          instanceVersion: "16.0.5+gitea-1.22.0",
        }),
      (error: unknown) => error instanceof ConnectionAccessDeniedError,
    );

    const reloaded = await database.findForgejoConnection(connection.id);
    assert.equal(reloaded?.accessToken, "forgejo-access-token");

    await database.close();
  }, 120_000);

  async function seedAuthority(connectionUrl: string, prefix: string) {
    const organizationId = `forgejo-bind-org-${prefix}`;
    const client = await createPostgresQueryRuntime(connectionUrl);
    await client.query(`insert into organization (id, name, slug) values ($1, 'Bind Org', $1)`, [
      organizationId,
    ]);
    await client.close();
    return seedOwner(connectionUrl, organizationId, prefix);
  }

  async function seedTwoOwners(
    connectionUrl: string,
    organizationId: string,
    prefixA: string,
    prefixB: string,
  ) {
    const client = await createPostgresQueryRuntime(connectionUrl);
    await client.query(`insert into organization (id, name, slug) values ($1, 'Bind Org', $1)`, [
      organizationId,
    ]);
    await client.close();
    return Promise.all([
      seedOwner(connectionUrl, organizationId, prefixA),
      seedOwner(connectionUrl, organizationId, prefixB),
    ]);
  }

  async function seedOwner(connectionUrl: string, organizationId: string, prefix: string) {
    const client = await createPostgresQueryRuntime(connectionUrl);
    await client.query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at,
                           must_change_password, is_instance_operator)
       values ($1, 'Operator', $2, true, now(), now(), false, true)`,
      [`operator-${prefix}`, `operator-${prefix}@example.test`],
    );
    await client.query(
      `insert into session (id, token, user_id, active_organization_id, expires_at)
       values ($1, $2, $3, $4, now() + interval '1 hour')`,
      [`session-${prefix}`, `token-${prefix}`, `operator-${prefix}`, organizationId],
    );
    await client.query(
      `insert into member (id, organization_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [`member-${prefix}`, organizationId, `operator-${prefix}`],
    );
    await client.close();
    return {
      sessionId: `session-${prefix}`,
      userId: `operator-${prefix}`,
      membershipId: `member-${prefix}`,
      organizationId,
      returnRoute: "/settings/apps",
    };
  }
});
