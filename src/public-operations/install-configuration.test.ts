import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  revisionBundleFiles,
  ProjectConfigurationStore,
  type DaemonAgentConfigurationValidator,
} from "../configuration/store.js";
import { parseCompiledHubConfig } from "../config/compiler.js";
import type { HubBundleFile } from "../config/bundle.js";
import { hashPromptPartialContent } from "../config/prompt-partials.js";
import { createMemoryDatabase } from "../db/memory.js";
import { enrollTestDaemon } from "../test-utils/project-configuration.js";
import { createDatabasePublicOperationRepository } from "./database-adapter.js";
import { createPublicOperations } from "./index.js";

const authorization = {
  kind: "apiKey" as const,
  credentialId: "api-key-1",
  organizationId: "organization-1",
  scopes: ["configuration:install" as const],
};

function files(partial = "Follow the safety checklist."): HubBundleFile[] {
  return [
    {
      path: ".paseo/hub.yml",
      content: [
        "environments:",
        "  runner:",
        "    kind: daemon",
        "    daemon: daemon-10000000",
        "    cwd: /repo",
        "agents: {}",
      ].join("\n"),
    },
    {
      path: ".paseo/workflows/request.yml",
      content: [
        "name: request",
        "on: manual.run",
        "max_runtime: 1h",
        "steps:",
        "  - id: work",
        "    environment: runner",
        "    max_runtime: 10m",
        "    idle_timeout: 1m",
        "    agent: { provider: test }",
        "    prompt:",
        "      - include: partials/docs/safety.md",
      ].join("\n"),
    },
    { path: ".paseo/workflows/partials/docs/safety.md", content: partial },
  ];
}

describe("public configuration bundle installation", () => {
  it("installs and retains every exact authored file", async () => {
    const harness = await installHarness();
    const result = await harness.install(files());

    assert.equal(result.status, "installed");
    assert.equal(harness.insertions, 1);
    const revision = (await harness.readModel()).activeRevision;
    assert.ok(revision);
    assert.deepEqual(
      revisionBundleFiles(revision),
      files().toSorted((left, right) => left.path.localeCompare(right.path)),
    );
    const compiled = parseCompiledHubConfig(revision.normalizedConfiguration);
    assert.deepEqual(compiled.triggers[0]?.steps[0]?.prompt, [
      {
        kind: "partial",
        path: ".paseo/workflows/partials/docs/safety.md",
        content: "Follow the safety checklist.",
        contentHash: hashPromptPartialContent("Follow the safety checklist."),
      },
    ]);
  });

  it("validates without creating a revision", async () => {
    const harness = await installHarness();
    assert.deepEqual(await harness.validate(files()), {
      status: "valid",
      projectSlug: "payments",
      valid: true,
    });
    assert.equal(harness.insertions, 0);
  });

  it("rejects every named agent through the selected daemon's current provider contract", async () => {
    const validations: Array<{ daemonId: string; provider: string }> = [];
    const validator: DaemonAgentConfigurationValidator = {
      async validateAgentConfiguration(daemonId, agent) {
        validations.push({ daemonId, provider: agent.provider });
        return {
          valid: false,
          issues: [
            { path: ["provider"], message: "provider definitely-not-installed is unavailable" },
            { path: ["options", "nonsense"], message: "unrecognized provider option" },
          ],
        };
      },
    };
    const harness = await installHarness(validator);

    const result = await harness.install(namedAgentFiles());

    assert.equal(result.status, "invalid_configuration");
    if (result.status !== "invalid_configuration") return;
    assert.deepEqual(
      result.issues.map(({ path }) => path),
      [
        [".paseo/hub.yml", "agents", "broken", "provider"],
        [".paseo/hub.yml", "agents", "broken", "options", "nonsense"],
      ],
    );
    assert.deepEqual(validations, [
      { daemonId: "10000000-0000-4000-8000-000000000001", provider: "definitely-not-installed" },
    ]);
    assert.equal((await harness.readModel()).activeRevision, null);
  });

  it("revalidates named agents at activation against the daemon's current contract", async () => {
    let validations = 0;
    const validator: DaemonAgentConfigurationValidator = {
      async validateAgentConfiguration() {
        validations += 1;
        return validations === 1
          ? { valid: true }
          : {
              valid: false,
              issues: [{ path: ["provider"], message: "provider became unavailable" }],
            };
      },
    };
    const harness = await installHarness(validator);

    const result = await harness.install(namedAgentFiles());

    assert.equal(result.status, "invalid_configuration");
    if (result.status !== "invalid_configuration") return;
    assert.deepEqual(result.issues, [
      {
        path: [".paseo/hub.yml", "agents", "broken", "provider"],
        message: "provider became unavailable",
      },
    ]);
    assert.equal(validations, 2);
    assert.equal((await harness.readModel()).activeRevision, null);
  });

  it.each([
    {
      name: "missing workflow partial",
      bundle: files().slice(0, 2),
      path: [".paseo/workflows/partials/docs/safety.md"],
    },
    {
      name: "duplicate source path",
      bundle: [...files(), files()[1]!],
      path: [".paseo/workflows/request.yml"],
    },
    {
      name: "monolithic trigger",
      bundle: [
        {
          path: ".paseo/hub.yml",
          content: `${files()[0]!.content}\ntriggers: []`,
        },
      ],
      path: [".paseo/hub.yml", "triggers"],
    },
    {
      name: "malformed workflow expression",
      bundle: files().map((file) =>
        file.path === ".paseo/workflows/request.yml"
          ? Object.assign({}, file, {
              content: file.content.replace(
                "agent: { provider: test }",
                "agent: ${{ paseo.inputs.agent + }}",
              ),
            })
          : file,
      ),
      path: [".paseo/workflows/request.yml", "steps", "work", "agent"],
    },
  ])("rejects $name before creating a revision", async ({ bundle, path }) => {
    const harness = await installHarness();
    const result = await harness.install(bundle);
    assert.equal(result.status, "invalid_bundle");
    if (result.status !== "invalid_bundle") return;
    assert.deepEqual(result.issues[0]?.path, path);
    assert.equal(harness.insertions, 0);
  });

  it("creates a distinct revision when only a partial changes", async () => {
    const harness = await installHarness();
    await harness.install(files("First instructions"));
    const first = (await harness.readModel()).activeRevision;
    await harness.install(files("Second instructions"));
    const second = (await harness.readModel()).activeRevision;
    assert.ok(first && second);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.contentHash, second.contentHash);
  });
});

