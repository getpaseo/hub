import { ProviderPersistence } from "../../db/provider-persistence.js";
import type * as Types from "../../db/types.js";
import type {
  AcceptGitHubEventInput,
  AdvanceGitHubConnectionAttemptInput,
  BindGitHubConnectionInput,
  GitHubConfigurationTarget,
  GitHubConnectionRecord,
  GitHubInstallationSyncClaim,
  GitHubInstallationSyncOwner,
  GitHubInstallationSyncResult,
  GitHubLifecycleReceiptClaimInput,
  GitHubRepositoryRecord,
} from "./persistence-types.js";
import { githubMemoryPersistence } from "./persistence/memory.js";
import { GitHubPostgresPersistence } from "./persistence/postgres.js";
import type * as Source from "./source-types.js";
export interface GitHubPersistence {
  setProjectGitHubConfigurationSource(
    input: Source.SetProjectGitHubConfigurationSourceInput,
  ): Promise<void>;
  recordConfigurationSyncAttempt(
    input: Source.RecordConfigurationSyncAttemptInput,
  ): Promise<Source.ConfigurationSyncAttemptRecord>;
  latestConfigurationSyncAttempt(
    projectId: string,
  ): Promise<Source.ConfigurationSyncAttemptRecord | null>;

  acceptGitHubEvent(input: AcceptGitHubEventInput): Promise<Types.ProviderEventAcceptance>;
  synchronizeGitHubInstallation<T>(installationId: number, operation: () => Promise<T>): Promise<T>;
  pendingGitHubInstallationSyncs(
    owner: GitHubInstallationSyncOwner,
  ): Promise<
    Array<Extract<GitHubInstallationSyncClaim, { status: "claimed" }> & { removeBinding: boolean }>
  >;
  claimGitHubLifecycleReceipt(
    input: GitHubLifecycleReceiptClaimInput,
  ): Promise<GitHubInstallationSyncClaim>;
  applyGitHubInstallationSync(
    owner: GitHubInstallationSyncOwner,
    claim: Extract<GitHubInstallationSyncClaim, { status: "claimed" }>,
    result: GitHubInstallationSyncResult,
  ): Promise<void>;
  retryGitHubInstallationSync(
    owner: GitHubInstallationSyncOwner,
    installationSyncId: string,
  ): Promise<void>;
  advanceGitHubConnectionAttempt(input: AdvanceGitHubConnectionAttemptInput): Promise<void>;
  bindGitHubConnection(input: BindGitHubConnectionInput): Promise<void>;
  findGitHubConnection(installationId: number): Promise<GitHubConnectionRecord | undefined>;
  listGitHubConfigurationTargets(
    organizationId: string,
    connectionId: string,
    repositoryId: number,
  ): Promise<GitHubConfigurationTarget[]>;
  listGitHubRepositories(organizationId?: string): Promise<GitHubRepositoryRecord[]>;
  findGitHubRepositoryForOrganization(
    organizationId: string,
    fullName: string,
  ): Promise<GitHubRepositoryRecord | undefined>;
  findGitHubConfigurationTarget(
    projectId: string,
    repositoryId?: number,
  ): Promise<GitHubConfigurationTarget | undefined>;
  listConnections(organizationId?: string): Promise<GitHubConnectionRecord[]>;
  disconnectConnection(
    connectionId: string,
    access: Types.ConnectionStartAuthority,
  ): Promise<{ provider: "github" }>;
}
const persistence = new ProviderPersistence<GitHubPersistence>({
  id: "github",
  postgres: (context) => new GitHubPostgresPersistence(context),
  memory: githubMemoryPersistence,
});
export function githubPersistence(
  database: Pick<Types.Database, "providerPersistence">,
): GitHubPersistence {
  return persistence.for(database);
}
