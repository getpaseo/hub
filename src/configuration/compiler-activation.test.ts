import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { parseProjectConfiguration, ProjectConfigurationStore } from "./store.js";

describe("compiled workflow activation", () => {
  it("activates a valid step-based configuration and stores the compiled contract", async () => {
    const database = createMemoryDatabase();
    const project = await database.createProject({
      organizationId: "org_1",
      name: "compiler-project",
      slug: "compiler-project",
      createdByUserId: "user-1",
    });
    const store = new ProjectConfigurationStore(database, project.id);
    const revision = await store.insertManualRevision({
      rawYaml: null,
      rawConfiguration: {
        environments: [{ name: "runner", kind: "docker", image: "paseo/test" }],
        triggers: [
          {
            name: "manual-workflow",
            on: "manual.run",
            max_runtime: "1h",
            steps: [
              {
                id: "work",
                environment: "runner",
                max_runtime: "10m",
                idle_timeout: "1m",
                agent: { provider: "codex" },
                prompt: [{ text: "Run the requested work" }],
              },
            ],
          },
        ],
      },
      userId: "user-1",
    });

    assert.equal(revision.validationErrors, null);
    const compiled = parseProjectConfiguration(revision);
    assert.equal(compiled.triggers[0]?.maxRuntimeMs, 3_600_000);
    assert.equal("max_runtime" in compiled.triggers[0], false);

    const active = await store.activate(revision.id);
    assert.equal(active.configuration.triggers[0]?.steps[0]?.maxRuntimeMs, 600_000);
    assert.equal(Object.isFrozen(active.configuration.triggers[0]?.steps[0]), true);

    const invalid = await store.insertManualRevision({
      rawYaml: null,
      rawConfiguration: {
        environments: [{ name: "runner", kind: "docker", image: "paseo/test" }],
        triggers: [
          {
            name: "legacy",
            on: "manual.run",
            max_runtime: "1h",
            environment: "runner",
            agent: { provider: "codex" },
            prompt: [{ text: "legacy" }],
            steps: [],
          },
        ],
      },
      userId: "user-1",
    });
    assert.match(JSON.stringify(invalid.validationErrors), /trigger-level environment.*step/iu);
    assert.equal((await store.getActive())?.revision.id, revision.id);
  });
});
