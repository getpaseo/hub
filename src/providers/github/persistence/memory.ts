import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MemoryProviderContext } from "../../../db/provider-persistence.js";
import type {
  AcceptGitHubEventInput,
  AdvanceGitHubConnectionAttemptInput,
  BindGitHubConnectionInput,
  ConnectionStartAuthority,
  GitHubConfigurationTarget,
  GitHubConnectionRecord,
  GitHubInstallationSyncClaim,
  GitHubInstallationSyncOwner,
  GitHubInstallationSyncResult,
  GitHubLifecycleReceiptClaimInput,
  GitHubRepositoryRecord,
  GitHubRepositorySnapshot,
  ProviderEventAcceptance,
} from "../../../db/types.js";
import { parseSourceState } from "../source-state.js";
import type {
  ConfigurationSyncAttemptRecord,
  RecordConfigurationSyncAttemptInput,
  SetProjectGitHubConfigurationSourceInput,
} from "../source-types.js";
const initialDataSchema = z
  .object({
    connections: z
      .array(
        z.object({
          id: z.string(),
          organizationId: z.string(),
          slug: z.string(),
          installationId: z.number(),
          accountId: z.string(),
          accountLogin: z.string(),
          accountType: z.string(),
          status: z.enum(["active", "suspended"]),
          providerApplicationId: z.string().nullable(),
        }),
      )
      .default([]),
    repositories: z
      .array(
        z.object({
          id: z.string(),
          organizationId: z.string(),
          connectionId: z.string(),
          repositoryId: z.number(),
          fullName: z.string(),
          defaultBranch: z.string(),
        }),
      )
      .default([]),
  })
  .default({ connections: [], repositories: [] });
