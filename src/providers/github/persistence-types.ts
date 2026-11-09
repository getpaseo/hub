import type { ProviderEventEvidence, ReadConnectionAttemptInput } from "../../db/types.js";

export interface GitHubRepositoryRecord {
  id: string;
  organizationId: string;
  connectionId: string;
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
}

export interface GitHubConfigurationTarget extends GitHubRepositoryRecord {
  projectId: string;
  installationId: number;
  automaticDeploymentEnabled: boolean;
}

export interface GitHubConnectionRecord {
  id: string;
  organizationId: string;
  slug: string;
  installationId: number;
  accountId: string;
  accountLogin: string;
  accountType: string;
  status: "active" | "suspended";
  providerApplicationId: string | null;
}

export interface AdvanceGitHubConnectionAttemptInput extends ReadConnectionAttemptInput {
  nextStateVerifier: string;
  installationId: number;
  pkceVerifier: string;
}

export type GitHubRepositorySnapshot = Pick<
  GitHubRepositoryRecord,
  "repositoryId" | "fullName" | "defaultBranch"
>[];

export interface BindGitHubConnectionInput extends ReadConnectionAttemptInput {
  repositories: GitHubRepositorySnapshot;
  providerApplicationId: string;
  installationId: number;
  accountId: string;
  accountLogin: string;
  accountType: string;
  status: "active" | "suspended";
}

export type GitHubLifecycleIdentity = Omit<
  GitHubConnectionRecord,
  "id" | "organizationId" | "installationId" | "slug" | "providerApplicationId"
>;

export interface AcceptGitHubEventInput extends ProviderEventEvidence {
  installationId: number;
  repositoryId?: number;
}

export interface GitHubInstallationSyncOwner {
  providerApplicationId: string;
  configurationVersion: number;
}

export interface GitHubLifecycleReceiptClaimInput {
  providerApplicationId: string;
  installationId: number;
  deliveryId: string;
  signatureHash: string;
  source: string;
  payload: unknown;
  receivedAt: Date;
}

export type GitHubInstallationSyncClaim =
  | { status: "claimed"; installationSyncId: string; installationId: number }
  | { status: "duplicate"; installationSyncId: string };

export type GitHubInstallationSyncResult =
  | { status: "absent"; removeBinding: boolean }
  | {
      status: "present";
      identity: GitHubLifecycleIdentity;
      repositories: GitHubRepositorySnapshot;
    };
