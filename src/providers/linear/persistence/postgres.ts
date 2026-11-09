import { and, eq, sql } from "drizzle-orm";
import {
  commitProviderApplication,
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
} from "../../../db/connections.js";
import { ConnectionAccessDeniedError, ConnectionConflictError } from "../../../db/errors.js";
import type { PostgresProviderContext } from "../../../db/provider-persistence.js";
import type { DatabaseRuntime, DrizzleHandle } from "../../../db/runtime/index.js";
import type { Locks } from "../../../db/runtime/locks/index.js";
import * as schema from "../../../db/schema.js";
import type {
  AcceptLinearEventInput,
  BindLinearConnectionInput,
  CompleteLinearProviderApplicationInput,
  ConnectionStartAuthority,
  LinearConnectionRecord,
  LinearConnectionRefreshOperation,
  ProviderEventAcceptance,
  UpdateLinearConnectionTokensInput,
} from "../../../db/types.js";
import { linearConnectionRequiresReauthorization } from "../client.js";
type HubTransaction = DrizzleHandle;
type AttemptRow = typeof schema.organizationConnectionAttempts.$inferSelect;
export class LinearPostgresPersistence {
  private readonly database: DrizzleHandle;
  private readonly runtime: DatabaseRuntime;
  private readonly locks: Locks;
  private readonly events: PostgresProviderContext["events"];
  constructor(context: PostgresProviderContext) {
    this.runtime = context.runtime;
    this.locks = context.locks;
    this.events = context.events;
    this.database = this.runtime.drizzle();
  }
  async bindLinearConnection(input: BindLinearConnectionInput): Promise<void> {
    await this.bindLinearTransition(input);
  }
  async completeLinearProviderApplication(
    input: CompleteLinearProviderApplicationInput,
  ): Promise<void> {
    await this.bindLinearTransition(input, input.providerConfiguration);
  }
  private async bindLinearTransition(
    input: BindLinearConnectionInput,
    providerConfiguration?: CompleteLinearProviderApplicationInput["providerConfiguration"],
  ): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, "linear");
      if (providerConfiguration === undefined) {
        await requireCurrentAttempt(transaction, attempt, input.providerApplicationId);
      } else {
        await requireLinearActivationCandidate(
          transaction,
          attempt,
          input.providerApplicationId,
          providerConfiguration,
        );
      }
      await lockExternal(this.locks, runtimeTransaction, "linear", input.linearOrganizationId);
      const [existing] = await transaction
        .select({
          id: schema.linearConnections.id,
          organizationId: schema.linearConnections.organizationId,
        })
        .from(schema.linearConnections)
        .where(eq(schema.linearConnections.linearOrganizationId, input.linearOrganizationId))
        .for("update");
      if (existing !== undefined && existing.organizationId !== attempt.organizationId) {
        throw new ConnectionConflictError();
      }
      if (existing === undefined) {
        await transaction.insert(schema.linearConnections).values({
          organizationId: attempt.organizationId,
          providerApplicationId: input.providerApplicationId,
          linearOrganizationId: input.linearOrganizationId,
          linearOrganizationName: input.linearOrganizationName,
          slug: await uniqueConnectionSlug(
            transaction,
            attempt.organizationId,
            "linear",
            input.linearOrganizationName,
          ),
          appUserId: input.appUserId,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken ?? null,
          accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
          scopes: input.scopes,
          connectedByUserId: attempt.userId,
        });
      } else {
        await transaction
          .update(schema.linearConnections)
          .set({
            providerApplicationId: input.providerApplicationId,
            linearOrganizationName: input.linearOrganizationName,
            appUserId: input.appUserId,
            accessToken: input.accessToken,
            refreshToken: input.refreshToken ?? null,
            accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
            scopes: input.scopes,
            connectedByUserId: attempt.userId,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.linearConnections.id, existing.id));
      }
      if (providerConfiguration !== undefined)
        await commitProviderApplication(
          transaction,
          "linear",
          providerConfiguration,
          input.providerApplicationId,
          attempt.configurationVersion,
        );
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }
  async updateLinearConnectionTokens(input: UpdateLinearConnectionTokensInput): Promise<void> {
    await this.database
      .update(schema.linearConnections)
      .set({
        accessToken: input.accessToken,
        ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
        ...(input.accessTokenExpiresAt === undefined
          ? {}
          : { accessTokenExpiresAt: input.accessTokenExpiresAt }),
        ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(schema.linearConnections.id, input.connectionId));
  }
  async withLinearConnectionRefresh<T>(
    linearOrganizationId: string,
    operation: LinearConnectionRefreshOperation<T>,
  ): Promise<T> {
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      // This is intentionally the same transaction-scoped identity lock as OAuth rebind. In
      // particular, do not use the session-lock API here: the re-read and write below must share
      // this transaction's client so waiters cannot starve the lock holder's pool query.
      await lockExternal(this.locks, runtimeTransaction, "linear", linearOrganizationId);
      const [row] = await transaction
        .select()
        .from(schema.linearConnections)
        .where(eq(schema.linearConnections.linearOrganizationId, linearOrganizationId))
        .for("update");
      const connection = row === undefined ? undefined : linearConnection(row);
      return operation(connection, async (input) => {
        if (connection === undefined) throw new Error("Linear connection unavailable");
        await transaction
          .update(schema.linearConnections)
          .set({
            accessToken: input.accessToken,
            ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
            ...(input.accessTokenExpiresAt === undefined
              ? {}
              : { accessTokenExpiresAt: input.accessTokenExpiresAt }),
            ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.linearConnections.id, connection.id));
      });
    });
  }
  async findLinearConnection(
    linearOrganizationId: string,
  ): Promise<LinearConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.linearConnections)
      .where(eq(schema.linearConnections.linearOrganizationId, linearOrganizationId))
      .limit(1);
    return row === undefined ? undefined : linearConnection(row);
  }
  async findLinearConnectionForOrganization(
    organizationId: string,
    linearOrganizationId: string,
  ): Promise<LinearConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.linearConnections)
      .where(
        and(
          eq(schema.linearConnections.organizationId, organizationId),
          eq(schema.linearConnections.linearOrganizationId, linearOrganizationId),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : linearConnection(row);
  }
  async disconnectConnection(connectionId: string, access: ConnectionStartAuthority) {
    const provider = "linear" as const;
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockStartAuthority(transaction, access);
      const [connection] = await transaction
        .select({
          linearOrganizationId: schema.linearConnections.linearOrganizationId,
          accessToken: schema.linearConnections.accessToken,
        })
        .from(schema.linearConnections)
        .where(
          and(
            eq(schema.linearConnections.id, connectionId),
            eq(schema.linearConnections.organizationId, access.organizationId),
          ),
        )
        .for("update");
      if (connection === undefined) throw new ConnectionAccessDeniedError();
      await transaction
        .delete(schema.projectTriggerRoutes)
        .where(eq(schema.projectTriggerRoutes.connectionId, connectionId));
      await transaction
        .delete(schema.linearConnections)
        .where(eq(schema.linearConnections.id, connectionId));
      return {
        provider,
        linearOrganizationId: connection.linearOrganizationId,
        accessToken: connection.accessToken,
      } as const;
    });
  }
  async listConnections(organizationId?: string) {
    const rows = await this.database
      .select()
      .from(schema.linearConnections)
      .where(
        organizationId === undefined
          ? undefined
          : eq(schema.linearConnections.organizationId, organizationId),
      )
      .orderBy(schema.linearConnections.linearOrganizationName, schema.linearConnections.id);
    return rows.map((row) =>
      Object.assign(linearConnection(row), { scopes: stringArray(row.scopes) }),
    );
  }
  acceptLinearEvent(input: AcceptLinearEventInput): Promise<ProviderEventAcceptance> {
    const externalId = input.linearOrganizationId;
    return this.events.acceptProvider("linear", input.projectId, input, async (transaction) => {
      const [row] = await transaction
        .select({
          id: schema.linearConnections.id,
          organizationId: schema.linearConnections.organizationId,
          scopes: schema.linearConnections.scopes,
          refreshToken: schema.linearConnections.refreshToken,
          accessTokenExpiresAt: schema.linearConnections.accessTokenExpiresAt,
        })
        .from(schema.linearConnections)
        .where(eq(schema.linearConnections.linearOrganizationId, externalId))
        .limit(1);
      return row === undefined
        ? undefined
        : { ...row, unavailable: linearConnectionUnavailable(row, input.receivedAt) };
    });
  }
}
function linearConnection(
  row: typeof schema.linearConnections.$inferSelect,
): LinearConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    providerApplicationId: row.providerApplicationId,
    linearOrganizationId: row.linearOrganizationId,
    linearOrganizationName: row.linearOrganizationName,
    appUserId: row.appUserId,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    scopes: row.scopes,
  };
}
async function requireLinearActivationCandidate(
  transaction: HubTransaction,
  attempt: AttemptRow,
  bindingApplicationId: string,
  providerConfiguration: CompleteLinearProviderApplicationInput["providerConfiguration"],
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
    .select({ applicationId: schema.linearConnections.providerApplicationId })
    .from(schema.linearConnections)
    .for("update");
  if (connections.some((connection) => connection.applicationId !== bindingApplicationId)) {
    throw providerApplicationChanged();
  }
}
function linearConnectionUnavailable(connection: object, receivedAt: Date): boolean {
  if (!("scopes" in connection) || !isStringArray(connection.scopes)) return true;
  if (
    !("refreshToken" in connection) ||
    (connection.refreshToken !== null && typeof connection.refreshToken !== "string")
  ) {
    return true;
  }
  if (
    !("accessTokenExpiresAt" in connection) ||
    (connection.accessTokenExpiresAt !== null && !(connection.accessTokenExpiresAt instanceof Date))
  ) {
    return true;
  }
  return linearConnectionRequiresReauthorization(
    {
      scopes: connection.scopes,
      refreshToken: connection.refreshToken,
      accessTokenExpiresAt: connection.accessTokenExpiresAt,
    },
    receivedAt,
  );
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
