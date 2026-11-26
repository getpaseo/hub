import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseRuntime, DrizzleHandle } from "./runtime/index.js";
import type { Locks } from "./runtime/locks/index.js";
import { ConnectionAccessDeniedError, ConnectionConflictError } from "./errors.js";
import {
  consumeLockedAttempt,
  externalIdentityId,
  lockAccountSession,
  lockAttempt,
  lockExternal,
  lockProviderApplication,
  lockStartAuthority,
  lockStoredAuthority,
  providerApplicationChanged,
  requireConsumableAttempt,
  requireCurrentAttempt,
  uniqueConnectionSlug,
  writeProviderActivation,
} from "./connections.js";
import * as schema from "./schema.js";
import type { ProviderEventAcceptanceRepository } from "./trigger-acceptance.js";
import type {
  AcceptIntegrationEventInput,
  BindIntegrationConnectionInput,
  BindIntegrationProviderConfigurationInput,
  ConnectionStartAuthority,
  IntegrationConnectionRecord,
  IntegrationConnectionRefreshOperation,
  IntegrationConnectionStatus,
  IntegrationStore,
  ProviderEventAcceptance,
  PublicIntegrationConnectionView,
} from "./types.js";

/**
 * Strips credentials at the database boundary before projecting a connection record to
 * browser, dashboard, or API surfaces.
 */
export function toPublicConnectionView(
  record: IntegrationConnectionRecord,
): PublicIntegrationConnectionView {
  const { credentials: _credentials, ...publicView } = record;
  return publicView;
}

export class IntegrationConnectionRepository implements IntegrationStore {
  private readonly database: DrizzleHandle;

  constructor(
    private readonly runtime: DatabaseRuntime,
    private readonly locks: Locks,
    private readonly triggerAcceptance: ProviderEventAcceptanceRepository,
  ) {
    this.database = runtime.drizzle();
  }

