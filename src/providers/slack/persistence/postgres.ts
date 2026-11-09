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
  AcceptSlackEventInput,
  BindSlackConnectionInput,
  CompleteSlackProviderApplicationInput,
  ConnectionStartAuthority,
  ProviderEventAcceptance,
  SlackConnectionRecord,
} from "../../../db/types.js";
type HubTransaction = DrizzleHandle;
type AttemptRow = typeof schema.organizationConnectionAttempts.$inferSelect;
export class SlackPostgresPersistence {
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
  async bindSlackConnection(input: BindSlackConnectionInput): Promise<void> {
    await this.bindSlackTransition(input);
  }
  async completeSlackProviderApplication(
    input: CompleteSlackProviderApplicationInput,
  ): Promise<void> {
    await this.bindSlackTransition(input, input.providerConfiguration);
  }
  private async bindSlackTransition(
    input: BindSlackConnectionInput,
    providerConfiguration?: CompleteSlackProviderApplicationInput["providerConfiguration"],
  ): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, "slack");
      if (providerConfiguration === undefined) {
        await requireCurrentAttempt(transaction, attempt, input.providerApplicationId);
      } else {
        await requireSlackActivationCandidate(
          transaction,
          attempt,
          input.providerApplicationId,
          providerConfiguration,
        );
      }
      await lockExternal(this.locks, runtimeTransaction, "slack", input.teamId);
      const [existing] = await transaction
        .select({
          id: schema.slackConnections.id,
          organizationId: schema.slackConnections.organizationId,
        })
        .from(schema.slackConnections)
        .where(eq(schema.slackConnections.teamId, input.teamId))
        .for("update");
      if (existing !== undefined && existing.organizationId !== attempt.organizationId) {
        throw new ConnectionConflictError();
      }
      if (existing === undefined) {
        await transaction.insert(schema.slackConnections).values({
          organizationId: attempt.organizationId,
          teamId: input.teamId,
          providerApplicationId: input.providerApplicationId,
          teamName: input.teamName,
          slug: await uniqueConnectionSlug(
            transaction,
            attempt.organizationId,
            "slack",
            input.teamName,
          ),
          botUserId: input.botUserId,
          botAccessToken: input.botAccessToken,
          scopes: input.scopes,
          connectedByUserId: attempt.userId,
        });
      } else {
        await transaction
          .update(schema.slackConnections)
          .set({
            teamName: input.teamName,
            providerApplicationId: input.providerApplicationId,
            botUserId: input.botUserId,
            botAccessToken: input.botAccessToken,
            scopes: input.scopes,
            connectedByUserId: attempt.userId,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.slackConnections.id, existing.id));
      }
      if (providerConfiguration !== undefined)
        await commitProviderApplication(
          transaction,
          "slack",
          providerConfiguration,
          input.providerApplicationId,
          attempt.configurationVersion,
        );
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }
  async findSlackConnection(teamId: string): Promise<SlackConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.slackConnections)
      .where(eq(schema.slackConnections.teamId, teamId))
      .limit(1);
    return row === undefined ? undefined : slackConnection(row);
  }
  async findSlackConnectionForOrganization(
    organizationId: string,
    teamId: string,
  ): Promise<SlackConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.slackConnections)
      .where(
        and(
          eq(schema.slackConnections.organizationId, organizationId),
          eq(schema.slackConnections.teamId, teamId),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : slackConnection(row);
  }
  async disconnectConnection(connectionId: string, access: ConnectionStartAuthority) {
    const provider = "slack" as const;
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockStartAuthority(transaction, access);
      const [connection] = await transaction
        .select({
          teamId: schema.slackConnections.teamId,
          botAccessToken: schema.slackConnections.botAccessToken,
        })
        .from(schema.slackConnections)
        .where(
          and(
            eq(schema.slackConnections.id, connectionId),
            eq(schema.slackConnections.organizationId, access.organizationId),
          ),
        )
        .for("update");
      if (connection === undefined) throw new ConnectionAccessDeniedError();
      await transaction
        .delete(schema.projectTriggerRoutes)
        .where(eq(schema.projectTriggerRoutes.connectionId, connectionId));
      await transaction
        .delete(schema.slackConnections)
        .where(eq(schema.slackConnections.id, connectionId));
      return {
        provider,
        teamId: connection.teamId,
        botAccessToken: connection.botAccessToken,
      } as const;
    });
  }
  async listConnections(organizationId?: string) {
    const rows = await this.database
      .select()
      .from(schema.slackConnections)
      .where(
        organizationId === undefined
          ? undefined
          : eq(schema.slackConnections.organizationId, organizationId),
      )
      .orderBy(schema.slackConnections.teamName, schema.slackConnections.id);
    return rows.map((row) =>
      Object.assign(slackConnection(row), { scopes: stringArray(row.scopes) }),
    );
  }
  acceptSlackEvent(input: AcceptSlackEventInput): Promise<ProviderEventAcceptance> {
    const externalId = input.teamId;
    return this.events.acceptProvider("slack", input.teamId, input, async (transaction) => {
      const [row] = await transaction
        .select({
          id: schema.slackConnections.id,
          organizationId: schema.slackConnections.organizationId,
        })
        .from(schema.slackConnections)
        .where(eq(schema.slackConnections.teamId, externalId))
        .limit(1);
      return row === undefined ? undefined : { ...row, unavailable: false };
    });
  }
}
function slackConnection(row: typeof schema.slackConnections.$inferSelect): SlackConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    teamId: row.teamId,
    teamName: row.teamName,
    botUserId: row.botUserId,
    botAccessToken: row.botAccessToken,
    scopes: row.scopes,
    providerApplicationId: row.providerApplicationId,
  };
}
async function requireSlackActivationCandidate(
  transaction: HubTransaction,
  attempt: AttemptRow,
  bindingApplicationId: string,
  providerConfiguration: CompleteSlackProviderApplicationInput["providerConfiguration"],
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
    .select({ applicationId: schema.slackConnections.providerApplicationId })
    .from(schema.slackConnections)
    .for("update");
  if (connections.some((connection) => connection.applicationId !== bindingApplicationId)) {
    throw providerApplicationChanged();
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
