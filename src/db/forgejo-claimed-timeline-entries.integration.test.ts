import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase, createPostgresQueryRuntime } from "./test-utils/runtime.js";
import type { Database } from "./types.js";

const ORGANIZATION_ID = "forgejo-claim-org";
const CONNECTION_ID = "90000000-0000-4000-8000-000000000011";

describe("Forgejo claimed timeline entries on Postgres", () => {
  let postgres: StartedPostgreSqlContainer;
  let database: Database;

  const RECEIPT_ID = "90000000-0000-4000-8000-000000000501";

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    const databaseUrl = postgres.getConnectionUri();
    database = await createDatabase(databaseUrl);
    const client = await createPostgresQueryRuntime(databaseUrl);
    await client.query(`
      insert into organization (id, name, slug)
      values ('${ORGANIZATION_ID}', 'Forgejo Claim', '${ORGANIZATION_ID}');
      insert into forgejo_connections
        (id, organization_id, slug, instance_base_url, instance_host, webhook_secret,
         access_token, account_login, account_id, instance_flavor, instance_version)
      values
        ('${CONNECTION_ID}', '${ORGANIZATION_ID}', 'forge', 'https://git.example.test',
         'git.example.test', 'claim-secret', 'forgejo-access-token', 'trillian', 42,
         'forgejo', '16.0.5+gitea-1.22.0');
      insert into provider_event_receipts
        (id, organization_id, provider, connection_id, delivery_id, source, payload)
      values
        ('${RECEIPT_ID}', '${ORGANIZATION_ID}', 'forgejo', '${CONNECTION_ID}',
         'delivery-dedupe', 'forgejo.issue_labeled', '{}');
    `);
    await client.close();
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await postgres.stop();
  }, 120_000);

  it("claims a duplicated timeline entry id without erroring, once", async () => {
    const won = await database.claimForgejoTimelineEntries(
      CONNECTION_ID,
      [501, 501, 502],
      RECEIPT_ID,
    );

    assert.deepEqual(
      [...won].sort((a, b) => a - b),
      [501, 502],
    );
  }, 120_000);
});
