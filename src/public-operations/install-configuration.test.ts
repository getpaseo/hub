import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { ProjectConfigurationStore } from "../configuration/store.js";
import { createDatabasePublicOperationRepository } from "./database-adapter.js";
import { createPublicOperations } from "./index.js";

const authorization = {
  keyId: "api-key-1",
  organizationId: "organization-1",
  scopes: ["configuration:install" as const],
};

const workflowYaml = [
  "environments:",
  "  - name: runner",
  "    kind: docker",
  "    image: paseo/valid",
  "triggers: []",
].join("\n");

describe("public configuration installation", () => {
  it("installs selector-free YAML exactly as before", async () => {
    const harness = await installHarness();

    const result = await harness.install(workflowYaml);

    assert.equal(result.status, "installed");
    assert.equal(harness.insertions, 1);
    assert.equal((await harness.readModel()).activeRevision?.rawYaml, workflowYaml);
  });

  it("lets the request project override different file metadata", async () => {
    const harness = await installHarness();
    const yaml = `project: another-organization/another-project\n${workflowYaml}`;

    const result = await harness.install(yaml);

    assert.equal(result.status, "installed");
    assert.equal(result.status === "installed" ? result.projectSlug : undefined, "payments");
    assert.equal(harness.insertedConfigurationHasProject, false);
    assert.equal((await harness.readModel()).activeRevision?.rawYaml, yaml);
  });

  it("keeps strict workflow validation after removing deployment metadata", async () => {
    const harness = await installHarness();

    const result = await harness.install(`project: payments\nunknown: true\n${workflowYaml}`);

    assert.equal(result.status, "invalid_configuration");
    assert.deepEqual(result.issues, [{ path: [], message: 'Unrecognized key: "unknown"' }]);
    assert.equal((await harness.readModel()).activeRevision, null);
  });

  it("reports invalid project metadata at the project field path without a revision", async () => {
    const harness = await installHarness();

    const result = await harness.install(`project: ""\n${workflowYaml}`);

    assert.equal(result.status, "invalid_document");
    assert.deepEqual(
      result.issues.map((issue) => issue.path),
      [["project"]],
    );
    assert.equal(harness.insertions, 0);
    assert.equal((await harness.readModel()).activeRevision, null);
  });
});

async function installHarness() {
  const database = createMemoryDatabase({ organizationIds: [authorization.organizationId] });
  const project = await database.createProject({
    organizationId: authorization.organizationId,
    name: "Payments",
    slug: "payments",
    createdByUserId: "user-1",
  });
  let insertions = 0;
  let insertedConfigurationHasProject = false;
  const store = new ProjectConfigurationStore(database, project.id);
  const operations = createPublicOperations(createDatabasePublicOperationRepository(database), {
    configurationForProject: () => ({
      async insertManualRevision(input) {
        insertions += 1;
        insertedConfigurationHasProject =
          typeof input.rawConfiguration === "object" &&
          input.rawConfiguration !== null &&
          Object.hasOwn(input.rawConfiguration, "project");
        return store.insertManualRevision(input);
      },
      activate: (id) => store.activate(id),
    }),
    dispatchManualEvent: () => Promise.resolve(),
  });
  return {
    install: (yaml: string) =>
      operations.installConfiguration(authorization, { projectSlug: project.slug, yaml }),
    readModel: () => database.projectConfigurationReadModel(project.id),
    get insertions() {
      return insertions;
    },
    get insertedConfigurationHasProject() {
      return insertedConfigurationHasProject;
    },
  };
}
