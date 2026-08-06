import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { createDatabase } from "./pg.js";

describe("manual trigger tenant idempotency", () => {
  let postgres: StartedPostgreSqlContainer;
  let databaseUrl: string;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    databaseUrl = postgres.getConnectionUri();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  }, 120_000);

  it("does not resolve another organization when delivery keys collide", async () => {
    const database = await createDatabase(databaseUrl);
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`
      insert into organization (id, name, slug) values
        ('manual-org-a', 'Manual A', 'manual-a'),
        ('manual-org-b', 'Manual B', 'manual-b');
      insert into projects (id, organization_id, name, slug)
      values
        ('10000000-0000-4000-8000-000000000001', 'manual-org-a', 'Default', 'same-project'),
        ('20000000-0000-4000-8000-000000000001', 'manual-org-b', 'Default', 'same-project');
    `);
    await client.end();

    const first = await database.persistManualEvent(
      input("manual-org-a", "10000000-0000-4000-8000-000000000001"),
    );
    const second = await database.persistManualEvent(
      input("manual-org-b", "20000000-0000-4000-8000-000000000001"),
    );
    assert.equal(first.status, "accepted");
    assert.equal(second.status, "accepted");
    if (first.status !== "accepted" || second.status !== "accepted")
      throw new Error("expected accepted triggers");
    assert.notEqual(first.event.providerEventReceiptId, second.event.providerEventReceiptId);

    const duplicate = await database.persistManualEvent(
      input("manual-org-a", "10000000-0000-4000-8000-000000000001"),
    );
    assert.deepEqual(duplicate, {
      status: "duplicate",
      providerEventReceiptId: first.event.providerEventReceiptId,
    });
    await database.close();
  }, 120_000);
});

function input(organizationId: string, projectId: string) {
  return {
    organizationId,
    projectId,
    source: "manual.run",
    deliveryId: "same-delivery-key",
    receivedAt: new Date(),
    payload: { authenticatedBy: { kind: "api-key", keyId: `key-${organizationId}` } },
  } as const;
}
