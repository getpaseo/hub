import { ProviderPersistence } from "../../db/provider-persistence.js";
import type * as Types from "../../db/types.js";
import { githubMemoryPersistence } from "./persistence/memory.js";
import { GitHubPostgresPersistence } from "./persistence/postgres.js";
export interface GitHubPersistence {
  acceptGitHubEvent(input: Types.AcceptGitHubEventInput): Promise<Types.ProviderEventAcceptance>;
  synchronizeGitHubInstallation<T>(installationId: number, operation: () => Promise<T>): Promise<T>;
  pendingGitHubInstallationSyncs(
    owner: Types.GitHubInstallationSyncOwner,
  ): Promise<
    Array<
      Extract<Types.GitHubInstallationSyncClaim, { status: "claimed" }> & { removeBinding: boolean }
    >
  >;
  claimGitHubLifecycleReceipt(
    input: Types.GitHubLifecycleReceiptClaimInput,
  ): Promise<Types.GitHubInstallationSyncClaim>;
  applyGitHubInstallationSync(
    owner: Types.GitHubInstallationSyncOwner,
    claim: Extract<Types.GitHubInstallationSyncClaim, { status: "claimed" }>,
    result: Types.GitHubInstallationSyncResult,
  ): Promise<void>;
  retryGitHubInstallationSync(
    owner: Types.GitHubInstallationSyncOwner,
    installationSyncId: string,
  ): Promise<void>;
  advanceGitHubConnectionAttempt(input: Types.AdvanceGitHubConnectionAttemptInput): Promise<void>;
  bindGitHubConnection(input: Types.BindGitHubConnectionInput): Promise<void>;
  findGitHubConnection(installationId: number): Promise<Types.GitHubConnectionRecord | undefined>;
  listGitHubConfigurationTargets(
    organizationId: string,
    connectionId: string,
    repositoryId: number,
  ): Promise<Types.GitHubConfigurationTarget[]>;
  listGitHubRepositories(organizationId?: string): Promise<Types.GitHubRepositoryRecord[]>;
  findGitHubRepositoryForOrganization(
    organizationId: string,
    fullName: string,
  ): Promise<Types.GitHubRepositoryRecord | undefined>;
  findGitHubConfigurationTarget(
    projectId: string,
    repositoryId?: number,
  ): Promise<Types.GitHubConfigurationTarget | undefined>;
  listConnections(organizationId?: string): Promise<Types.GitHubConnectionRecord[]>;
  disconnectConnection(
    connectionId: string,
    access: Types.ConnectionStartAuthority,
  ): Promise<Extract<Types.DisconnectConnectionResult, { provider: "github" }>>;
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
