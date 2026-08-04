import { load } from "js-yaml";
import type { Database, ProjectConfigurationRevisionRecord } from "../db/types.js";
import { configurationHash, ProjectConfigurationStore } from "./store.js";

export interface GitHubConfigurationProvider {
  listInstallationRepositories(input: {
    installationId: number;
  }): Promise<Array<{ repositoryId: number; fullName: string; defaultBranch: string }>>;
  readDefaultBranchHead(input: {
    installationId: number;
    repositoryId: number;
    defaultBranch: string;
  }): Promise<string>;
  readFileAtCommit(input: {
    installationId: number;
    repositoryId: number;
    commitSha: string;
    path: string;
  }): Promise<{ rawYaml: string } | undefined>;
}

export type GitHubConfigurationSyncResult =
  | { outcome: "activated"; revision: ProjectConfigurationRevisionRecord }
  | { outcome: "invalid"; revision: ProjectConfigurationRevisionRecord }
  | { outcome: "fetch_failed" }
  | { outcome: "superseded" };

export async function synchronizeGitHubProjectConfiguration(input: {
  database: Database;
  client: Pick<GitHubConfigurationProvider, "readFileAtCommit">;
  projectId: string;
  githubConnectionId: string;
  githubRepositoryId: number;
  githubRepositoryFullName: string;
  githubDefaultBranch: string;
  installationId: number;
  repositoryId: number;
  commitSha: string;
  path: string;
  webhookDeliveryId: string | null;
}): Promise<GitHubConfigurationSyncResult> {
  let file: { rawYaml: string } | undefined;
  try {
    file = await input.client.readFileAtCommit({
      installationId: input.installationId,
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      path: input.path,
    });
  } catch (error) {
    await recordAttempt(input, "fetch_failed", {
      reason: error instanceof Error ? error.message : "github_file_fetch_failed",
    });
    return { outcome: "fetch_failed" };
  }
  if (file === undefined) {
    await recordAttempt(input, "fetch_failed", { reason: "file_not_found_at_commit" });
    return { outcome: "fetch_failed" };
  }

  let rawConfiguration: unknown;
  try {
    rawConfiguration = load(file.rawYaml);
  } catch (error) {
    const revision = await input.database.insertProjectConfigurationRevision({
      projectId: input.projectId,
      sourceKind: "github",
      sourceEvidence: sourceEvidence(input),
      rawYaml: file.rawYaml,
      normalizedConfiguration: null,
      validationErrors: {
        formErrors: [error instanceof Error ? error.message : "invalid_yaml"],
      },
      contentHash: configurationHash(file.rawYaml),
    });
    await recordAttempt(input, "invalid", { revisionId: revision.id, stage: "yaml" });
    return { outcome: "invalid", revision };
  }

  const store = new ProjectConfigurationStore(input.database, input.projectId);
  const revision = await store.insertGitHubRevision({
    rawYaml: file.rawYaml,
    rawConfiguration,
    githubConnectionId: input.githubConnectionId,
    githubRepositoryId: input.repositoryId,
    githubRepositoryFullName: input.githubRepositoryFullName,
    githubDefaultBranch: input.githubDefaultBranch,
    commitSha: input.commitSha,
    path: input.path,
    webhookDeliveryId: input.webhookDeliveryId,
  });
  if (revision.validationErrors !== null) {
    await recordAttempt(input, "invalid", { revisionId: revision.id, stage: "validation" });
    return { outcome: "invalid", revision };
  }
  const activated = await store.activate(revision.id);
  await recordAttempt(input, "activated", { revisionId: activated.revision.id });
  return { outcome: "activated", revision: activated.revision };
}

export async function synchronizeGitHubDefaultBranch(input: {
  database: Database;
  client: GitHubConfigurationProvider;
  projectId: string;
  repositoryId?: number;
  expectedCommitSha?: string;
  webhookDeliveryId: string | null;
}): Promise<GitHubConfigurationSyncResult | undefined> {
  const target = await input.database.findGitHubConfigurationTarget(
    input.projectId,
    input.repositoryId,
  );
  if (target === undefined || !target.automaticDeploymentEnabled) return undefined;
  let branchHead: string;
  try {
    branchHead = await input.client.readDefaultBranchHead({
      installationId: target.installationId,
      repositoryId: target.repositoryId,
      defaultBranch: target.defaultBranch,
    });
  } catch (error) {
    await input.database.recordConfigurationSyncAttempt({
      projectId: input.projectId,
      githubConnectionId: target.connectionId,
      githubRepositoryId: target.repositoryId,
      webhookDeliveryId: input.webhookDeliveryId,
      commitSha: input.expectedCommitSha ?? "unknown",
      outcome: "fetch_failed",
      evidence: {
        stage: "default_branch_head",
        reason: error instanceof Error ? error.message : "github_branch_head_fetch_failed",
      },
    });
    return { outcome: "fetch_failed" };
  }
  if (input.expectedCommitSha !== undefined && branchHead !== input.expectedCommitSha) {
    await input.database.recordConfigurationSyncAttempt({
      projectId: input.projectId,
      githubConnectionId: target.connectionId,
      githubRepositoryId: target.repositoryId,
      webhookDeliveryId: input.webhookDeliveryId,
      commitSha: input.expectedCommitSha,
      outcome: "superseded",
      evidence: { branchHead },
    });
    return { outcome: "superseded" };
  }
  return synchronizeGitHubProjectConfiguration({
    database: input.database,
    client: input.client,
    projectId: input.projectId,
    githubConnectionId: target.connectionId,
    githubRepositoryId: target.repositoryId,
    githubRepositoryFullName: target.fullName,
    githubDefaultBranch: target.defaultBranch,
    installationId: target.installationId,
    repositoryId: target.repositoryId,
    commitSha: branchHead,
    path: ".paseo/hub.yml",
    webhookDeliveryId: input.webhookDeliveryId,
  });
}

function sourceEvidence(input: {
  githubConnectionId: string;
  githubRepositoryId: number;
  githubRepositoryFullName: string;
  githubDefaultBranch: string;
  commitSha: string;
  path: string;
  webhookDeliveryId: string | null;
}) {
  return {
    kind: "github",
    githubConnectionId: input.githubConnectionId,
    githubRepositoryId: input.githubRepositoryId,
    githubRepositoryFullName: input.githubRepositoryFullName,
    githubDefaultBranch: input.githubDefaultBranch,
    commitSha: input.commitSha,
    path: input.path,
    webhookDeliveryId: input.webhookDeliveryId,
  };
}

async function recordAttempt(
  input: {
    database: Database;
    projectId: string;
    githubConnectionId: string;
    githubRepositoryId: number;
    commitSha: string;
    webhookDeliveryId: string | null;
  },
  outcome: "activated" | "invalid" | "fetch_failed",
  evidence: unknown,
) {
  return input.database.recordConfigurationSyncAttempt({
    projectId: input.projectId,
    githubConnectionId: input.githubConnectionId,
    githubRepositoryId: input.githubRepositoryId,
    webhookDeliveryId: input.webhookDeliveryId,
    commitSha: input.commitSha,
    outcome,
    evidence,
  });
}
