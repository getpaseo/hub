import { HUB_RESOURCE_PATH, type HubBundleFile } from "../../config/bundle.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
export interface GitHubBundleRevisionInput {
  files: readonly HubBundleFile[];
  githubConnectionId: string;
  githubRepositoryId: number;
  githubRepositoryFullName: string;
  githubDefaultBranch: string;
  commitSha: string;
  webhookDeliveryId: string | null;
  validationErrors?: unknown;
}
export function insertGitHubBundleRevision(
  store: ProjectConfigurationStore,
  input: GitHubBundleRevisionInput,
) {
  return store.insertSourceBundleRevision({
    files: input.files,
    sourceKind: "github",
    sourceEvidence: {
      kind: "github",
      githubConnectionId: input.githubConnectionId,
      githubRepositoryId: input.githubRepositoryId,
      githubRepositoryFullName: input.githubRepositoryFullName,
      githubDefaultBranch: input.githubDefaultBranch,
      commitSha: input.commitSha,
      path: HUB_RESOURCE_PATH,
      webhookDeliveryId: input.webhookDeliveryId,
    },
    ...(input.validationErrors === undefined ? {} : { validationErrors: input.validationErrors }),
  });
}
