import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { createActiveProjectConfiguration } from "../test-utils/project-configuration.js";
import {
  synchronizeGitHubProjectConfiguration,
  type GitHubConfigurationProvider,
} from "./github-sync.js";

const INITIAL = {
  environments: [{ name: "runner", kind: "docker", image: "paseo/initial" }],
  triggers: [],
};

describe("exact-commit GitHub configuration sync", () => {
  it("activates valid exact-SHA content and preserves it when the next SHA is invalid", async () => {
    const database = createMemoryDatabase();
    const { project, revision: initial } = await createActiveProjectConfiguration(
      database,
      INITIAL,
    );
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
        "    kind: docker",
        "    image: paseo/valid",
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
});

class ExactCommitGitHubConfigurationFake implements Pick<
  GitHubConfigurationProvider,
  "readFileAtCommit"
> {
  readonly reads: Array<{ repositoryId: number; commitSha: string; path: string }> = [];

  constructor(private readonly filesByCommit: Readonly<Record<string, string>>) {}

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
    const rawYaml = this.filesByCommit[input.commitSha];
    return Promise.resolve(rawYaml === undefined ? undefined : { rawYaml });
  }
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
