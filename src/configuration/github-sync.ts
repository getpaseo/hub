import { load } from "js-yaml";
import { rawConfigurationHash } from "../config/compiler.js";
import {
  PromptPartialResolutionError,
  resolvePromptPartials,
  type PromptPartialReadResult,
  type ResolvedPromptPartials,
} from "../config/prompt-partials.js";
import type { Database, ProjectConfigurationRevisionRecord } from "../db/types.js";
import { ProjectConfigurationStore } from "./store.js";

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
  }): Promise<PromptPartialReadResult | undefined>;
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
  let file: PromptPartialReadResult | undefined;
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
  if (file.kind !== "file") {
    await recordAttempt(input, "fetch_failed", {
      reason: `configuration_file_is_not_regular_file:${file.kind}`,
    });
    return { outcome: "fetch_failed" };
  }

  let rawConfiguration: unknown;
  try {
    rawConfiguration = load(file.content);
  } catch (error) {
    const revision = await input.database.insertProjectConfigurationRevision({
      projectId: input.projectId,
      sourceKind: "github",
      sourceEvidence: sourceEvidence(input),
      rawYaml: file.content,
      normalizedConfiguration: null,
      validationErrors: {
        formErrors: [error instanceof Error ? error.message : "invalid_yaml"],
      },
      contentHash: rawConfigurationHash(file.content),
    });
    await recordAttempt(input, "invalid", { revisionId: revision.id, stage: "yaml" });
    return { outcome: "invalid", revision };
  }

  const store = new ProjectConfigurationStore(input.database, input.projectId);
  let resolvedPromptPartials: ResolvedPromptPartials;
  try {
    resolvedPromptPartials = await resolvePromptPartials({
      configuration: rawConfiguration,
      read: async (path) =>
        input.client.readFileAtCommit({
          installationId: input.installationId,
          repositoryId: input.repositoryId,
          commitSha: input.commitSha,
          path,
        }),
    });
  } catch (error) {
    if (!(error instanceof PromptPartialResolutionError)) {
      await recordAttempt(input, "fetch_failed", {
        stage: "partial",
        reason: formatSyncError(error),
      });
      return { outcome: "fetch_failed" };
    }
    const revision = await store.insertGitHubRevision({
      rawYaml: file.content,
      rawConfiguration,
      githubConnectionId: input.githubConnectionId,
      githubRepositoryId: input.repositoryId,
      githubRepositoryFullName: input.githubRepositoryFullName,
      githubDefaultBranch: input.githubDefaultBranch,
      commitSha: input.commitSha,
      path: input.path,
      webhookDeliveryId: input.webhookDeliveryId,
      validationErrors: { formErrors: [formatSyncError(error)] },
    });
    await recordAttempt(input, "invalid", { revisionId: revision.id, stage: "partials" });
    return { outcome: "invalid", revision };
  }
  const revision = await store.insertGitHubRevision({
    rawYaml: file.content,
    rawConfiguration,
    githubConnectionId: input.githubConnectionId,
    githubRepositoryId: input.repositoryId,
    githubRepositoryFullName: input.githubRepositoryFullName,
    githubDefaultBranch: input.githubDefaultBranch,
    commitSha: input.commitSha,
    path: input.path,
    webhookDeliveryId: input.webhookDeliveryId,
    resolvedPromptPartials,
  });
  if (revision.validationErrors !== null) {
    await recordAttempt(input, "invalid", { revisionId: revision.id, stage: "validation" });
    return { outcome: "invalid", revision };
  }
  const activated = await store.activate(revision.id);
  await recordAttempt(input, "activated", { revisionId: activated.revision.id });
  return { outcome: "activated", revision: activated.revision };
}

function formatSyncError(error: unknown): string {
  return error instanceof Error ? error.message : "invalid GitHub configuration content";
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
