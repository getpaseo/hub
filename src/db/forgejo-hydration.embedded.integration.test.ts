import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { createSqlForgejoDirectory } from "./forgejo-directory.js";
import { createSqlForgejoHydrationStore } from "./forgejo-hydration.js";
import { embeddedDatabaseRuntime, type QueryHandle } from "./runtime/index.js";

const roots: string[] = [];
const connectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const instanceId = "11111111-1111-4111-8111-111111111111";
const cursorKey = {
  connectionId,
  repositoryId: 1,
  subjectKind: "issue" as const,
  subjectId: 3,
  recordKind: "timeline" as const,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQL Forgejo hydration store", () => {
  it("inserts a recovered event and advances the cursor atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-forgejo-hydration-"));
    roots.push(root);
    const bundle = await embeddedDatabaseRuntime(join(root, "database"));
    try {
      await bundle.runtime.migrate();
      await seedConnection(bundle.runtime);
      const store = createSqlForgejoHydrationStore(bundle.runtime);
      await store.seedCursor(cursorKey, 2);
      const first = await store.insertRecoveredAndAdvance({
        key: cursorKey,
        organizationId: "org_1",
        sourceRecordKind: "label",
        sourceRecordId: 3,
        cursorRecordId: 3,
      });
      const second = await store.insertRecoveredAndAdvance({
        key: cursorKey,
        organizationId: "org_1",
        sourceRecordKind: "label",
        sourceRecordId: 3,
        cursorRecordId: 3,
      });
      assert.equal(first, "inserted");
      assert.equal(second, "duplicate");
      assert.equal(await store.getCursor(cursorKey), 3);
    } finally {
      await bundle.runtime.close();
    }
  });

  it("serializes overlapping recovered-event inserts onto one cursor advance", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-forgejo-hydration-"));
    roots.push(root);
    const bundle = await embeddedDatabaseRuntime(join(root, "database"));
    try {
      await bundle.runtime.migrate();
      await seedConnection(bundle.runtime);
      const store = createSqlForgejoHydrationStore(bundle.runtime);
      await store.seedCursor(cursorKey, 2);
      const outcomes = await Promise.all([
        store.insertRecoveredAndAdvance({
          key: cursorKey,
          organizationId: "org_1",
          sourceRecordKind: "label",
          sourceRecordId: 3,
          cursorRecordId: 3,
        }),
        store.insertRecoveredAndAdvance({
          key: cursorKey,
          organizationId: "org_1",
          sourceRecordKind: "label",
          sourceRecordId: 3,
          cursorRecordId: 3,
        }),
      ]);
      assert.deepEqual(new Set(outcomes), new Set(["inserted", "duplicate"]));
      assert.equal(await store.getCursor(cursorKey), 3);
    } finally {
      await bundle.runtime.close();
    }
  });
});

async function seedConnection(runtime: QueryHandle): Promise<void> {
  const now = new Date("2026-08-30T00:00:00.000Z");
  const directory = createSqlForgejoDirectory(runtime);
  await runtime.query(`insert into organization (id, name, slug) values ($1, $2, $3)`, [
    "org_1",
    "T10 Org",
    "t10-org",
  ]);
  await directory.insertInstance({
    id: instanceId,
    canonicalOrigin: "https://forgejo.example.test",
    allowPrivateNetwork: false,
    externalIdentity: { kind: "forgejo", version: "16.0.3", fingerprint: "fp" },
    reportedVersion: "16.0.3",
    status: "active",
    approvedByUserId: null,
    approvedAt: now,
    lastHealthAt: now,
    lastHealthError: null,
    createdAt: now,
    updatedAt: now,
  });
  await directory.insertConnection({
    id: connectionId,
    organizationId: "org_1",
    instanceId,
    slug: "forgejo",
    status: "active",
    forgejoUserId: 2,
    forgejoUserLogin: "t00bot",
    providerApplicationId: null,
  });
}