async function installHarness(validator?: DaemonAgentConfigurationValidator) {
  const database = createMemoryDatabase({ organizationIds: [authorization.organizationId] });
  await enrollTestDaemon(database, authorization.organizationId);
  const project = await database.createProject({
    organizationId: authorization.organizationId,
    name: "Payments",
    slug: "payments",
    createdByUserId: "user-1",
  });
  let insertions = 0;
  const store = new ProjectConfigurationStore(database, project.id, validator);
  const operations = createPublicOperations(createDatabasePublicOperationRepository(database), {
    configurationForProject: () => ({
      validateBundle: (bundle) => store.validateBundle(bundle),
      async insertManualBundleRevision(input) {
        insertions += 1;
        return store.insertManualBundleRevision(input);
      },
      activate: (id) => store.activate(id),
    }),
    dispatchManualEvent: () => Promise.resolve(),
  });
  return {
    install: (bundle: readonly HubBundleFile[]) =>
      operations.installConfiguration(authorization, {
        projectSlug: project.slug,
        files: bundle,
      }),
    validate: (bundle: readonly HubBundleFile[]) =>
      operations.validateConfiguration(authorization, {
        projectSlug: project.slug,
        files: bundle,
      }),
    readModel: () => database.projectConfigurationReadModel(project.id),
    get insertions() {
      return insertions;
    },
  };
}

function namedAgentFiles(): HubBundleFile[] {
  return files().map((file) => {
    if (file.path === ".paseo/hub.yml") {
      return Object.assign({}, file, {
        content: file.content.replace(
          "agents: {}",
          [
            "agents:",
            "  broken:",
            "    provider: definitely-not-installed",
            "    options: { nonsense: true }",
          ].join("\n"),
        ),
      });
    }
    return file.path === ".paseo/workflows/request.yml"
      ? Object.assign({}, file, {
          content: file.content.replace("agent: { provider: test }", "agent: broken"),
        })
      : file;
  });
}
