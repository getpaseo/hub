import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { createDatabase } from "../db/pg.js";
import type { Database } from "../db/types.js";
import { EntitlementDenied, UNLIMITED_TEMPLATE } from "./catalog.js";
import { EntitlementsService } from "./service.js";

describe("EntitlementsService.consume against PostgreSQL", () => {
  let postgres: StartedPostgreSqlContainer;
  let database: Database;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = await createDatabase(postgres.getConnectionUri());
  }, 120_000);

  afterAll(async () => {
    await database.close();
    await postgres.stop();
  }, 120_000);

  async function seedOrganization(): Promise<string> {
    const organizationId = `org-${randomUUID()}`;
    const client = new Client({ connectionString: postgres.getConnectionUri() });
    await client.connect();
    try {
      await client.query(`insert into organization (id, name, slug) values ($1, $2, $3)`, [
        organizationId,
        organizationId,
        organizationId,
      ]);
    } finally {
      await client.end();
    }
    return organizationId;
  }

  it("lets exactly the limit succeed under concurrent racing consumers, never over", async () => {
    const organizationId = await seedOrganization();
    const service = new EntitlementsService(database, { seats: async () => 0 });
    await service.stamp(
      organizationId,
      {
        seats: { max: null },
        canInviteMembers: true,
        meters: { "executions.monthly": { limit: 5 } },
      },
      { source: "provisioning", planId: null },
    );

    const CONCURRENT_CALLERS = 20;
    const LIMIT = 5;
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT_CALLERS }, () =>
        service.consume(organizationId, "executions.monthly", 1),
      ),
    );

    const succeeded = results.filter((result) => result.status === "fulfilled");
    const denied = results.filter(
      (result) => result.status === "rejected" && result.reason instanceof EntitlementDenied,
    );
    assert.equal(succeeded.length, LIMIT);
    assert.equal(denied.length, CONCURRENT_CALLERS - LIMIT);

    const usage = await service.usage(organizationId, "executions.monthly");
    assert.deepEqual(usage, { meter: "executions.monthly", used: LIMIT, limit: LIMIT });
  });

  it("lets every concurrent caller through when the meter is unlimited", async () => {
    const organizationId = await seedOrganization();
    const service = new EntitlementsService(database, { seats: async () => 0 });
    await service.stamp(organizationId, UNLIMITED_TEMPLATE, {
      source: "provisioning",
      planId: null,
    });

    const CONCURRENT_CALLERS = 20;
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENT_CALLERS }, () =>
        service.consume(organizationId, "executions.monthly", 1),
      ),
    );

    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      CONCURRENT_CALLERS,
    );
    const usage = await service.usage(organizationId, "executions.monthly");
    assert.deepEqual(usage, {
      meter: "executions.monthly",
      used: CONCURRENT_CALLERS,
      limit: null,
    });
  });
});