  async bind(input: BindIntegrationConnectionInput): Promise<IntegrationConnectionRecord> {
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      const context = await this.prepareBindContext(runtimeTransaction, transaction, input);
      await lockExternal(this.locks, runtimeTransaction, input.provider, input.externalId);

      const [existing] = await transaction
        .select()
        .from(schema.integrationConnections)
        .where(
          and(
            eq(schema.integrationConnections.provider, input.provider),
            eq(schema.integrationConnections.externalId, input.externalId),
          ),
        )
        .for("update");
      if (existing !== undefined && existing.organizationId !== context.organizationId) {
        throw new ConnectionConflictError();
      }

      const row =
        existing === undefined
          ? await insertIntegrationConnection(transaction, context, input)
          : await updateIntegrationConnection(
              transaction,
              existing.id,
              context.connectedByUserId,
              input,
            );

      if (input.providerConfiguration !== undefined) {
        await commitProviderConfiguration(
          transaction,
          input.provider,
          input.providerApplicationId,
          context.configurationVersion,
          input.providerConfiguration,
        );
      }

      if (context.attemptId !== undefined) {
        await consumeLockedAttempt(transaction, context.attemptId);
      }
      return toIntegrationConnectionRecord(row);
    });
  }

  async disconnect(
    provider: string,
    connectionId: string,
    access: ConnectionStartAuthority,
  ): Promise<IntegrationConnectionRecord> {
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockStartAuthority(transaction, access);
      const [connection] = await transaction
        .select()
        .from(schema.integrationConnections)
        .where(
          and(
            eq(schema.integrationConnections.id, connectionId),
            eq(schema.integrationConnections.provider, provider),
            eq(schema.integrationConnections.organizationId, access.organizationId),
          ),
        )
        .for("update");
      if (connection === undefined) throw new ConnectionAccessDeniedError();
      await transaction
        .delete(schema.projectTriggerRoutes)
        .where(eq(schema.projectTriggerRoutes.connectionId, connectionId));
      await transaction
        .delete(schema.organizationTriggerRoutes)
        .where(eq(schema.organizationTriggerRoutes.connectionId, connectionId));
      await transaction
        .delete(schema.integrationConnections)
        .where(eq(schema.integrationConnections.id, connectionId));
      return toIntegrationConnectionRecord(connection);
    });
  }

  async listForOrganization(
    organizationId: string,
    provider?: string,
  ): Promise<IntegrationConnectionRecord[]> {
    const predicate =
      provider === undefined
        ? eq(schema.integrationConnections.organizationId, organizationId)
        : and(
            eq(schema.integrationConnections.organizationId, organizationId),
            eq(schema.integrationConnections.provider, provider),
          );
    const rows = await this.database
      .select()
      .from(schema.integrationConnections)
      .where(predicate)
      .orderBy(
        asc(schema.integrationConnections.displayName),
        asc(schema.integrationConnections.id),
      );
    return rows.map(toIntegrationConnectionRecord);
  }

  async listByProvider(provider: string): Promise<IntegrationConnectionRecord[]> {
    const rows = await this.database
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.provider, provider))
      .orderBy(
        asc(schema.integrationConnections.displayName),
        asc(schema.integrationConnections.id),
      );
    return rows.map(toIntegrationConnectionRecord);
  }

  async findById(connectionId: string): Promise<IntegrationConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, connectionId))
      .limit(1);
    return row === undefined ? undefined : toIntegrationConnectionRecord(row);
  }

  async findBySlug(
    organizationId: string,
    provider: string,
    slug: string,
  ): Promise<IntegrationConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.integrationConnections)
      .where(
        and(
          eq(schema.integrationConnections.organizationId, organizationId),
          eq(schema.integrationConnections.provider, provider),
          eq(schema.integrationConnections.slug, slug),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : toIntegrationConnectionRecord(row);
  }

  async findByExternalIds(
    provider: string,
    externalIds: readonly string[],
  ): Promise<IntegrationConnectionRecord[]> {
    if (externalIds.length === 0) return [];
    const rows = await this.database
      .select()
      .from(schema.integrationConnections)
      .where(
        and(
          eq(schema.integrationConnections.provider, provider),
          inArray(schema.integrationConnections.externalId, [...externalIds]),
        ),
      )
      .orderBy(
        asc(schema.integrationConnections.displayName),
        asc(schema.integrationConnections.id),
      );
    return rows.map(toIntegrationConnectionRecord);
  }

  async findByWorkspaceId(
    provider: string,
    workspaceId: string,
  ): Promise<IntegrationConnectionRecord[]> {
    const rows = await this.database
      .select()
      .from(schema.integrationConnections)
      .where(
        and(
          eq(schema.integrationConnections.provider, provider),
          eq(schema.integrationConnections.workspaceId, workspaceId),
        ),
      )
      .orderBy(
        asc(schema.integrationConnections.displayName),
        asc(schema.integrationConnections.id),
      );
    return rows.map(toIntegrationConnectionRecord);
  }

  async updateStatus(connectionId: string, status: IntegrationConnectionStatus): Promise<void> {
    await this.database
      .update(schema.integrationConnections)
      .set({ status, updatedAt: sql`clock_timestamp()` })
      .where(eq(schema.integrationConnections.id, connectionId));
  }

  async withRefreshLock<T>(
    connectionId: string,
    operation: IntegrationConnectionRefreshOperation<T>,
  ): Promise<T> {
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await this.locks.withTxLock(
        runtimeTransaction,
        JSON.stringify(["paseo-integration-refresh", connectionId]),
      );
      const [row] = await transaction
        .select()
        .from(schema.integrationConnections)
        .where(eq(schema.integrationConnections.id, connectionId))
        .for("update");
      const connection = row === undefined ? undefined : toIntegrationConnectionRecord(row);
      return operation(connection, async (patch) => {
        if (connection === undefined) throw new Error("Integration connection unavailable");
        await transaction
          .update(schema.integrationConnections)
          .set({
            ...(patch.credentials === undefined ? {} : { credentials: { ...patch.credentials } }),
            ...(patch.metadata === undefined ? {} : { metadata: { ...patch.metadata } }),
            ...(patch.scopes === undefined ? {} : { scopes: [...patch.scopes] }),
            ...(patch.status === undefined ? {} : { status: patch.status }),
            ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
            ...(patch.workspaceId === undefined ? {} : { workspaceId: patch.workspaceId }),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.integrationConnections.id, connection.id));
      });
    });
  }

  acceptEvent(input: AcceptIntegrationEventInput): Promise<ProviderEventAcceptance> {
    return this.triggerAcceptance.acceptIntegration(input);
  }

  private async prepareBindContext(
    runtimeTransaction: Parameters<Parameters<DatabaseRuntime["transaction"]>[0]>[0],
    transaction: DrizzleHandle,
    input: BindIntegrationConnectionInput,
  ): Promise<{
    organizationId: string;
    connectedByUserId: string | null;
    attemptId?: string;
    configurationVersion: number;
  }> {
    if (input.attempt === undefined) {
      await lockProviderApplication(this.locks, runtimeTransaction, input.provider);
      const version =
        input.providerConfiguration?.configurationVersion ??
        (input.providerConfiguration?.expectedVersion ?? 0) + 1;
      return {
        organizationId: input.organizationId,
        connectedByUserId: input.connectedByUserId,
        configurationVersion: version,
      };
    }

    await lockAccountSession(transaction, input.attempt.access);
    const attempt = await lockAttempt(transaction, input.attempt);
    if (attempt.provider !== input.provider) throw providerApplicationChanged();
    await lockStoredAuthority(transaction, attempt);
    await lockProviderApplication(this.locks, runtimeTransaction, input.provider);

    if (input.providerConfiguration === undefined) {
      await requireCurrentAttempt(transaction, attempt, input.providerApplicationId);
    } else {
      await requireIntegrationActivationCandidate(
        transaction,
        attempt,
        input.provider,
        input.providerApplicationId,
        input.providerConfiguration,
      );
    }

    return {
      organizationId: attempt.organizationId,
      connectedByUserId: attempt.userId,
      attemptId: attempt.id,
      configurationVersion: attempt.configurationVersion,
    };
  }
}

