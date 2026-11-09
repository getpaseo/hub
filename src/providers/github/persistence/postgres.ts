import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  consumeLockedAttempt,
  lockAccountSession,
  lockAttempt,
  lockExternal,
  lockProviderApplication,
  lockStartAuthority,
  lockStoredAuthority,
  requireCurrentAttempt,
  uniqueConnectionSlug,
} from "../../../db/connections.js";
import { ConnectionAccessDeniedError, ConnectionConflictError } from "../../../db/errors.js";
import type { PostgresProviderContext } from "../../../db/provider-persistence.js";
import type {
  DatabaseRuntime,
  DrizzleHandle,
  QueryHandle,
  QueryRow,
} from "../../../db/runtime/index.js";
import type { Locks } from "../../../db/runtime/locks/index.js";
import * as schema from "../../../db/schema.js";
import { claimProviderReceipt } from "../../../db/trigger-acceptance.js";
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
  ProviderEventAcceptance,
} from "../../../db/types.js";
type HubTransaction = DrizzleHandle;
export class GitHubPostgresPersistence {
  private readonly database: DrizzleHandle;
  private readonly runtime: DatabaseRuntime;
  private readonly pool: DatabaseRuntime;
  private readonly locks: Locks;
  private readonly events: PostgresProviderContext["events"];
  constructor(context: PostgresProviderContext) {
    this.runtime = context.runtime;
    this.pool = context.runtime;
    this.locks = context.locks;
    this.events = context.events;
    this.database = this.runtime.drizzle();
  }
  async advanceGitHubConnectionAttempt(input: AdvanceGitHubConnectionAttemptInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, attempt.provider);
      await requireCurrentAttempt(transaction, attempt);
      await transaction
        .update(schema.organizationConnectionAttempts)
        .set({
          phase: "github_user_authorization",
          stateVerifier: input.nextStateVerifier,
          candidateExternalId: String(input.installationId),
          pkceVerifier: input.pkceVerifier,
        })
        .where(eq(schema.organizationConnectionAttempts.id, attempt.id));
    });
  }
  async bindGitHubConnection(input: BindGitHubConnectionInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, "github");
      await requireCurrentAttempt(transaction, attempt, input.providerApplicationId);
      await lockExternal(this.locks, runtimeTransaction, "github", String(input.installationId));
      const [existing] = await transaction
        .select({
          id: schema.githubConnections.id,
          organizationId: schema.githubConnections.organizationId,
          slug: schema.githubConnections.slug,
        })
        .from(schema.githubConnections)
        .where(eq(schema.githubConnections.installationId, input.installationId))
        .for("update");
      if (existing !== undefined && existing.organizationId !== attempt.organizationId)
        throw new ConnectionConflictError();
      const [connection] =
        existing === undefined
          ? await transaction
              .insert(schema.githubConnections)
              .values({
                organizationId: attempt.organizationId,
                installationId: input.installationId,
                providerApplicationId: input.providerApplicationId,
                slug: await uniqueConnectionSlug(
                  transaction,
                  attempt.organizationId,
                  "github",
                  input.accountLogin,
                ),
                accountId: input.accountId,
                accountLogin: input.accountLogin,
                accountType: input.accountType,
                status: input.status,
                connectedByUserId: attempt.userId,
                suspendedAt: input.status === "suspended" ? sql`clock_timestamp()` : null,
              })
              .returning({ id: schema.githubConnections.id })
          : await transaction
              .update(schema.githubConnections)
              .set({
                accountId: input.accountId,
                accountLogin: input.accountLogin,
                accountType: input.accountType,
                status: input.status,
                suspendedAt: input.status === "suspended" ? sql`clock_timestamp()` : null,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(eq(schema.githubConnections.id, existing.id))
              .returning({ id: schema.githubConnections.id });
      if (connection === undefined) throw new Error("GitHub connection unavailable");
      await replaceGitHubRepositories(
        transaction,
        attempt.organizationId,
        connection.id,
        input.repositories,
      );
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }
  async findGitHubConnection(installationId: number): Promise<GitHubConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.githubConnections)
      .where(eq(schema.githubConnections.installationId, installationId))
      .limit(1);
    return row === undefined ? undefined : githubConnection(row);
  }
  private async removeGitHubByInstallationInTransaction(
    transaction: HubTransaction,
    installationId: number,
  ): Promise<void> {
    const [connection] = await transaction
      .select({ id: schema.githubConnections.id })
      .from(schema.githubConnections)
      .where(eq(schema.githubConnections.installationId, installationId))
      .for("update");
    if (connection === undefined) return;
    await clearGitHubConnectionReferences(transaction, connection.id);
    await transaction
      .delete(schema.githubConnections)
      .where(eq(schema.githubConnections.id, connection.id));
  }
  async disconnectConnection(connectionId: string, access: ConnectionStartAuthority) {
    const provider = "github" as const;
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockStartAuthority(transaction, access);
      const [connection] = await transaction
        .select({ id: schema.githubConnections.id })
        .from(schema.githubConnections)
        .where(
          and(
            eq(schema.githubConnections.id, connectionId),
            eq(schema.githubConnections.organizationId, access.organizationId),
          ),
        )
        .for("update");
      if (connection === undefined) throw new ConnectionAccessDeniedError();
      await clearGitHubConnectionReferences(transaction, connectionId);
      await transaction
        .delete(schema.githubConnections)
        .where(eq(schema.githubConnections.id, connectionId));
      return { provider } as const;
    });
  }
  async listConnections(organizationId?: string) {
    const rows = await this.database
      .select()
      .from(schema.githubConnections)
      .where(
        organizationId === undefined
          ? undefined
          : eq(schema.githubConnections.organizationId, organizationId),
      )
      .orderBy(schema.githubConnections.accountLogin, schema.githubConnections.id);
    return rows.map((row) => githubConnection(row));
  }
  acceptGitHubEvent(input: AcceptGitHubEventInput): Promise<ProviderEventAcceptance> {
    const externalId = input.installationId;
    return this.events.acceptProvider("github", input.repositoryId, input, async (transaction) => {
      const [row] = await transaction
        .select({
          id: schema.githubConnections.id,
          organizationId: schema.githubConnections.organizationId,
          status: schema.githubConnections.status,
        })
        .from(schema.githubConnections)
        .where(eq(schema.githubConnections.installationId, externalId))
        .limit(1);
      return row === undefined ? undefined : { ...row, unavailable: row.status === "suspended" };
    });
  }
  claimGitHubLifecycleReceipt(
    input: GitHubLifecycleReceiptClaimInput,
  ): Promise<GitHubInstallationSyncClaim> {
    return this.database.transaction(async (transaction) => {
      const [connection] = await transaction
        .select()
        .from(schema.githubConnections)
        .where(
          and(
            eq(schema.githubConnections.installationId, input.installationId),
            eq(schema.githubConnections.providerApplicationId, input.providerApplicationId),
          ),
        );
      const [receipt] = await transaction
        .insert(schema.githubInstallationSyncs)
        .values({
          ...input,
          kind: "webhook",
          connectionId: connection?.id ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (receipt === undefined) {
        const [existing] = await transaction
          .select()
          .from(schema.githubInstallationSyncs)
          .where(
            or(
              eq(schema.githubInstallationSyncs.deliveryId, input.deliveryId),
              eq(schema.githubInstallationSyncs.signatureHash, input.signatureHash),
            ),
          );
        if (existing === undefined) throw new Error("GitHub lifecycle receipt unavailable");
        return { status: "duplicate", installationSyncId: existing.id };
      }
      if (connection !== undefined) await auditGitHubLifecycle(transaction, receipt, connection);
      return {
        status: "claimed",
        installationSyncId: receipt.id,
        installationId: input.installationId,
      };
    });
  }
  applyGitHubInstallationSync(
    owner: GitHubInstallationSyncOwner,
    claim: Extract<GitHubInstallationSyncClaim, { status: "claimed" }>,
    result: GitHubInstallationSyncResult,
  ): Promise<void> {
    return this.runtime.transaction(async (runtimeTransaction) => {
      await this.locks.withTxLock(
        runtimeTransaction,
        JSON.stringify(["provider-application", "github"]),
      );
      const transaction = runtimeTransaction.drizzle();
      if (!(await githubSyncOwnerActive(transaction, owner))) return;
      const [receipt] = await transaction
        .select()
        .from(schema.githubInstallationSyncs)
        .where(
          and(
            eq(schema.githubInstallationSyncs.id, claim.installationSyncId),
            isNotNull(schema.githubInstallationSyncs.retryAt),
          ),
        )
        .for("update");
      if (
        receipt === undefined ||
        (receipt.providerApplicationId !== null &&
          receipt.providerApplicationId !== owner.providerApplicationId)
      )
        return;
      const [connection] = await transaction
        .select()
        .from(schema.githubConnections)
        .where(
          and(
            eq(schema.githubConnections.installationId, receipt.installationId),
            receipt.connectionId === null
              ? undefined
              : eq(schema.githubConnections.id, receipt.connectionId),
          ),
        )
        .for("update");
      if (
        connection !== undefined &&
        connection.providerApplicationId !== owner.providerApplicationId
      )
        return;
      if (connection === undefined && receipt.connectionId === null) return;
      await transaction
        .update(schema.githubInstallationSyncs)
        .set({
          retryAt: null,
          connectionId: connection?.id ?? receipt.connectionId,
          providerApplicationId: owner.providerApplicationId,
        })
        .where(eq(schema.githubInstallationSyncs.id, receipt.id));
      if (connection === undefined) return;
      await auditGitHubLifecycle(transaction, receipt, connection);
      if (result.status === "absent") {
        if (result.removeBinding)
          await this.removeGitHubByInstallationInTransaction(transaction, receipt.installationId);
        return;
      }
      await transaction
        .update(schema.githubConnections)
        .set({
          accountId: result.identity.accountId,
          accountLogin: result.identity.accountLogin,
          accountType: result.identity.accountType,
          status: result.identity.status,
          suspendedAt: result.identity.status === "suspended" ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(schema.githubConnections.id, connection.id));
      await replaceGitHubRepositories(
        transaction,
        connection.organizationId,
        connection.id,
        result.repositories,
      );
    });
  }
  async pendingGitHubInstallationSyncs(owner: GitHubInstallationSyncOwner) {
    if (!(await githubSyncOwnerActive(this.database, owner))) return [];
    const rows = await this.database
      .select({
        installationSyncId: schema.githubInstallationSyncs.id,
        installationId: schema.githubInstallationSyncs.installationId,
        source: schema.githubInstallationSyncs.source,
        kind: schema.githubInstallationSyncs.kind,
      })
      .from(schema.githubInstallationSyncs)
      .leftJoin(
        schema.githubConnections,
        eq(schema.githubConnections.installationId, schema.githubInstallationSyncs.installationId),
      )
      .where(
        and(
          lte(schema.githubInstallationSyncs.retryAt, new Date()),
          or(
            eq(schema.githubInstallationSyncs.providerApplicationId, owner.providerApplicationId),
            and(
              eq(schema.githubInstallationSyncs.kind, "reconcile"),
              isNull(schema.githubInstallationSyncs.providerApplicationId),
              eq(schema.githubConnections.providerApplicationId, owner.providerApplicationId),
            ),
          ),
          or(
            eq(schema.githubConnections.providerApplicationId, owner.providerApplicationId),
            isNotNull(schema.githubInstallationSyncs.connectionId),
          ),
        ),
      )
      .orderBy(schema.githubInstallationSyncs.retryAt)
      .limit(20);
    return rows.map((row) => ({
      status: "claimed" as const,
      installationSyncId: row.installationSyncId,
      installationId: row.installationId,
      removeBinding: row.kind === "reconcile" || row.source === "github.installation",
    }));
  }
  async retryGitHubInstallationSync(
    owner: GitHubInstallationSyncOwner,
    installationSyncId: string,
  ): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      await this.locks.withTxLock(
        runtimeTransaction,
        JSON.stringify(["provider-application", "github"]),
      );
      const transaction = runtimeTransaction.drizzle();
      if (!(await githubSyncOwnerActive(transaction, owner))) return;
      await transaction
        .update(schema.githubInstallationSyncs)
        .set({ retryAt: sql`clock_timestamp() + interval '30 seconds'` })
        .where(
          and(
            eq(schema.githubInstallationSyncs.id, installationSyncId),
            isNotNull(schema.githubInstallationSyncs.retryAt),
          ),
        );
    });
  }
  synchronizeGitHubInstallation<T>(
    installationId: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.locks.withLock(
      JSON.stringify(["github-installation-sync", installationId]),
      operation,
    );
  }
  async listGitHubRepositories(organizationId?: string): Promise<GitHubRepositoryRecord[]> {
    const rows = await query<GitHubRepositoryRow>(
      this.pool,
      `select repository.id, repository.organization_id, repository.connection_id,
              connection.installation_id, repository.repository_id,
              repository.full_name, repository.default_branch
       from github_repositories repository
       join github_connections connection on connection.id = repository.connection_id
       where repository.organization_id = $1
       order by repository.full_name, repository.id`,
      [organizationId ?? null],
    );
    return rows.rows.map(toGitHubRepositoryRecord);
  }
  async findGitHubRepositoryForOrganization(organizationId: string, fullName: string) {
    const rows = await query<GitHubRepositoryRow>(
      this.pool,
      `select repository.id, repository.organization_id, repository.connection_id,
              connection.installation_id, repository.repository_id,
              repository.full_name, repository.default_branch
       from github_repositories repository
       join github_connections connection on connection.id = repository.connection_id
       where repository.organization_id = $1 and repository.full_name = $2
       order by repository.id limit 2`,
      [organizationId, fullName],
    );
    if (rows.rows.length > 1) throw new Error("github repository resource is ambiguous");
    return rows.rows[0] === undefined ? undefined : toGitHubRepositoryRecord(rows.rows[0]);
  }
  async findGitHubConfigurationTarget(
    projectId: string,
    repositoryId?: number,
  ): Promise<GitHubConfigurationTarget | undefined> {
    const rows = await query<GitHubConfigurationTargetRow>(
      this.pool,
      `select project.id as project_id,
              repository.id, repository.organization_id, repository.connection_id,
              connection.installation_id,
              repository.repository_id, repository.full_name, repository.default_branch,
              source.automatic_deployment_enabled
       from project_configuration_sources source
       join projects project on project.id = source.project_id and project.status = 'active'
       join github_repositories repository
         on repository.organization_id = project.organization_id
        and repository.connection_id = source.github_connection_id
        and repository.repository_id = source.github_repository_id
       join github_connections connection on connection.id = repository.connection_id
       where source.project_id = $1 and source.kind = 'github'
         and ($2::bigint is null or repository.repository_id = $2)
       limit 1`,
      [projectId, repositoryId ?? null],
    );
    const row = rows.rows[0];
    return row === undefined
      ? undefined
      : {
          ...toGitHubRepositoryRecord(row),
          projectId: row.project_id,
          installationId: Number(row.installation_id),
          automaticDeploymentEnabled: row.automatic_deployment_enabled,
        };
  }
  async listGitHubConfigurationTargets(
    organizationId: string,
    connectionId: string,
    repositoryId: number,
  ): Promise<GitHubConfigurationTarget[]> {
    const rows = await query<GitHubConfigurationTargetRow>(
      this.pool,
      `select project.id as project_id,
              repository.id, repository.organization_id, repository.connection_id,
              connection.installation_id,
              repository.repository_id, repository.full_name, repository.default_branch,
              source.automatic_deployment_enabled
       from project_configuration_sources source
       join projects project
         on project.id = source.project_id
        and project.organization_id = $1
        and project.status = 'active'
       join github_repositories repository
         on repository.organization_id = project.organization_id
        and repository.connection_id = source.github_connection_id
        and repository.repository_id = source.github_repository_id
       join github_connections connection
         on connection.id = repository.connection_id
        and connection.organization_id = project.organization_id
       where source.kind = 'github'
         and source.github_connection_id = $2
         and source.github_repository_id = $3
       order by project.id`,
      [organizationId, connectionId, repositoryId],
    );
    return rows.rows.map((row) =>
      Object.assign(toGitHubRepositoryRecord(row), {
        projectId: row.project_id,
        installationId: Number(row.installation_id),
        automaticDeploymentEnabled: row.automatic_deployment_enabled,
      }),
    );
  }
}
function githubConnection(
  row: typeof schema.githubConnections.$inferSelect,
): GitHubConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    installationId: row.installationId,
    accountId: row.accountId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    status: row.status,
    providerApplicationId: row.providerApplicationId,
  };
}
async function clearGitHubConnectionReferences(
  transaction: HubTransaction,
  connectionId: string,
): Promise<void> {
  await transaction
    .update(schema.projectConfigurationSources)
    .set({
      kind: "manual",
      githubConnectionId: null,
      githubRepositoryId: null,
      githubRepositoryFullName: null,
      githubDefaultBranch: null,
      automaticDeploymentEnabled: false,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(schema.projectConfigurationSources.githubConnectionId, connectionId));
  await transaction
    .delete(schema.projectTriggerRoutes)
    .where(eq(schema.projectTriggerRoutes.connectionId, connectionId));
  await transaction
    .update(schema.configurationSyncAttempts)
    .set({ githubConnectionId: null })
    .where(eq(schema.configurationSyncAttempts.githubConnectionId, connectionId));
}
export async function replaceGitHubRepositories(
  transaction: DrizzleHandle,
  organizationId: string,
  connectionId: string,
  repositories: import("../../../db/types.js").GitHubRepositorySnapshot,
): Promise<void> {
  const ids = repositories.map((repository) => repository.repositoryId);
  await transaction
    .delete(schema.githubRepositories)
    .where(
      and(
        eq(schema.githubRepositories.connectionId, connectionId),
        ids.length === 0 ? undefined : sql`${schema.githubRepositories.repositoryId} not in ${ids}`,
      ),
    );
  if (repositories.length === 0) return;
  await transaction
    .insert(schema.githubRepositories)
    .values(
      repositories.map((repository) => ({
        organizationId,
        connectionId,
        ...repository,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.githubRepositories.connectionId, schema.githubRepositories.repositoryId],
      set: {
        fullName: sql`excluded.full_name`,
        defaultBranch: sql`excluded.default_branch`,
        updatedAt: sql`clock_timestamp()`,
      },
    });
}
const GITHUB_LIFECYCLE = "github_lifecycle";
async function auditGitHubLifecycle(
  transaction: HubTransaction,
  receipt: typeof schema.githubInstallationSyncs.$inferSelect,
  connection: typeof schema.githubConnections.$inferSelect,
): Promise<void> {
  if (receipt.kind === "reconcile") return;
  if (
    receipt.deliveryId === null ||
    receipt.signatureHash === null ||
    receipt.source === null ||
    receipt.providerApplicationId === null
  )
    throw new Error("GitHub webhook receipt evidence unavailable");
  await claimProviderReceipt(transaction, {
    organizationId: connection.organizationId,
    provider: "github",
    connectionId: connection.id,
    resourceId: null,
    input: {
      providerApplicationId: receipt.providerApplicationId,
      deliveryId: receipt.deliveryId,
      signatureHash: receipt.signatureHash,
      source: receipt.source,
      payload: receipt.payload,
      receivedAt: receipt.receivedAt,
      dropReason: GITHUB_LIFECYCLE,
    },
  });
}
async function githubSyncOwnerActive(
  database: DrizzleHandle,
  owner: GitHubInstallationSyncOwner,
): Promise<boolean> {
  const [activation] = await database
    .select({ provider: schema.runtimeProviderActivations.provider })
    .from(schema.runtimeProviderActivations)
    .where(
      and(
        eq(schema.runtimeProviderActivations.provider, "github"),
        eq(schema.runtimeProviderActivations.providerApplicationId, owner.providerApplicationId),
        eq(schema.runtimeProviderActivations.configurationVersion, owner.configurationVersion),
      ),
    );
  return activation !== undefined;
}
async function query<T extends QueryRow = QueryRow>(
  pool: QueryHandle,
  text: string,
  values: unknown[] = [],
) {
  return pool.query<T>(text, values);
}
interface GitHubRepositoryRow extends QueryRow {
  id: string;
  organization_id: string;
  connection_id: string;
  installation_id: number | string;
  repository_id: number | string;
  full_name: string;
  default_branch: string;
}
interface GitHubConfigurationTargetRow extends GitHubRepositoryRow {
  project_id: string;
  automatic_deployment_enabled: boolean;
}
function toGitHubRepositoryRecord(row: GitHubRepositoryRow): GitHubRepositoryRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    connectionId: row.connection_id,
    repositoryId: Number(row.repository_id),
    fullName: row.full_name,
    defaultBranch: row.default_branch,
  };
}
