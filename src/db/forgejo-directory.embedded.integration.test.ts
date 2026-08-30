import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { createSqlForgejoDirectory } from "./forgejo-directory.js";
import { embeddedDatabaseRuntime } from "./runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQL Forgejo directory", () => {
  it("persists instance approval rows against 0045 tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-forgejo-directory-"));
    roots.push(root);
    const bundle = await embeddedDatabaseRuntime(join(root, "database"));
    try {
      await bundle.runtime.migrate();
      const directory = createSqlForgejoDirectory(bundle.runtime);
      const now = new Date("2026-08-30T00:00:00.000Z");
      await directory.insertInstance({
        id: "11111111-1111-4111-8111-111111111111",
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
      const found = await directory.findInstanceByOrigin("https://forgejo.example.test");
      assert.equal(found?.status, "active");
      assert.equal(found?.canonicalOrigin, "https://forgejo.example.test");
      await assert.rejects(
        () =>
          directory.insertInstance({
            id: "22222222-2222-4222-8222-222222222222",
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
          }),
        { code: "forgejo_origin_invalid" },
      );
    } finally {
      await bundle.runtime.close();
    }
  });
});
