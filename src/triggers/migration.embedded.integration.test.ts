import { dump } from "js-yaml";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { compileHubBundle } from "../config/bundle.js";
import { createDatabase } from "../db/pg.js";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import {
  createProviderRegistry as createDatabaseProviders,
  createProviderRegistry as createEventProviders,
} from "../providers/server.js";
import { configurationBundleFixture } from "../test-utils/configuration-bundle.js";
import { migrateLegacyProjectTriggers } from "./migration.js";

const composedEvents = createEventProviders().configuration;
const databaseProviders = createDatabaseProviders();

describe("embedded startup trigger migration", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("persists the migration marker and self-contained revisions across reopen", async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-trigger-migration-"));
    const first = await embeddedDatabaseRuntime(join(root, "database"));
    await first.runtime.migrate();
    const database = createDatabase(first.runtime, first.locks, databaseProviders);
    await first.runtime.query(
      `insert into organization (id, name, slug) values ('org', 'Org', 'org')`,
    );
    const project = await database.createProject({
      organizationId: "org",
      name: "Project",
      slug: "project",
      createdByUserId: null,
    });
    const configuration = {
      environments: [{ name: "runner", kind: "daemon", daemon: "devbox", cwd: "/workspace" }],
      triggers: [
        {
          name: "request",
          on: "manual.run",
          max_runtime: "2h",
          steps: [
            {
              id: "work",
              environment: "runner",
              max_runtime: "1h",
              idle_timeout: "10m",
              agent: { provider: "codex" },
              prompt: [{ text: "Work" }],
            },
          ],
        },
      ],
    };
    const bundle = compileHubBundle(
      configurationBundleFixture(dump(configuration)),
      composedEvents,
    );
    const revision = await database.insertProjectConfigurationRevision({
      projectId: project.id,
      sourceKind: "manual",
      sourceEvidence: {
        kind: "manual",
        bundle: { authoredHash: bundle.authoredHash, files: bundle.files },
      },
      normalizedConfiguration: bundle.configuration,
      contentHash: bundle.authoredHash,
    });
    await database.activateProjectConfigurationRevision(project.id, revision.id);
    await migrateLegacyProjectTriggers(database, composedEvents);
    await database.close();

    const reopened = await embeddedDatabaseRuntime(join(root, "database"));
    await reopened.runtime.migrate();
    const reopenedDatabase = createDatabase(reopened.runtime, reopened.locks, databaseProviders);
    try {
      assert.equal((await reopenedDatabase.listOrganizationTriggers("org")).length, 1);
      assert.equal((await reopenedDatabase.listPendingProjectTriggerMigrations()).length, 0);
      assert.deepEqual(await migrateLegacyProjectTriggers(reopenedDatabase, composedEvents), {
        projects: 0,
        triggers: 0,
        legacyMultistepTriggers: 0,
      });
    } finally {
      await reopenedDatabase.close();
    }
  });
});
