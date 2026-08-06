import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseCompiledHubConfig } from "../config/compiler.js";
import { hashPromptPartialContent } from "../config/prompt-partials.js";
import type { PromptPartialReadResult } from "../config/prompt-partials.js";
import { createMemoryDatabase } from "../db/memory.js";
import {
  createActiveProjectConfiguration,
  enrollTestDaemon,
  TEST_DAEMON_SLUG,
} from "../test-utils/project-configuration.js";
import {
  synchronizeGitHubProjectConfiguration,
  type GitHubConfigurationProvider,
} from "./github-sync.js";

const INITIAL = {
  environments: [{ name: "runner", kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/repo" }],
  triggers: [],
};

describe("exact-commit GitHub configuration sync", () => {
  it("resolves mixed inline and partial prompt blocks at the configuration commit", async () => {
    const database = createMemoryDatabase();
    const { project } = await createActiveProjectConfiguration(database, INITIAL);
    await enrollTestDaemon(database);
    const client = new ExactCommitGitHubConfigurationFake({
      "partial-sha:hub.yml": [
        "environments:",
        "  - name: runner",
        "    kind: daemon",
        `    daemon: ${TEST_DAEMON_SLUG}`,
        "    cwd: /repo",
        "triggers:",
        "  - name: request",
        "    on: manual.run",
        "    max_runtime: 1h",
        "    inputs:",
        "      repo:",
        "        type: string",
        "        choices: [hub]",
        "    values:",
        "      selected: ${{ paseo.inputs.repo }}",
        "    steps:",
        "      - id: work",
        "        environment: runner",
        "        max_runtime: 10m",
        "        idle_timeout: 1m",
        "        agent: { provider: codex }",
        "        prompt:",
        "          - include: safety.md",
        "          - text: 'Request: ${{ paseo.prompt }} / ${{ values.selected }}'",
      ].join("\n"),
      "partial-sha:.paseo/partials/safety.md":
        "Safety instructions for ${{ paseo.prompt }} and ${{ paseo.inputs.repo }}.",
    });

    const result = await sync(database, client, project.id, "partial-sha");

    assert.equal(result.outcome, "activated");
    if (result.outcome !== "activated") return;
    const compiled = parseCompiledHubConfig(result.revision.normalizedConfiguration);
    assert.deepEqual(compiled.triggers[0]?.steps[0]?.prompt, [
      {
        kind: "partial",
        path: ".paseo/partials/safety.md",
        content: "Safety instructions for ${{ paseo.prompt }} and ${{ paseo.inputs.repo }}.",
        contentHash: hashPromptPartialContent(
          "Safety instructions for ${{ paseo.prompt }} and ${{ paseo.inputs.repo }}.",
        ),
      },
      { kind: "text", value: "Request: ${{ paseo.prompt }} / ${{ values.selected }}" },
    ]);
  });

  it("activates valid exact-SHA content and preserves it when the next SHA is invalid", async () => {
    const database = createMemoryDatabase();
    const { project, revision: initial } = await createActiveProjectConfiguration(
      database,
      INITIAL,
    );
    await enrollTestDaemon(database);
    await database.setProjectGitHubConfigurationSource({
      projectId: project.id,
      githubConnectionId: "github-connection-1",
      githubRepositoryId: 9001,
      githubRepositoryFullName: "acme/repo",
      githubDefaultBranch: "main",
      automaticDeploymentEnabled: true,
      userId: "test-user",
    });
    const client = new ExactCommitGitHubConfigurationFake({
      "valid-sha": [
        "environments:",
        "  - name: runner",
        "    kind: daemon",
        `    daemon: ${TEST_DAEMON_SLUG}`,
        "    cwd: /repo",
        "triggers: []",
      ].join("\n"),
      "invalid-sha": "environments: []\ntriggers: invalid",
    });

    const valid = await sync(database, client, project.id, "valid-sha");
    assert.equal(valid.outcome, "activated");
    const activeAfterValid = await database.findActiveProjectConfiguration(project.id);
    assert.equal(activeAfterValid?.id, valid.outcome === "activated" ? valid.revision.id : "");
    assert.notEqual(activeAfterValid?.id, initial.id);

    const invalid = await sync(database, client, project.id, "invalid-sha");
    assert.equal(invalid.outcome, "invalid");
    assert.equal(
      (await database.findActiveProjectConfiguration(project.id))?.id,
      activeAfterValid?.id,
    );
    assert.deepEqual(client.reads, [
      { repositoryId: 9001, commitSha: "valid-sha", path: "hub.yml" },
      { repositoryId: 9001, commitSha: "invalid-sha", path: "hub.yml" },
    ]);

    const status = await database.projectConfigurationReadModel(project.id);
    assert.equal(status.authority, "github");
    assert.equal(status.activeRevision?.id, activeAfterValid?.id);
    assert.equal(status.lastSyncAttempt?.commitSha, "invalid-sha");
    assert.equal(status.lastSyncAttempt?.outcome, "invalid");
  });

  it("records missing exact-SHA content without reading a branch head or moving the pointer", async () => {
    const database = createMemoryDatabase();
    const { project, revision } = await createActiveProjectConfiguration(database, INITIAL);
    await enrollTestDaemon(database);
    await database.setProjectGitHubConfigurationSource({
      projectId: project.id,
      githubConnectionId: "github-connection-1",
      githubRepositoryId: 9001,
      githubRepositoryFullName: "acme/repo",
      githubDefaultBranch: "main",
      automaticDeploymentEnabled: true,
      userId: "test-user",
    });
    const client = new ExactCommitGitHubConfigurationFake({});

    assert.deepEqual(await sync(database, client, project.id, "missing-sha"), {
      outcome: "fetch_failed",
    });
    assert.equal((await database.findActiveProjectConfiguration(project.id))?.id, revision.id);
    assert.deepEqual(client.reads, [
      { repositoryId: 9001, commitSha: "missing-sha", path: "hub.yml" },
    ]);
  });

  it("creates a distinct compiled revision when only a partial changes", async () => {
    const database = createMemoryDatabase();
    const { project } = await createActiveProjectConfiguration(database, INITIAL);
    await enrollTestDaemon(database);
    const client = new ExactCommitGitHubConfigurationFake({
      "sha-one:hub.yml": partialConfigurationYaml(),
      "sha-one:.paseo/partials/safety.md": "First exact instructions",
      "sha-two:hub.yml": partialConfigurationYaml(),
      "sha-two:.paseo/partials/safety.md": "Second exact instructions",
    });

    const first = await sync(database, client, project.id, "sha-one");
    const second = await sync(database, client, project.id, "sha-two");

    assert.equal(first.outcome, "activated");
    assert.equal(second.outcome, "activated");
    if (first.outcome !== "activated" || second.outcome !== "activated") return;
    assert.notEqual(first.revision.id, second.revision.id);
    assert.notEqual(first.revision.contentHash, second.revision.contentHash);
    assert.match(JSON.stringify(second.revision.sourceEvidence), /Second exact instructions/iu);
    assert.deepEqual(client.reads, [
      { repositoryId: 9001, commitSha: "sha-one", path: "hub.yml" },
      { repositoryId: 9001, commitSha: "sha-one", path: ".paseo/partials/safety.md" },
      { repositoryId: 9001, commitSha: "sha-two", path: "hub.yml" },
      { repositoryId: 9001, commitSha: "sha-two", path: ".paseo/partials/safety.md" },
    ]);
  });

  it.each([
    {
      name: "missing partial",
      include: "missing.md",
      file: undefined,
      reason: /does not exist at exact commit/iu,
    },
    {
      name: "traversal partial",
      include: "../secrets.md",
      file: undefined,
      reason: /path must not contain/iu,
    },
    {
      name: "absolute partial",
      include: "/etc/passwd",
      file: undefined,
      reason: /path must be relative/iu,
    },
    {
      name: "directory partial",
      include: "directory.md",
      file: { kind: "directory" as const },
      reason: /not a regular file/iu,
    },
  ])("preserves the active revision for $name", async ({ include, file, reason }) => {
    const database = createMemoryDatabase();
    const { project, revision: initial } = await createActiveProjectConfiguration(
      database,
      INITIAL,
    );
    await enrollTestDaemon(database);
    const client = new ExactCommitGitHubConfigurationFake({
      "unsafe-sha:hub.yml": partialConfigurationYaml(include),
      ...(file === undefined ? {} : { [`unsafe-sha:.paseo/partials/${include}`]: file }),
    });

    const result = await sync(database, client, project.id, "unsafe-sha");

    assert.equal(result.outcome, "invalid");
    assert.equal((await database.findActiveProjectConfiguration(project.id))?.id, initial.id);
    assert.match(
      JSON.stringify(result.outcome === "invalid" ? result.revision.validationErrors : null),
      reason,
    );
  });

  it("records a partial fetch failure without creating an invalid revision", async () => {
    const database = createMemoryDatabase();
    const { project, revision: initial } = await createActiveProjectConfiguration(
      database,
      INITIAL,
    );
    await enrollTestDaemon(database);
    const client = new ExactCommitGitHubConfigurationFake(
      { "fetch-failure:hub.yml": partialConfigurationYaml() },
      { "fetch-failure:.paseo/partials/safety.md": new Error("GitHub unavailable") },
    );

    const result = await sync(database, client, project.id, "fetch-failure");

    assert.deepEqual(result, { outcome: "fetch_failed" });
    assert.equal((await database.findActiveProjectConfiguration(project.id))?.id, initial.id);
    assert.equal(
      (await database.projectConfigurationReadModel(project.id)).lastSyncAttempt?.outcome,
      "fetch_failed",
    );
  });
});

class ExactCommitGitHubConfigurationFake implements Pick<
  GitHubConfigurationProvider,
  "readFileAtCommit"
> {
  readonly reads: Array<{ repositoryId: number; commitSha: string; path: string }> = [];

  constructor(
    private readonly filesByCommit: Readonly<Record<string, string | PromptPartialReadResult>>,
    private readonly errorsByCommit: Readonly<Record<string, Error>> = {},
  ) {}

  readFileAtCommit(input: {
    installationId: number;
    repositoryId: number;
    commitSha: string;
    path: string;
  }) {
    this.reads.push({
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      path: input.path,
    });
    const error = this.errorsByCommit[`${input.commitSha}:${input.path}`];
    if (error !== undefined) return Promise.reject(error);
    const content =
      this.filesByCommit[`${input.commitSha}:${input.path}`] ?? this.filesByCommit[input.commitSha];
    if (content === undefined) return Promise.resolve(undefined);
    return Promise.resolve(
      typeof content === "string" ? { kind: "file" as const, content } : content,
    );
  }
}

function partialConfigurationYaml(include = "safety.md"): string {
  return [
    "environments:",
    "  - name: runner",
    "    kind: daemon",
    `    daemon: ${TEST_DAEMON_SLUG}`,
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
    "        agent: { provider: codex }",
    "        prompt:",
    `          - include: ${include}`,
  ].join("\n");
}

function sync(
  database: ReturnType<typeof createMemoryDatabase>,
  client: Pick<GitHubConfigurationProvider, "readFileAtCommit">,
  projectId: string,
  commitSha: string,
) {
  return synchronizeGitHubProjectConfiguration({
    database,
    client,
    projectId,
    githubConnectionId: "github-connection-1",
    githubRepositoryId: 9001,
    githubRepositoryFullName: "acme/repo",
    githubDefaultBranch: "main",
    installationId: 42,
    repositoryId: 9001,
    commitSha,
    path: "hub.yml",
    webhookDeliveryId: `delivery-${commitSha}`,
  });
}