export class GitHubMemoryPersistence {
  private readonly githubConnections = new Map<number, GitHubConnectionRecord>();
  private readonly githubRepositories = new Map<string, GitHubRepositoryRecord>();
  private readonly githubInstallationSyncs = new Map<
    string,
    GitHubLifecycleReceiptClaimInput & { connectionId: string | null; retryAt: number | null }
  >();
  private readonly githubSyncs = new Map<number, Promise<unknown>>();
  constructor(private readonly context: MemoryProviderContext) {
    const data = initialDataSchema.parse(context.initialData);
    for (const connection of data.connections)
      this.githubConnections.set(connection.installationId, connection);
    for (const repository of data.repositories)
      this.githubRepositories.set(repository.id, repository);
  }
  private readonly configurationSyncAttempts = new Map<string, ConfigurationSyncAttemptRecord[]>();
  async setProjectGitHubConfigurationSource(
    input: SetProjectGitHubConfigurationSourceInput,
  ): Promise<void> {
    const project = this.context.findProjectById(input.projectId);
    if (project?.status !== "active") throw new Error("project access denied");
    this.context.setConfigurationSource(input.projectId, {
      kind: "github",
      data: {
        github_connection_id: input.githubConnectionId,
        github_repository_id: input.githubRepositoryId,
        github_repository_full_name: input.githubRepositoryFullName,
        github_default_branch: input.githubDefaultBranch,
        automatic_deployment_enabled: input.automaticDeploymentEnabled,
      },
    });
  }
  async recordConfigurationSyncAttempt(
    input: RecordConfigurationSyncAttemptInput,
  ): Promise<ConfigurationSyncAttemptRecord> {
    const attempt: ConfigurationSyncAttemptRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      githubConnectionId: input.githubConnectionId,
      githubRepositoryId: input.githubRepositoryId,
      webhookDeliveryId: input.webhookDeliveryId,
      commitSha: input.commitSha,
      outcome: input.outcome,
      evidence: structuredClone(input.evidence),
      createdAt: this.context.now(),
    };
    const attempts = this.configurationSyncAttempts.get(input.projectId) ?? [];
    attempts.push(attempt);
    this.configurationSyncAttempts.set(input.projectId, attempts);
    return attempt;
  }
  latestConfigurationSyncAttempt(
    projectId: string,
  ): Promise<ConfigurationSyncAttemptRecord | null> {
    return Promise.resolve(this.configurationSyncAttempts.get(projectId)?.at(-1) ?? null);
  }
  private removeConnectionReferences(connectionId: string): void {
    for (const { projectId, source } of this.context.configurationSources()) {
      if (
        source.kind !== "github" ||
        parseSourceState(source.data).githubConnectionId !== connectionId
      )
        continue;
      this.context.setConfigurationSource(projectId, {
        kind: "manual",
        data: { formattingPreserved: false },
      });
    }
    for (const [projectId, attempts] of this.configurationSyncAttempts)
      this.configurationSyncAttempts.set(
        projectId,
        attempts.map((attempt) =>
          attempt.githubConnectionId === connectionId
            ? Object.assign({}, attempt, { githubConnectionId: null })
            : attempt,
        ),
      );
    this.context.removeConnectionReferences(connectionId);
  }
  async acceptGitHubEvent(input: AcceptGitHubEventInput): Promise<ProviderEventAcceptance> {
    const binding = await this.findGitHubConnection(input.installationId);
    const reason = githubDropReason(input, binding);
    return this.context.accept(
      "github",
      input,
      binding?.organizationId,
      binding?.id,
      input.repositoryId === undefined ? null : String(input.repositoryId),
      reason,
    );
  }
  async synchronizeGitHubInstallation<T>(
    installationId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.githubSyncs.get(installationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.githubSyncs.set(installationId, next);
    try {
      return await next;
    } finally {
      if (this.githubSyncs.get(installationId) === next) this.githubSyncs.delete(installationId);
    }
  }
  pendingGitHubInstallationSyncs(owner: GitHubInstallationSyncOwner) {
    return Promise.resolve(
      [...this.githubInstallationSyncs.entries()]
        .filter(
          ([, receipt]) =>
            receipt.providerApplicationId === owner.providerApplicationId &&
            receipt.retryAt !== null &&
            receipt.retryAt <= Date.now() &&
            (receipt.connectionId !== null || this.githubConnections.has(receipt.installationId)),
        )
        .map(([id, receipt]) => ({
          status: "claimed" as const,
          installationSyncId: id,
          installationId: receipt.installationId,
          removeBinding: receipt.source === "github.installation",
        })),
    );
  }
  async claimGitHubLifecycleReceipt(
    input: GitHubLifecycleReceiptClaimInput,
  ): Promise<GitHubInstallationSyncClaim> {
    const existing = [...this.githubInstallationSyncs.entries()].find(
      ([, receipt]) =>
        receipt.deliveryId === input.deliveryId || receipt.signatureHash === input.signatureHash,
    );
    if (existing !== undefined) return { status: "duplicate", installationSyncId: existing[0] };
    const connection = await this.findGitHubConnection(input.installationId);
    const id = randomUUID();
    this.githubInstallationSyncs.set(id, {
      ...input,
      connectionId: connection?.id ?? null,
      retryAt: Date.now(),
    });
    if (connection !== undefined)
      this.context.insertReceipt({
        organizationId: connection.organizationId,
        provider: "github",
        connectionId: connection.id,
        resourceId: null,
        input: { ...input, dropReason: "github_lifecycle" },
      });
    return { status: "claimed", installationSyncId: id, installationId: input.installationId };
  }
  async applyGitHubInstallationSync(
    owner: GitHubInstallationSyncOwner,
    claim: Extract<GitHubInstallationSyncClaim, { status: "claimed" }>,
    result: GitHubInstallationSyncResult,
  ): Promise<void> {
    const receipt = this.githubInstallationSyncs.get(claim.installationSyncId);
    if (
      receipt === undefined ||
      receipt.retryAt === null ||
      receipt.providerApplicationId !== owner.providerApplicationId
    )
      return;
    const connection = this.githubConnections.get(claim.installationId);
    if (connection === undefined && receipt.connectionId === null) return;
    receipt.retryAt = null;
    if (
      connection === undefined ||
      (receipt.connectionId !== null && receipt.connectionId !== connection.id)
    )
      return;
    receipt.connectionId = connection.id;
    if (
      this.context.findReceiptId(
        connection.organizationId,
        receipt.deliveryId,
        receipt.signatureHash,
      ) === undefined
    )
      this.context.insertReceipt({
        organizationId: connection.organizationId,
        provider: "github",
        connectionId: connection.id,
        resourceId: null,
        input: { ...receipt, dropReason: "github_lifecycle" },
      });
    if (result.status === "present") {
      this.githubConnections.set(claim.installationId, { ...connection, ...result.identity });
      await this.replaceGitHubRepositorySnapshot(connection, result.repositories);
      return;
    }
    if (!result.removeBinding) return;
    this.githubConnections.delete(claim.installationId);
    for (const [key, repository] of this.githubRepositories) {
      if (repository.connectionId === connection.id) this.githubRepositories.delete(key);
    }
    this.removeConnectionReferences(connection.id);
  }
  private async replaceGitHubRepositorySnapshot(
    connection: GitHubConnectionRecord,
    repositories: GitHubRepositorySnapshot,
  ): Promise<void> {
    for (const [key, repository] of this.githubRepositories) {
      if (
        repository.connectionId === connection.id &&
        !repositories.some((item) => item.repositoryId === repository.repositoryId)
      )
        this.githubRepositories.delete(key);
    }
    await this.upsertGitHubRepositories(connection.organizationId, connection.id, repositories);
  }
  retryGitHubInstallationSync(
    _owner: GitHubInstallationSyncOwner,
    installationSyncId: string,
  ): Promise<void> {
    const receipt = this.githubInstallationSyncs.get(installationSyncId);
    if (receipt !== undefined && receipt.retryAt !== null) receipt.retryAt = Date.now() + 30_000;
    return Promise.resolve();
  }
  advanceGitHubConnectionAttempt(_input: AdvanceGitHubConnectionAttemptInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }
  bindGitHubConnection(_input: BindGitHubConnectionInput): Promise<void> {
    return connectionPersistenceUnavailable();
  }
  findGitHubConnection(_installationId: number): Promise<GitHubConnectionRecord | undefined> {
    return Promise.resolve(this.githubConnections.get(_installationId));
  }
  async listGitHubRepositories(organizationId?: string) {
    return Array.from(this.githubRepositories.values()).filter(
      (repository) => organizationId === undefined || repository.organizationId === organizationId,
    );
  }
  async findGitHubRepositoryForOrganization(organizationId: string, fullName: string) {
    const rows = Array.from(this.githubRepositories.values()).filter(
      (repository) =>
        repository.organizationId === organizationId && repository.fullName === fullName,
    );
    if (rows.length > 1) throw new Error("github repository resource is ambiguous");
    return rows[0];
  }
  private async upsertGitHubRepositories(
    organizationId: string,
    connectionId: string,
    repositories: Array<
      Pick<GitHubRepositoryRecord, "repositoryId" | "fullName" | "defaultBranch">
    >,
  ) {
    for (const repository of repositories) {
      const id =
        this.githubRepositories.get(`${connectionId}:${repository.repositoryId}`)?.id ??
        randomUUID();
      this.githubRepositories.set(`${connectionId}:${repository.repositoryId}`, {
        id,
        organizationId,
        connectionId,
        ...repository,
      });
    }
  }
  async listConnections(organizationId?: string) {
    return Array.from(this.githubConnections.values()).filter(
      (connection) => organizationId === undefined || connection.organizationId === organizationId,
    );
  }
  disconnectConnection(_connectionId: string, _access: ConnectionStartAuthority): never {
    return connectionPersistenceUnavailable();
  }
  async findGitHubConfigurationTarget(
    projectId: string,
    repositoryId?: number,
  ): Promise<GitHubConfigurationTarget | undefined> {
    const stored = this.context.configurationSource(projectId);
    const source = stored?.kind === "github" ? parseSourceState(stored.data) : undefined;
    if (
      source === undefined ||
      source.kind !== "github" ||
      (repositoryId !== undefined && source.githubRepositoryId !== repositoryId)
    ) {
      return undefined;
    }
    const repository = Array.from(this.githubRepositories.values()).find(
      (candidate) =>
        candidate.connectionId === source.githubConnectionId &&
        candidate.repositoryId === source.githubRepositoryId,
    );
    const connection = Array.from(this.githubConnections.values()).find(
      (candidate) => candidate.id === source.githubConnectionId,
    );
    return repository === undefined || connection === undefined
      ? undefined
      : {
          ...repository,
          projectId,
          installationId: connection.installationId,
          automaticDeploymentEnabled: source.automaticDeploymentEnabled,
        };
  }
  async listGitHubConfigurationTargets(
    organizationId: string,
    connectionId: string,
    repositoryId: number,
  ): Promise<GitHubConfigurationTarget[]> {
    const result: GitHubConfigurationTarget[] = [];
    for (const { projectId, source: stored } of this.context.configurationSources()) {
      if (stored.kind !== "github") continue;
      const source = parseSourceState(stored.data);
      const project = this.context.findProjectById(projectId);
      if (project?.organizationId !== organizationId || project.status !== "active") continue;
      if (
        source.kind !== "github" ||
        source.githubConnectionId !== connectionId ||
        source.githubRepositoryId !== repositoryId
      )
        continue;
      const repository = Array.from(this.githubRepositories.values()).find(
        (candidate) =>
          candidate.connectionId === connectionId && candidate.repositoryId === repositoryId,
      );
      const connection = Array.from(this.githubConnections.values()).find(
        (candidate) => candidate.id === connectionId,
      );
      if (repository !== undefined && connection !== undefined)
        result.push({
          ...repository,
          projectId: project.id,
          installationId: connection.installationId,
          automaticDeploymentEnabled: source.automaticDeploymentEnabled,
        });
    }
    return result;
  }
}
function githubDropReason(
  input: AcceptGitHubEventInput,
  binding: GitHubConnectionRecord | undefined,
): string | undefined {
  if (input.dropReason !== undefined) return input.dropReason;
  if (binding === undefined) return "github_unbound";
  if (binding.status === "suspended") return "configuration_unavailable";
  return undefined;
}
function connectionPersistenceUnavailable(): never {
  throw new Error("connection persistence requires PostgreSQL");
}
export function githubMemoryPersistence(context: MemoryProviderContext) {
  return new GitHubMemoryPersistence(context);
}
