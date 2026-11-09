import type { ProviderConfigurationSource } from "../configuration-source.js";
import { githubPersistence } from "./persistence.js";
import { parseSourceState } from "./source-state.js";
export type {
  ConfigurationSyncAttemptRecord,
  RecordConfigurationSyncAttemptInput,
  SetProjectGitHubConfigurationSourceInput,
} from "./source-types.js";
export const configurationSource: ProviderConfigurationSource = {
  parseState: parseSourceState,
  async latestAttempt(database, projectId) {
    const attempt = await githubPersistence(database).latestConfigurationSyncAttempt(projectId);
    return attempt === null
      ? null
      : {
          id: attempt.id,
          commitSha: attempt.commitSha,
          outcome: attempt.outcome,
          createdAt: attempt.createdAt,
        };
  },
  async repositories(database, organizationId) {
    return (await githubPersistence(database).listGitHubRepositories(organizationId)).map(
      ({ id, connectionId, repositoryId, fullName, defaultBranch }) => ({
        id,
        connectionId,
        repositoryId,
        fullName,
        defaultBranch,
      }),
    );
  },
  async releaseToManual(transaction, projectId) {
    await transaction.query(
      "update project_configuration_sources set kind = 'manual', automatic_deployment_enabled = false, github_connection_id = null, github_repository_id = null, github_repository_full_name = null, github_default_branch = null where project_id = $1",
      [projectId],
    );
  },
};

export {
  insertGitHubBundleRevision,
  type GitHubBundleRevisionInput,
} from "./configuration-revisions.js";
export {
  synchronizeGitHubDefaultBranch,
  synchronizeGitHubProjectConfiguration,
  type GitHubConfigurationProvider,
  type GitHubConfigurationSyncResult,
} from "./configuration-sync.js";
