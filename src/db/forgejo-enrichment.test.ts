import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { FORGEJO_ENRICHMENT_STALE_MS } from "./forgejo-enrichment.js";
import {
  createForgejoRoutedMemoryDatabase,
  MEMORY_FORGEJO_CONNECTION_ID,
} from "./test-utils/forgejo-route.js";
import type { ProviderEventAcceptance } from "./types.js";

// memory twin of forgejo-enrichment.integration.test.ts
describe("Forgejo enrichment marker in memory", () => {
  const evidence = {
    connectionId: MEMORY_FORGEJO_CONNECTION_ID,
    repositoryId: 9001,
    source: "forgejo.issues",
    repo: "acme/widgets",
    signatureHash: "forgejo-memory-signature",
    receivedAt: new Date(0),
    payload: {},
    enrichmentPending: true,
  };

  it("hands the marker to the first accept and answers pending while it is held", async () => {
    const database = await createForgejoRoutedMemoryDatabase();

    const owner = await database.acceptForgejoEvent({ ...evidence, deliveryId: "d-owner" });
    const duplicate = await database.acceptForgejoEvent({ ...evidence, deliveryId: "d-dup" });

    assert.equal(ownsEnrichment(owner), true);
    assert.equal(duplicate.status, "pending");
    assert.equal(duplicate.receiptId, owner.receiptId);
    // real wall-clock time, no injected clock: near zero, never negative
    if (duplicate.status === "pending") {
      assert.ok(
        duplicate.ageMs >= 0 && duplicate.ageMs < 1_000,
        `unexpected age ${duplicate.ageMs}`,
      );
    }
  });

  it("reports the marker's age so the caller can tell fresh from overdue", async () => {
    let now = new Date("2026-09-26T08:00:00.000Z");
    const database = await createForgejoRoutedMemoryDatabase({ now: () => now });
    await database.acceptForgejoEvent({ ...evidence, deliveryId: "d-owner" });

    now = new Date(now.getTime() + 5_000);
    const duplicate = await database.acceptForgejoEvent({ ...evidence, deliveryId: "d-dup" });

    assert.equal(duplicate.status, "pending");
    if (duplicate.status === "pending") assert.equal(duplicate.ageMs, 5_000);
  });

  it("replays the enriched payload once completed, without handing out the marker", async () => {
    const database = await createForgejoRoutedMemoryDatabase();
    const owner = await database.acceptForgejoEvent({ ...evidence, deliveryId: "d-owner" });

    await database.completeForgejoEnrichment(owner.receiptId, { addedLabels: ["bug"] });
    const replay = await database.acceptForgejoEvent({ ...evidence, deliveryId: "d-later" });

    assert.equal(replay.status, "accepted");
    if (replay.status !== "accepted") throw new Error("expected an accepted replay");
    assert.equal(replay.ownsEnrichment, undefined);
    assert.deepEqual(replay.events[0]?.payload, { addedLabels: ["bug"] });
  });

  it("keeps the original payload when completed with nothing found", async () => {
    const database = await createForgejoRoutedMemoryDatabase();
    const owner = await database.acceptForgejoEvent({
      ...evidence,
      deliveryId: "d-owner",
      payload: { original: true },
    });

    await database.completeForgejoEnrichment(owner.receiptId);
    const replay = await database.acceptForgejoEvent({ ...evidence, deliveryId: "d-later" });

    assert.equal(replay.status, "accepted");
    if (replay.status !== "accepted") throw new Error("expected an accepted replay");
    assert.deepEqual(replay.events[0]?.payload, { original: true });
  });

  it("never marks a delivery that is not going to enrich", async () => {
    const database = await createForgejoRoutedMemoryDatabase();
    const plain = { ...evidence, enrichmentPending: false };

    const first = await database.acceptForgejoEvent({ ...plain, deliveryId: "d-first" });
    const replay = await database.acceptForgejoEvent({ ...plain, deliveryId: "d-second" });

    assert.equal(first.status, "accepted");
    assert.equal(ownsEnrichment(first), false);
    assert.equal(replay.status, "accepted");
  });

  it("lets exactly one caller take over a stale marker", async () => {
    let now = new Date("2026-09-26T08:00:00.000Z");
    const database = await createForgejoRoutedMemoryDatabase({ now: () => now });
    await database.acceptForgejoEvent({ ...evidence, deliveryId: "d-crashed" });

    now = new Date(now.getTime() + FORGEJO_ENRICHMENT_STALE_MS + 1);
    const results = await Promise.all([
      database.acceptForgejoEvent({ ...evidence, deliveryId: "d-a" }),
      database.acceptForgejoEvent({ ...evidence, deliveryId: "d-b" }),
    ]);

    assert.equal(results.filter(ownsEnrichment).length, 1);
    assert.equal(results.filter((result) => result.status === "pending").length, 1);
  });

  it("does not take over a marker that is merely slow", async () => {
    let now = new Date("2026-09-26T08:00:00.000Z");
    const database = await createForgejoRoutedMemoryDatabase({ now: () => now });
    await database.acceptForgejoEvent({ ...evidence, deliveryId: "d-owner" });

    now = new Date(now.getTime() + 30_000);
    const duplicate = await database.acceptForgejoEvent({ ...evidence, deliveryId: "d-dup" });

    assert.equal(duplicate.status, "pending");
    if (duplicate.status === "pending") assert.equal(duplicate.ageMs, 30_000);
  });
});

function ownsEnrichment(result: ProviderEventAcceptance): boolean {
  return result.status === "accepted" && result.ownsEnrichment === true;
}
