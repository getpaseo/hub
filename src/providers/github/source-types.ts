export interface ConfigurationSyncAttemptRecord {
  id: string;
  projectId: string;
  githubConnectionId: string | null;
  githubRepositoryId: number | null;
  webhookDeliveryId: string | null;
  commitSha: string | null;
  outcome: string;
  evidence: unknown;
  createdAt: Date;
}

export interface SetProjectGitHubConfigurationSourceInput {
  projectId: string;
  githubConnectionId: string;
  githubRepositoryId: number;
  githubRepositoryFullName: string;
  githubDefaultBranch: string;
  automaticDeploymentEnabled: boolean;
  userId: string;
}

export interface RecordConfigurationSyncAttemptInput {
  projectId: string;
  githubConnectionId: string;
  githubRepositoryId: number;
  webhookDeliveryId: string | null;
  commitSha: string;
  outcome: "activated" | "invalid" | "fetch_failed" | "superseded";
  evidence: unknown;
}