async function requireIntegrationActivationCandidate(
  transaction: DrizzleHandle,
  attempt: typeof schema.organizationConnectionAttempts.$inferSelect,
  provider: string,
  bindingApplicationId: string,
  providerConfiguration: BindIntegrationProviderConfigurationInput,
): Promise<void> {
  await requireConsumableAttempt(transaction, attempt);
  if (
    attempt.providerApplicationId !== bindingApplicationId ||
    externalIdentityId(providerConfiguration.identity) !== bindingApplicationId ||
    attempt.configurationVersion !== (providerConfiguration.expectedVersion ?? 0) + 1
  ) {
    throw providerApplicationChanged();
  }
  const connections = await transaction
    .select({ applicationId: schema.integrationConnections.providerApplicationId })
    .from(schema.integrationConnections)
    .where(eq(schema.integrationConnections.provider, provider))
    .for("update");
  if (connections.some((connection) => connection.applicationId !== bindingApplicationId)) {
    throw providerApplicationChanged();
  }
}

async function insertIntegrationConnection(
  transaction: DrizzleHandle,
  context: { organizationId: string; connectedByUserId: string | null },
  input: BindIntegrationConnectionInput,
): Promise<typeof schema.integrationConnections.$inferSelect> {
  const slug = await uniqueConnectionSlug(
    transaction,
    context.organizationId,
    input.provider,
    input.displayName,
  );
  const [inserted] = await transaction
    .insert(schema.integrationConnections)
    .values({
      provider: input.provider,
      organizationId: context.organizationId,
      providerApplicationId: input.providerApplicationId,
      slug,
      externalId: input.externalId,
      displayName: input.displayName,
      status: input.status ?? "active",
      scopes: [...(input.scopes ?? [])],
      credentials: { ...input.credentials },
      metadata: { ...input.metadata },
      workspaceId: input.workspaceId ?? null,
      connectedByUserId: context.connectedByUserId,
    })
    .returning();
  if (inserted === undefined) throw new Error("integration connection insert failed");
  return inserted;
}

async function updateIntegrationConnection(
  transaction: DrizzleHandle,
  connectionId: string,
  connectedByUserId: string | null,
  input: BindIntegrationConnectionInput,
): Promise<typeof schema.integrationConnections.$inferSelect> {
  const [updated] = await transaction
    .update(schema.integrationConnections)
    .set({
      providerApplicationId: input.providerApplicationId,
      displayName: input.displayName,
      status: input.status ?? "active",
      scopes: [...(input.scopes ?? [])],
      credentials: { ...input.credentials },
      metadata: { ...input.metadata },
      workspaceId: input.workspaceId ?? null,
      connectedByUserId,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(schema.integrationConnections.id, connectionId))
    .returning();
  if (updated === undefined) throw new Error("integration connection update failed");
  return updated;
}

async function commitProviderConfiguration(
  transaction: DrizzleHandle,
  provider: string,
  providerApplicationId: string,
  configurationVersion: number,
  providerConfiguration: BindIntegrationProviderConfigurationInput,
): Promise<void> {
  const [stored] = await transaction
    .select({ version: schema.runtimeProviderConfiguration.version })
    .from(schema.runtimeProviderConfiguration)
    .where(eq(schema.runtimeProviderConfiguration.provider, provider))
    .for("update");
  if (stored?.version !== providerConfiguration.expectedVersion) {
    const error = new Error("provider configuration changed");
    error.name = "ProviderConfigurationConflictError";
    throw error;
  }
  if (stored === undefined) {
    await transaction.insert(schema.runtimeProviderConfiguration).values({
      provider,
      configuration: providerConfiguration.configuration,
      verifiedExternalIdentity: providerConfiguration.identity,
      version: 1,
      verifiedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
      updatedByUserId: providerConfiguration.updatedByUserId,
    });
  } else {
    await transaction
      .update(schema.runtimeProviderConfiguration)
      .set({
        configuration: providerConfiguration.configuration,
        verifiedExternalIdentity: providerConfiguration.identity,
        version: sql`${schema.runtimeProviderConfiguration.version} + 1`,
        verifiedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
        updatedByUserId: providerConfiguration.updatedByUserId,
      })
      .where(eq(schema.runtimeProviderConfiguration.provider, provider));
  }
  await writeProviderActivation(transaction, provider, providerApplicationId, configurationVersion);
}

function toIntegrationConnectionRecord(
  row: typeof schema.integrationConnections.$inferSelect,
): IntegrationConnectionRecord {
  return {
    id: row.id,
    provider: row.provider,
    organizationId: row.organizationId,
    providerApplicationId: row.providerApplicationId,
    slug: row.slug,
    externalId: row.externalId,
    displayName: row.displayName,
    status: row.status,
    scopes: [...row.scopes],
    credentials: { ...row.credentials },
    metadata: { ...row.metadata },
    workspaceId: row.workspaceId,
    connectedByUserId: row.connectedByUserId,
    connectedAt: row.connectedAt,
    updatedAt: row.updatedAt,
  };
}
