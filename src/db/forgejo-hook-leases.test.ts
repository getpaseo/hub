import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { FORGEJO_HOOK_LEASE_MS } from "./forgejo-hook-leases.js";
import {
  createForgejoRoutedMemoryDatabase,
  MEMORY_FORGEJO_CONNECTION_ID,
} from "./test-utils/forgejo-route.js";

// Memory twin of forgejo-hook-leases.integration.test.ts.
describe("Forgejo hook lease in memory", () => {
  const ORG = "org-forgejo";

  it("lets exactly one of two concurrent claims win", async () => {
    const database = await createForgejoRoutedMemoryDatabase();

    const claims = await Promise.all([
      database.claimForgejoHookLease(MEMORY_FORGEJO_CONNECTION_ID, ORG),
      database.claimForgejoHookLease(MEMORY_FORGEJO_CONNECTION_ID, ORG),
    ]);

    assert.equal(claims.filter((claim) => claim !== undefined).length, 1);
  });

  it("frees the lease on release, so the next claim wins", async () => {
    const database = await createForgejoRoutedMemoryDatabase();

    const first = await database.claimForgejoHookLease(MEMORY_FORGEJO_CONNECTION_ID, ORG);
    assert.ok(first);
    await database.releaseForgejoHookLease(MEMORY_FORGEJO_CONNECTION_ID, first);

    assert.ok(await database.claimForgejoHookLease(MEMORY_FORGEJO_CONNECTION_ID, ORG));
  });

  it("never hands another organization the lease", async () => {
    const database = await createForgejoRoutedMemoryDatabase();

    assert.equal(
      await database.claimForgejoHookLease(MEMORY_FORGEJO_CONNECTION_ID, "org-vogon"),
      undefined,
    );
  });

  it("lets an expired lease be claimed again, and ignores the stale holder's release", async () => {
    let now = new Date("2026-09-26T08:00:00.000Z");
    const database = await createForgejoRoutedMemoryDatabase({ now: () => now });
    const stale = await database.claimForgejoHookLease(MEMORY_FORGEJO_CONNECTION_ID, ORG);
    assert.ok(stale);

    now = new Date(now.getTime() + FORGEJO_HOOK_LEASE_MS + 1);
    assert.ok(await database.claimForgejoHookLease(MEMORY_FORGEJO_CONNECTION_ID, ORG));
    await database.releaseForgejoHookLease(MEMORY_FORGEJO_CONNECTION_ID, stale);

    assert.equal(
      await database.claimForgejoHookLease(MEMORY_FORGEJO_CONNECTION_ID, ORG),
      undefined,
    );
  });
});
