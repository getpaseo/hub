import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ProjectConfigurationStore } from "../configuration/store.js";
import { parseCompiledHubConfig } from "../config/compiler.js";
import { hashPromptPartialContent } from "../config/prompt-partials.js";
import { createMemoryDatabase } from "../db/memory.js";
import { enrollTestDaemon } from "../test-utils/project-configuration.js";
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

const partialWorkflowYaml = [
  "environments:",
  "  - name: runner",
  "    kind: daemon",
  "    daemon: daemon-10000000",
  "    cwd: /repo",
  "triggers:",
  "  - name: request",
  "    on: manual.run",
  "    max_runtime: 1h",
  "    steps:",
  "      - id: work",
  "        environment: runner",
  "        max_runtime: 10m",
  "        idle_timeout: 1m",
  "        agent: { provider: test }",
  "        prompt:",
  "          - include: docs/safety.md",
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

  it("resolves submitted prompt partials and records their source evidence", async () => {
    const harness = await installHarness();

    const result = await harness.install(partialWorkflowYaml, [
      { path: "docs/safety.md", content: "Follow the safety checklist." },
    ]);

    assert.equal(result.status, "installed");
    const revision = (await harness.readModel()).activeRevision;
    assert.ok(revision);
    const compiled = parseCompiledHubConfig(revision.normalizedConfiguration);
    assert.deepEqual(compiled.triggers[0]?.steps[0]?.prompt, [
      {
        kind: "partial",
        path: ".paseo/partials/docs/safety.md",
        content: "Follow the safety checklist.",
        contentHash: hashPromptPartialContent("Follow the safety checklist."),
      },
    ]);
    assert.deepEqual(revision.sourceEvidence, {
      kind: "api-key",
      keyId: authorization.keyId,
      partials: [
        {
          path: ".paseo/partials/docs/safety.md",
          content: "Follow the safety checklist.",
          contentHash: hashPromptPartialContent("Follow the safety checklist."),
        },
      ],
    });
  });

  it.each([
    {
      name: "missing",
      files: [],
      expected: ["partials", ".paseo/partials/docs/safety.md"],
    },
    {
      name: "unsafe",
      files: [{ path: "../secret.md", content: "secret" }],
      expected: ["partials", 0, "path"],
    },
    {
      name: "duplicate",
      files: [
        { path: "docs/safety.md", content: "one" },
        { path: "docs/safety%2emd", content: "two" },
      ],
      expected: ["partials", 1, "path"],
    },
    {
      name: "unexpected",
      yaml: workflowYaml,
      files: [{ path: "unused.md", content: "unused" }],
      expected: ["partials", 0, "path"],
    },
  ])(
    "rejects $name partial bundle at the operation boundary",
    async ({ yaml, files, expected }) => {
      const harness = await installHarness();

      const result = await harness.install(yaml ?? partialWorkflowYaml, files);

      assert.equal(result.status, "invalid_bundle");
      if (result.status !== "invalid_bundle") return;
      assert.deepEqual(result.issues[0]?.path, expected);
      assert.equal(harness.insertions, 0);
      assert.equal((await harness.readModel()).activeRevision, null);
    },
  );

  it("creates a new revision when only supplied partial content changes", async () => {
    const harness = await installHarness();

    const first = await harness.install(partialWorkflowYaml, [
      { path: "docs/safety.md", content: "First instructions" },
    ]);
    const firstRevision = (await harness.readModel()).activeRevision;
    const second = await harness.install(partialWorkflowYaml, [
      { path: "docs/safety.md", content: "Second instructions" },
    ]);
    const secondRevision = (await harness.readModel()).activeRevision;

    assert.equal(first.status, "installed");
    assert.equal(second.status, "installed");
    assert.ok(firstRevision);
    assert.ok(secondRevision);
    assert.notEqual(firstRevision.id, secondRevision.id);
    assert.notEqual(firstRevision.contentHash, secondRevision.contentHash);
    assert.equal(secondRevision.rawYaml, partialWorkflowYaml);
  });
});

async function installHarness() {
  const database = createMemoryDatabase({ organizationIds: [authorization.organizationId] });
  await enrollTestDaemon(database, authorization.organizationId);
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
    install: (yaml: string, partials: readonly { path: string; content: string }[] = []) =>
      operations.installConfiguration(authorization, {
        projectSlug: project.slug,
        yaml,
        partials,
      }),
    readModel: () => database.projectConfigurationReadModel(project.id),
    get insertions() {
      return insertions;
    },
    get insertedConfigurationHasProject() {
      return insertedConfigurationHasProject;
    },
  };
}
