import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase, createPostgresQueryRuntime } from "./test-utils/runtime.js";
import type { Database, ProviderEventAcceptance } from "./types.js";

// pins the three promises of the enrichment-pending marker against real postgres: a
// duplicate never replays a pending receipt, completing makes it replayable with the
// enriched payload, and a stale marker is taken over by exactly one caller
describe("Forgejo enrichment marker on Postgres", () => {
  let postgres: StartedPostgreSqlContainer;
  let databaseUrl: string;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    databaseUrl = postgres.getConnectionUri();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  }, 120_000);

  it("gives one of two racing duplicates the marker and answers the other pending", async () => {
    const database = await createDatabase(databaseUrl);
    const evidence = await seedForgejoRoute(database, "60");

    const [a, b] = await Promise.all([
      database.acceptForgejoEvent({ ...evidence, deliveryId: "delivery-a", payload: {} }),
      database.acceptForgejoEvent({ ...evidence, deliveryId: "delivery-b", payload: {} }),
    ]);

    const owner = ownsEnrichment(a) ? a : b;
    const loser = owner === a ? b : a;
    assert.equal(ownsEnrichment(owner), true);
    assert.equal(loser.status, "pending");
    assert.equal(loser.receiptId, owner.receiptId);

    await database.close();
  }, 120_000);

  it("replays the enriched payload once the owner completes, without handing out the marker", async () => {
    const database = await createDatabase(databaseUrl);
    const evidence = await seedForgejoRoute(database, "61");

    const owner = await database.acceptForgejoEvent({
      ...evidence,
      deliveryId: "delivery-owner",
      payload: {},
    });
    assert.equal(ownsEnrichment(owner), true);
    await database.completeForgejoEnrichment(owner.receiptId, { addedLabels: ["bug"] });

    const replay = await database.acceptForgejoEvent({
      ...evidence,
      deliveryId: "delivery-later",
      payload: {},
    });
    assert.equal(replay.status, "accepted");
    if (replay.status !== "accepted") throw new Error("expected an accepted replay");
    assert.equal(replay.ownsEnrichment, undefined);
    assert.deepEqual(replay.events[0]?.payload, { addedLabels: ["bug"] });

    await database.close();
  }, 120_000);

  it("keeps the original payload when the owner completes with nothing found", async () => {
    const database = await createDatabase(databaseUrl);
    const evidence = await seedForgejoRoute(database, "62");

    const owner = await database.acceptForgejoEvent({
      ...evidence,
      deliveryId: "delivery-owner",
      payload: { original: true },
    });
    await database.completeForgejoEnrichment(owner.receiptId);

    const replay = await database.acceptForgejoEvent({
      ...evidence,
      deliveryId: "delivery-later",
      payload: {},
    });
    assert.equal(replay.status, "accepted");
    if (replay.status !== "accepted") throw new Error("expected an accepted replay");
    assert.deepEqual(replay.events[0]?.payload, { original: true });

    await database.close();
  }, 120_000);

  it("never marks a delivery that is not going to enrich", async () => {
    const database = await createDatabase(databaseUrl);
    const evidence = await seedForgejoRoute(database, "63");

    const first = await database.acceptForgejoEvent({
      ...evidence,
      enrichmentPending: false,
      deliveryId: "delivery-first",
      payload: {},
    });
    const replay = await database.acceptForgejoEvent({
      ...evidence,
      enrichmentPending: false,
      deliveryId: "delivery-second",
      payload: {},
    });

    assert.equal(first.status, "accepted");
    assert.equal(ownsEnrichment(first), false);
    assert.equal(replay.status, "accepted");

    await database.close();
  }, 120_000);

  it("lets exactly one of two pools take over a stale marker", async () => {
    // two pools, like two Hub processes racing the same redelivery after the owner died
    const left = await createDatabase(databaseUrl);
    const right = await createDatabase(databaseUrl);
    const evidence = await seedForgejoRoute(left, "64");

    const crashed = await left.acceptForgejoEvent({
      ...evidence,
      deliveryId: "delivery-crashed",
      payload: {},
    });
    assert.equal(ownsEnrichment(crashed), true);
    await backdateMarker(crashed.receiptId, "10 minutes");

    const [a, b] = await Promise.all([
      left.acceptForgejoEvent({ ...evidence, deliveryId: "delivery-left", payload: {} }),
      right.acceptForgejoEvent({ ...evidence, deliveryId: "delivery-right", payload: {} }),
    ]);

    assert.equal([a, b].filter(ownsEnrichment).length, 1);
    assert.equal([a, b].filter((result) => result.status === "pending").length, 1);

    // the takeover refreshed the marker, so a third caller finds it pending again, not stale
    const third = await right.acceptForgejoEvent({
      ...evidence,
      deliveryId: "delivery-third",
      payload: {},
    });
    assert.equal(third.status, "pending");

    await left.close();
    await right.close();
  }, 120_000);

  it("does not take over a marker that is merely slow", async () => {
    const database = await createDatabase(databaseUrl);
    const evidence = await seedForgejoRoute(database, "65");

    const owner = await database.acceptForgejoEvent({
      ...evidence,
      deliveryId: "delivery-owner",
      payload: {},
    });
    await backdateMarker(owner.receiptId, "30 seconds");

    const duplicate = await database.acceptForgejoEvent({
      ...evidence,
      deliveryId: "delivery-duplicate",
      payload: {},
    });
    assert.equal(duplicate.status, "pending");

    await database.close();
  }, 120_000);

  it("reports the marker's age so an aged-but-not-stale duplicate can be told from a fresh one", async () => {
    const database = await createDatabase(databaseUrl);
    const evidence = await seedForgejoRoute(database, "68");

    const owner = await database.acceptForgejoEvent({
      ...evidence,
      deliveryId: "delivery-owner",
      payload: {},
    });
    await backdateMarker(owner.receiptId, "30 seconds");

    const duplicate = await database.acceptForgejoEvent({
      ...evidence,
      deliveryId: "delivery-duplicate",
      payload: {},
    });
    assert.equal(duplicate.status, "pending");
    if (duplicate.status === "pending") {
      // slack either side of 30s for this test's own round trip
      assert.ok(
        duplicate.ageMs >= 29_000 && duplicate.ageMs <= 40_000,
        `unexpected age ${duplicate.ageMs}`,
      );
    }

    await database.close();
  }, 120_000);

  it("treats a marker cleared between the read and the takeover as a normal duplicate", async () => {
    const database = await createDatabase(databaseUrl);
    const evidence = await seedForgejoRoute(database, "69");

    const owner = await database.acceptForgejoEvent({
      ...evidence,
      deliveryId: "delivery-owner",
      payload: {},
    });
    assert.equal(ownsEnrichment(owner), true);
    // backdated past staleness: the takeover UPDATE only touches the row once a marker
    // looks stale, so a fresh marker can't race a concurrent clear
    await backdateMarker(owner.receiptId, "5 minutes");

    // holds an uncommitted clear open on its own connection. the duplicate's read still
    // sees the marker set, tries to take it over, and blocks on the row until this
    // releases it and finds the marker already cleared: the gap replayProviderReceipt's
    // re-read exists to catch.
    const clearing = await createPostgresQueryRuntime(databaseUrl);
    let markUpdateIssued: () => void = () => undefined;
    const updateIssued = new Promise<void>((resolve) => {
      markUpdateIssued = resolve;
    });
    let releaseLock: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const clearingTransaction = clearing.transaction(async (transaction) => {
      await transaction.query(
        `update provider_event_receipts
            set enrichment_pending_since = null, payload = $2::jsonb
          where id = $1`,
        [owner.receiptId, JSON.stringify({ addedLabels: ["bug"] })],
      );
      // the row is now locked but uncommitted, so kick off the duplicate only now:
      // its read lands before the lock releases, and its takeover blocks on this row
      markUpdateIssued();
      await held;
    });

    await updateIssued;
    const duplicatePromise = database.acceptForgejoEvent({
      ...evidence,
      deliveryId: "delivery-duplicate",
      payload: {},
    });
    // margin for the duplicate's read and blocked takeover to land before the clear commits
    await new Promise((resolve) => setTimeout(resolve, 200));
    releaseLock();
    await clearingTransaction;
    await clearing.close();

    const duplicate = await duplicatePromise;
    assert.equal(duplicate.status, "accepted");
    if (duplicate.status === "accepted") {
      assert.equal(duplicate.ownsEnrichment, undefined);
      assert.deepEqual(duplicate.events[0]?.payload, { addedLabels: ["bug"] });
    }

    await database.close();
  }, 120_000);

  async function backdateMarker(receiptId: string, age: string): Promise<void> {
    const client = await createPostgresQueryRuntime(databaseUrl);
    await client.query(
      `update provider_event_receipts
          set enrichment_pending_since = now() - $2::interval
        where id = $1`,
      [receiptId, age],
    );
    await client.close();
  }

  // one org, project, connection and route per test, keyed by prefix so tests can share
  // a container without sharing rows
  async function seedForgejoRoute(database: Database, prefix: string) {
    const organizationId = `forgejo-marker-org-${prefix}`;
    const projectId = `${prefix}000000-0000-4000-8000-000000000001`;
    const connectionId = `${prefix}000000-0000-4000-8000-000000000011`;
    const client = await createPostgresQueryRuntime(databaseUrl);
    await client.query(`
      insert into organization (id, name, slug)
      values ('${organizationId}', 'Forgejo Marker', '${organizationId}');
      insert into projects (id, organization_id, name, slug)
      values ('${projectId}', '${organizationId}', 'Default', 'default');
      insert into forgejo_connections
        (id, organization_id, slug, instance_base_url, instance_host, webhook_secret,
         access_token, account_login, account_id, instance_flavor, instance_version)
      values
        ('${connectionId}', '${organizationId}', 'forge', 'https://git.example.test',
         'git.example.test', 'hook-secret', 'forgejo-access-token', 'trillian', 42,
         'forgejo', '16.0.5+gitea-1.22.0');
    `);
    await client.close();
    const revision = await database.insertProjectConfigurationRevision({
      projectId,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: `forgejo-marker-config-${prefix}`,
    });
    await database.activateProjectConfigurationRevision(projectId, revision.id, [
      {
        provider: "forgejo",
        connectionId,
        resourceId: "9001",
        triggerName: "forgejo-issue-comment",
      },
    ]);
    return {
      connectionId,
      repositoryId: 9001,
      source: "forgejo.issues",
      repo: "acme/widgets",
      signatureHash: `forgejo-marker-signature-${prefix}`,
      receivedAt: new Date(0),
      enrichmentPending: true,
    };
  }
});

function ownsEnrichment(result: ProviderEventAcceptance): boolean {
  return result.status === "accepted" && result.ownsEnrichment === true;
}
