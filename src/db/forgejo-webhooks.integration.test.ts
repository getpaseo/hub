import assert from "node:assert/strict";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createDatabase, createPostgresQueryRuntime } from "./test-utils/runtime.js";
import type { Database } from "./types.js";

const CONNECTION_ID = "70000000-0000-4000-8000-000000000001";
const OTHER_CONNECTION_ID = "70000000-0000-4000-8000-000000000002";

describe("forgejo_webhooks PostgreSQL repository", () => {
  let postgres: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);
    await client.query(`
      insert into organization (id, name, slug)
      values ('forgejo-webhooks-org', 'Forgejo Webhooks', 'forgejo-webhooks');
      insert into forgejo_connections
        (id, organization_id, slug, instance_base_url, instance_host, webhook_secret,
         access_token, account_login, account_id, instance_flavor, instance_version)
      values
        ('${CONNECTION_ID}', 'forgejo-webhooks-org', 'acme-forgejo',
         'https://git.example.test', 'git.example.test', 'shh',
         'forgejo-access-token', 'acme-bot', 1, 'forgejo', '16.0.5+gitea-1.22.0'),
        ('${OTHER_CONNECTION_ID}', 'forgejo-webhooks-org', 'other-forgejo',
         'https://other.example.test', 'other.example.test', 'shh',
         'forgejo-access-token', 'other-bot', 2, 'forgejo', '16.0.5+gitea-1.22.0');
    `);
    await client.close();
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await postgres.stop();
  }, 120_000);

  it("is empty before anything is recorded", async () => {
    assert.deepEqual(await database.listForgejoWebhooks(CONNECTION_ID), []);
  });

  it("records a hook and lists it back", async () => {
    const record = await database.recordForgejoWebhook({
      connectionId: CONNECTION_ID,
      scope: "user",
      owner: "acme-bot",
      hookId: 11,
    });

    assert.equal(record.scope, "user");
    assert.equal(record.hookId, 11);

    const listed = await database.listForgejoWebhooks(CONNECTION_ID);
    assert.deepEqual(
      listed.map((row) => ({ scope: row.scope, owner: row.owner, hookId: row.hookId })),
      [{ scope: "user", owner: "acme-bot", hookId: 11 }],
    );
  });

  it("upserts on (connection, scope, owner) instead of colliding with the unique index", async () => {
    const first = await database.recordForgejoWebhook({
      connectionId: CONNECTION_ID,
      scope: "org",
      owner: "acme",
      hookId: 20,
    });

    // The hook was deleted by hand on the instance and subscribe created a new one.
    const second = await database.recordForgejoWebhook({
      connectionId: CONNECTION_ID,
      scope: "org",
      owner: "acme",
      hookId: 21,
    });

    assert.equal(second.id, first.id);
    assert.equal(second.hookId, 21);

    const listed = await database.listForgejoWebhooks(CONNECTION_ID);
    const orgHooks = listed.filter((row) => row.scope === "org" && row.owner === "acme");
    assert.equal(orgHooks.length, 1);
    assert.equal(orgHooks[0]?.hookId, 21);
  });

  it("scopes a listing to its own connection", async () => {
    await database.recordForgejoWebhook({
      connectionId: OTHER_CONNECTION_ID,
      scope: "user",
      owner: "other-bot",
      hookId: 30,
    });

    const listed = await database.listForgejoWebhooks(CONNECTION_ID);
    assert.ok(!listed.some((row) => row.hookId === 30));
  });

  it("is gone once its connection is deleted, cascading like the rest of the row family", async () => {
    const client = await createPostgresQueryRuntime(postgres.getConnectionUri());
    await client.query(`
      insert into forgejo_connections
        (id, organization_id, slug, instance_base_url, instance_host, webhook_secret,
         access_token, account_login, account_id, instance_flavor, instance_version)
      values
        ('70000000-0000-4000-8000-000000000003', 'forgejo-webhooks-org', 'cascade-forgejo',
         'https://cascade.example.test', 'cascade.example.test', 'shh',
         'forgejo-access-token', 'cascade-bot', 3, 'forgejo', '16.0.5+gitea-1.22.0');
    `);
    await database.recordForgejoWebhook({
      connectionId: "70000000-0000-4000-8000-000000000003",
      scope: "user",
      owner: "cascade-bot",
      hookId: 50,
    });
    await client.query(
      `delete from forgejo_connections where id = '70000000-0000-4000-8000-000000000003'`,
    );
    await client.close();

    assert.deepEqual(
      await database.listForgejoWebhooks("70000000-0000-4000-8000-000000000003"),
      [],
    );
  });
});
