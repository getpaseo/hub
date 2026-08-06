import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { createActiveProjectConfiguration } from "../test-utils/project-configuration.js";
import { ProjectConfigurationStore } from "../configuration/store.js";

const validConfig = {
  environments: [{ name: "production", kind: "docker", image: "paseo/runner" }],
  triggers: [],
};

describe("project configuration lifecycle", () => {
  it("activates immutable revisions and rolls back within one project", async () => {
    const database = createMemoryDatabase();
    const {
      project,
      revision: first,
      store,
    } = await createActiveProjectConfiguration(database, validConfig, {
      organizationId: "organization-a",
    });
    const second = await store.insertManualRevision({
      rawYaml: null,
      rawConfiguration: validConfig,
      userId: "operator",
    });

    await store.activate(second.id);
    const rolledBack = await store.rollback();

    assert.equal((await database.findActiveProjectConfiguration(project.id))?.id, first.id);
    assert.equal(rolledBack.revision.id, first.id);
  });

  it("rejects invalid and cross-project activation", async () => {
    const database = createMemoryDatabase();
    const projectA = await createActiveProjectConfiguration(database, validConfig, {
      organizationId: "organization-a",
    });
    const projectB = await createActiveProjectConfiguration(database, validConfig, {
      organizationId: "organization-a",
    });
    const invalid = await projectA.store.insertManualRevision({
      rawYaml: null,
      rawConfiguration: { environments: [], triggers: "invalid" },
      userId: "operator",
    });

    await assert.rejects(
      projectA.store.activate(invalid.id),
      /invalid compiled workflow contract/u,
    );
    await assert.rejects(
      new ProjectConfigurationStore(database, projectA.project.id).activate(projectB.revision.id),
      /configuration revision not found/u,
    );
  });
});
