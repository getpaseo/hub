import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase, createPostgresQueryRuntime } from "./test-utils/runtime.js";
import type { Database } from "./types.js";

describe("Forgejo hook lease on Postgres", () => {
  let postgres: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let database: Database;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    databaseUrl = postgres.getConnectionUri();
    database = await createDatabase(databaseUrl);
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await postgres.stop();
  }, 120_000);

  it("lets exactly one of two pools claim a free lease", async () => {
    const other = await createDatabase(databaseUrl);
    const connectionId = await seedConnection("91");

    const claims = await Promise.all([
      database.claimForgejoHookLease(connectionId, org("91")),
      other.claimForgejoHookLease(connectionId, org("91")),
    ]);

    assert.equal(claims.filter((claim) => claim !== undefined).length, 1);
    await other.close();
  }, 120_000);

  it("frees the lease on release, so the next claim wins", async () => {
    const connectionId = await seedConnection("92");

    const first = await database.claimForgejoHookLease(connectionId, org("92"));
    assert.ok(first);
    await database.releaseForgejoHookLease(connectionId, first);

    assert.ok(await database.claimForgejoHookLease(connectionId, org("92")));
  }, 120_000);

  it("never hands another organization the lease", async () => {
    const connectionId = await seedConnection("93");

    assert.equal(await database.claimForgejoHookLease(connectionId, org("other")), undefined);
  }, 120_000);

  it("lets an expired lease be claimed again, and ignores the stale holder's release", async () => {
    const connectionId = await seedConnection("94");
    const stale = await database.claimForgejoHookLease(connectionId, org("94"));
    assert.ok(stale);
    await expireLease(connectionId);

    const fresh = await database.claimForgejoHookLease(connectionId, org("94"));
    assert.ok(fresh);
    await database.releaseForgejoHookLease(connectionId, stale);

    assert.equal(await database.claimForgejoHookLease(connectionId, org("94")), undefined);
  }, 120_000);

  function org(prefix: string): string {
    return `forgejo-lease-org-${prefix}`;
  }

  async function expireLease(connectionId: string): Promise<void> {
    const client = await createPostgresQueryRuntime(databaseUrl);
    await client.query(
      `update forgejo_connections set hook_lease_expires_at = now() - interval '1 second'
        where id = $1`,
      [connectionId],
    );
    await client.close();
  }

  async function seedConnection(prefix: string): Promise<string> {
    const connectionId = `${prefix}000000-0000-4000-8000-000000000011`;
    const client = await createPostgresQueryRuntime(databaseUrl);
    await client.query(`
      insert into organization (id, name, slug)
      values ('${org(prefix)}', 'Forgejo Lease', '${org(prefix)}');
      insert into forgejo_connections
        (id, organization_id, slug, instance_base_url, instance_host, webhook_secret,
         access_token, account_login, account_id, instance_flavor, instance_version)
      values
        ('${connectionId}', '${org(prefix)}', 'forge', 'https://git.example.test',
         'git.example.test', 'hook-secret', 'forgejo-access-token', 'trillian', 42,
         'forgejo', '16.0.5+gitea-1.22.0');
    `);
    await client.close();
    return connectionId;
  }
});
