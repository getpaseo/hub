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
    for (const [projectId, contentHash] of [
      ["10000000-0000-4000-8000-000000000001", "manual-org-a-config"],
      ["20000000-0000-4000-8000-000000000001", "manual-org-b-config"],
    ] as const) {
      const revision = await database.insertProjectConfigurationRevision({
        projectId,
        sourceKind: "manual",
        sourceEvidence: { kind: "test" },
        normalizedConfiguration: { environments: [], triggers: [] },
        contentHash,
      });
      await database.activateProjectConfigurationRevision(projectId, revision.id);
    }

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
    assert.equal(duplicate.status, "accepted");
    if (duplicate.status !== "accepted") throw new Error("expected replayed accepted trigger");
    assert.equal(duplicate.event.providerEventReceiptId, first.event.providerEventReceiptId);
    assert.equal(duplicate.event.organizationId, "manual-org-a");
    assert.equal(duplicate.event.projectId, "10000000-0000-4000-8000-000000000001");
    await database.close();
  }, 120_000);

  it("persists bounded safe routing evidence with PostgreSQL organization isolation", async () => {
    const database = await createDatabase(databaseUrl);
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`
      insert into organization (id, name, slug) values
        ('routing-org-a', 'Routing A', 'routing-a'),
        ('routing-org-b', 'Routing B', 'routing-b');
      insert into "user" (id, name, email, email_verified)
      values ('routing-user', 'Routing User', 'routing-user@example.test', true);
      insert into member (id, organization_id, user_id, role) values
        ('routing-member-a', 'routing-org-a', 'routing-user', 'owner'),
        ('routing-member-b', 'routing-org-b', 'routing-user', 'owner');
    `);
    await client.end();

    try {
      const firstProject = await database.createProject({
        organizationId: "routing-org-a",
        name: "First",
        slug: "first",
        createdByUserId: "routing-user",
      });
      const firstRevision = await database.insertProjectConfigurationRevision({
        projectId: firstProject.id,
        sourceKind: "manual",
        sourceEvidence: { kind: "test" },
        normalizedConfiguration: { environments: [], triggers: [] },
        contentHash: "routing-evidence-a",
      });
      await database.activateProjectConfigurationRevision(firstProject.id, firstRevision.id);
      const firstReceipt = await database.persistManualEvent({
        organizationId: "routing-org-a",
        projectId: firstProject.id,
        deliveryId: "routing-a",
        source: "manual.run",
        payload: { body: "PRIVATE-EVENT-BODY" },
        receivedAt: new Date("2026-08-09T12:00:00.000Z"),
      });
      assert.equal(firstReceipt.status, "accepted");
      if (firstReceipt.status !== "accepted") throw new Error("expected accepted receipt");

      for (const batch of [0, 1, 2]) {
        await database.recordProviderEventRoutingDecisions({
          organizationId: "routing-org-a",
          providerEventReceiptId: firstReceipt.event.providerEventReceiptId,
          projectId: firstProject.id,
          configurationRevisionId: firstRevision.id,
          decisions: Array.from({ length: 25 }, (_, index) => ({
            triggerName: `candidate-${batch}-${index}-${"x".repeat(200)}`,
            code: "contains_mismatch" as const,
          })),
        });
      }

      const secondProject = await database.createProject({
        organizationId: "routing-org-b",
        name: "Second",
        slug: "second",
        createdByUserId: "routing-user",
      });
      const secondRevision = await database.insertProjectConfigurationRevision({
        projectId: secondProject.id,
        sourceKind: "manual",
        sourceEvidence: { kind: "test" },
        normalizedConfiguration: { environments: [], triggers: [] },
        contentHash: "routing-evidence-b",
      });
      await database.activateProjectConfigurationRevision(secondProject.id, secondRevision.id);
      const secondReceipt = await database.persistManualEvent({
        organizationId: "routing-org-b",
        projectId: secondProject.id,
        deliveryId: "routing-b",
        source: "manual.run",
        payload: { body: "PRIVATE-OTHER-BODY" },
        receivedAt: new Date("2026-08-09T12:01:00.000Z"),
      });
      assert.equal(secondReceipt.status, "accepted");
      if (secondReceipt.status !== "accepted") throw new Error("expected accepted receipt");
      await database.recordProviderEventRoutingDecisions({
        organizationId: "routing-org-b",
        providerEventReceiptId: secondReceipt.event.providerEventReceiptId,
        projectId: secondProject.id,
        configurationRevisionId: secondRevision.id,
        decisions: [{ triggerName: "other-org-trigger", code: "sender_not_allowed" }],
      });

      const firstEvents = await database.listUnroutedProviderEventsForOrganization("routing-org-a");
      const secondEvents =
        await database.listUnroutedProviderEventsForOrganization("routing-org-b");
      assert.equal(firstEvents.length, 1);
      assert.equal(secondEvents.length, 1);
      assert.equal(firstEvents[0]?.routingDecisions.length, 50);
      assert.equal(secondEvents[0]?.routingDecisions[0]?.triggerName, "other-org-trigger");
      assert.equal(
        firstEvents[0]?.routingDecisions.every((decision) => decision.triggerName!.length <= 128),
        true,
      );
      assert.equal(
        firstEvents[0]?.routingDecisions.every(
          (decision) =>
            decision.summary === "The event does not contain the configured trigger marker.",
        ),
        true,
      );
      assert.doesNotMatch(JSON.stringify(firstEvents), /PRIVATE-EVENT-BODY/gu);
      assert.doesNotMatch(JSON.stringify(secondEvents), /PRIVATE-OTHER-BODY/gu);
    } finally {
      await database.close();
    }
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
