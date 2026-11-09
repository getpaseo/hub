import { and, eq } from "drizzle-orm";
import {
  consumeLockedAttempt,
  lockAccountSession,
  lockAttempt,
  lockExternal,
  lockProviderApplication,
  lockStartAuthority,
  lockStoredAuthority,
  requireCurrentAttempt,
} from "../../../db/connections.js";
import { ConnectionAccessDeniedError, ConnectionConflictError } from "../../../db/errors.js";
import type { PostgresProviderContext } from "../../../db/provider-persistence.js";
import type { DatabaseRuntime, DrizzleHandle } from "../../../db/runtime/index.js";
import type { Locks } from "../../../db/runtime/locks/index.js";
import * as schema from "../../../db/schema.js";
import type {
  AcceptDiscordEventInput,
  BindDiscordConnectionInput,
  ConnectionStartAuthority,
  DiscordConnectionRecord,
  ProviderEventAcceptance,
} from "../../../db/types.js";
export class DiscordPostgresPersistence {
  private readonly connections: PostgresProviderContext["connections"];
  private readonly database: DrizzleHandle;
  private readonly runtime: DatabaseRuntime;
  private readonly locks: Locks;
  private readonly events: PostgresProviderContext["events"];
  constructor(context: PostgresProviderContext) {
    this.connections = context.connections;
    this.runtime = context.runtime;
    this.locks = context.locks;
    this.events = context.events;
    this.database = this.runtime.drizzle();
  }
  async bindDiscordConnection(input: BindDiscordConnectionInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await lockProviderApplication(this.locks, runtimeTransaction, "discord");
      await requireCurrentAttempt(transaction, attempt, input.providerApplicationId);
      await lockExternal(this.locks, runtimeTransaction, "discord", input.guildId);
      const conflict = await transaction
        .select({ id: schema.discordConnections.id })
        .from(schema.discordConnections)
        .where(eq(schema.discordConnections.guildId, input.guildId))
        .limit(1);
      if (conflict.length > 0) throw new ConnectionConflictError();
      const [_connection] = await transaction
        .insert(schema.discordConnections)
        .values({
          organizationId: attempt.organizationId,
          guildId: input.guildId,
          providerApplicationId: input.providerApplicationId,
          guildName: input.guildName,
          slug: await this.connections.uniqueSlug(
            runtimeTransaction,
            attempt.organizationId,
            "discord",
            input.guildName,
          ),
          connectedByUserId: attempt.userId,
        })
        .returning({ id: schema.discordConnections.id });

      await consumeLockedAttempt(transaction, attempt.id);
    });
  }
  async findDiscordConnection(guildId: string): Promise<DiscordConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.discordConnections)
      .where(eq(schema.discordConnections.guildId, guildId))
      .limit(1);
    return row === undefined ? undefined : discordConnection(row);
  }
  async findDiscordConnectionForOrganization(
    organizationId: string,
    guildId: string,
  ): Promise<DiscordConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.discordConnections)
      .where(
        and(
          eq(schema.discordConnections.organizationId, organizationId),
          eq(schema.discordConnections.guildId, guildId),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : discordConnection(row);
  }
  async removeDiscordConnection(guildId: string): Promise<void> {
    await this.database
      .delete(schema.discordConnections)
      .where(eq(schema.discordConnections.guildId, guildId));
  }
  async disconnectConnection(connectionId: string, access: ConnectionStartAuthority) {
    const provider = "discord" as const;
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockStartAuthority(transaction, access);
      const [connection] = await transaction
        .select({ guildId: schema.discordConnections.guildId })
        .from(schema.discordConnections)
        .where(
          and(
            eq(schema.discordConnections.id, connectionId),
            eq(schema.discordConnections.organizationId, access.organizationId),
          ),
        )
        .for("update");
      if (connection === undefined) throw new ConnectionAccessDeniedError();
      await transaction
        .delete(schema.projectTriggerRoutes)
        .where(eq(schema.projectTriggerRoutes.connectionId, connectionId));
      await transaction
        .delete(schema.discordConnections)
        .where(eq(schema.discordConnections.id, connectionId));
      return {
        provider,
        guildId: connection.guildId,
      } as const;
    });
  }
  async listConnections(organizationId?: string) {
    const rows = await this.database
      .select()
      .from(schema.discordConnections)
      .where(
        organizationId === undefined
          ? undefined
          : eq(schema.discordConnections.organizationId, organizationId),
      )
      .orderBy(schema.discordConnections.guildName, schema.discordConnections.id);
    return rows.map((row) => discordConnection(row));
  }
  acceptDiscordEvent(input: AcceptDiscordEventInput): Promise<ProviderEventAcceptance> {
    const externalId = input.guildId;
    return this.events.acceptProvider("discord", input.guildId, input, async (transaction) => {
      const [row] = await transaction
        .select({
          id: schema.discordConnections.id,
          organizationId: schema.discordConnections.organizationId,
        })
        .from(schema.discordConnections)
        .where(eq(schema.discordConnections.guildId, externalId))
        .limit(1);
      return row === undefined ? undefined : { ...row, unavailable: false };
    });
  }
}
function discordConnection(
  row: typeof schema.discordConnections.$inferSelect,
): DiscordConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    guildId: row.guildId,
    guildName: row.guildName,
    providerApplicationId: row.providerApplicationId,
  };
}
