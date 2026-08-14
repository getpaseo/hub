import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Locks } from "./runtime/locks/index.js";
import type { DatabaseRuntime, DrizzleHandle, TransactionHandle } from "./runtime/index.js";
import { slugify } from "../slug.js";
import { ConnectionAccessDeniedError, ConnectionConflictError } from "./errors.js";
import * as schema from "./schema.js";
import type {
  AdvanceGitHubConnectionAttemptInput,
  BindDiscordConnectionInput,
  BindGitHubConnectionInput,
  BindSlackConnectionInput,
  ConnectionAccountAccess,
  ConnectionAttemptPhase,
  ConnectionAttemptRecord,
  ConnectionProvider,
  ConnectionStartAuthority,
  DiscordConnectionRecord,
  GitHubConnectionRecord,
  ReadConnectionAttemptInput,
  SlackConnectionRecord,
  StartConnectionAttemptInput,
} from "./types.js";

type HubDatabase = DrizzleHandle;
type HubTransaction = HubDatabase;
type AttemptRow = typeof schema.organizationConnectionAttempts.$inferSelect;

export class ConnectionRepository {
  private readonly database: HubDatabase;

  constructor(
    private readonly runtime: DatabaseRuntime,
    private readonly locks: Locks,
  ) {
    this.database = runtime.drizzle();
  }

  async startAttempt(input: StartConnectionAttemptInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockStartAuthority(transaction, input.access);
      await transaction.delete(schema.organizationConnectionAttempts).where(orExpiredOrConsumed());
      await transaction.insert(schema.organizationConnectionAttempts).values({
        provider: input.provider,
        phase: initialConnectionAttemptPhase(input.provider),
        stateVerifier: input.stateVerifier,
        organizationId: input.access.organizationId,
        returnRoute: input.access.returnRoute,
        userId: input.access.userId,
        sessionId: input.access.sessionId,
        configurationVersion: input.configurationVersion,
        callbackOrigin: input.callbackOrigin,
        configurationSnapshot: input.configurationSnapshot,
        expectedConfigurationVersion: input.expectedConfigurationVersion,
        activateConfiguration: input.activateConfiguration,
        expiresAt: sql`clock_timestamp() + (${input.lifetimeMinutes} * interval '1 minute')`,
      });
    });
  }

  async readAttempt(input: ReadConnectionAttemptInput): Promise<ConnectionAttemptRecord> {
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      return toAttempt(attempt);
    });
  }

  async findAttemptConfiguration(stateVerifier: string): Promise<
    | {
        configurationVersion: number;
        callbackOrigin: string;
        configurationSnapshot: unknown;
        expectedConfigurationVersion: number | null;
        activateConfiguration: boolean;
      }
    | undefined
  > {
    const [attempt] = await this.database
      .select({
        configurationVersion: schema.organizationConnectionAttempts.configurationVersion,
        callbackOrigin: schema.organizationConnectionAttempts.callbackOrigin,
        configurationSnapshot: schema.organizationConnectionAttempts.configurationSnapshot,
        expectedConfigurationVersion:
          schema.organizationConnectionAttempts.expectedConfigurationVersion,
        activateConfiguration: schema.organizationConnectionAttempts.activateConfiguration,
      })
      .from(schema.organizationConnectionAttempts)
      .where(
        and(
          eq(schema.organizationConnectionAttempts.stateVerifier, stateVerifier),
          isNull(schema.organizationConnectionAttempts.consumedAt),
        ),
      )
      .limit(1);
    return attempt;
  }

  async consumeAttempt(input: ReadConnectionAttemptInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }

  async advanceGitHubAttempt(input: AdvanceGitHubConnectionAttemptInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
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

  async bindGitHub(input: BindGitHubConnectionInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      await lockExternal(this.locks, runtimeTransaction, "github", String(input.installationId));
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
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
      const [_connection] =
        existing === undefined
          ? await transaction
              .insert(schema.githubConnections)
              .values({
                organizationId: attempt.organizationId,
                installationId: input.installationId,
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
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }

  async bindDiscord(input: BindDiscordConnectionInput): Promise<void> {
    await this.bindExclusive(input, "discord", input.guildId, async (transaction, attempt) => {
      const [_connection] = await transaction
        .insert(schema.discordConnections)
        .values({
          organizationId: attempt.organizationId,
          guildId: input.guildId,
          guildName: input.guildName,
          slug: await uniqueConnectionSlug(
            transaction,
            attempt.organizationId,
            "discord",
            input.guildName,
          ),
          connectedByUserId: attempt.userId,
        })
        .returning({ id: schema.discordConnections.id });
    });
  }

  async bindSlack(input: BindSlackConnectionInput): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      await lockExternal(this.locks, runtimeTransaction, "slack", input.teamId);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
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
            botUserId: input.botUserId,
            botAccessToken: input.botAccessToken,
            scopes: input.scopes,
            connectedByUserId: attempt.userId,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(schema.slackConnections.id, existing.id));
      }
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }

  private async bindExclusive(
    input: ReadConnectionAttemptInput,
    provider: "discord" | "slack",
    externalId: string,
    insert: (transaction: HubTransaction, attempt: AttemptRow) => Promise<void>,
  ): Promise<void> {
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockAccountSession(transaction, input.access);
      await lockExternal(this.locks, runtimeTransaction, provider, externalId);
      const attempt = await lockAttempt(transaction, input);
      await lockStoredAuthority(transaction, attempt);
      const conflict =
        provider === "discord"
          ? await transaction
              .select({ id: schema.discordConnections.id })
              .from(schema.discordConnections)
              .where(eq(schema.discordConnections.guildId, externalId))
              .limit(1)
          : await transaction
              .select({ id: schema.slackConnections.id })
              .from(schema.slackConnections)
              .where(eq(schema.slackConnections.teamId, externalId))
              .limit(1);
      if (conflict.length > 0) throw new ConnectionConflictError();
      await insert(transaction, attempt);
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }

  async findGitHub(installationId: number): Promise<GitHubConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.githubConnections)
      .where(eq(schema.githubConnections.installationId, installationId))
      .limit(1);
    return row === undefined ? undefined : githubConnection(row);
  }

  async removeGitHubByInstallationInTransaction(
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

  async disconnect(
    provider: ConnectionProvider,
    connectionId: string,
    access: ConnectionStartAuthority,
  ) {
    return this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockStartAuthority(transaction, access);
      if (provider === "github") {
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
      }
      if (provider === "discord") {
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
      }
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

  async findDiscord(guildId: string): Promise<DiscordConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.discordConnections)
      .where(eq(schema.discordConnections.guildId, guildId))
      .limit(1);
    return row === undefined ? undefined : discordConnection(row);
  }

  async findDiscordForOrganization(
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

  async findSlack(teamId: string): Promise<SlackConnectionRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(schema.slackConnections)
      .where(eq(schema.slackConnections.teamId, teamId))
      .limit(1);
    return row === undefined ? undefined : slackConnection(row);
  }

  async findSlackForOrganization(
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

  async removeDiscord(guildId: string): Promise<void> {
    await this.database
      .delete(schema.discordConnections)
      .where(eq(schema.discordConnections.guildId, guildId));
  }
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

function orExpiredOrConsumed() {
  return sql`${schema.organizationConnectionAttempts.expiresAt} <= clock_timestamp() or ${schema.organizationConnectionAttempts.consumedAt} is not null`;
}

async function lockAttempt(
  transaction: HubTransaction,
  input: ReadConnectionAttemptInput,
): Promise<AttemptRow> {
  const [attempt] = await transaction
    .select()
    .from(schema.organizationConnectionAttempts)
    .where(
      and(
        eq(schema.organizationConnectionAttempts.stateVerifier, input.stateVerifier),
        eq(schema.organizationConnectionAttempts.phase, input.phase),
        isNull(schema.organizationConnectionAttempts.consumedAt),
      ),
    )
    .for("update");
  if (
    attempt === undefined ||
    (await expiredAtDatabaseClock(transaction, attempt.expiresAt)) ||
    attempt.userId !== input.access.userId ||
    attempt.sessionId !== input.access.sessionId
  )
    throw new Error("connection unavailable");
  return attempt;
}

async function lockAccountSession(
  transaction: HubTransaction,
  access: ConnectionAccountAccess,
): Promise<void> {
  const [session] = await transaction
    .select({
      userId: schema.sessions.userId,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, access.sessionId))
    .for("update");
  if (
    session?.userId !== access.userId ||
    (await expiredAtDatabaseClock(transaction, session.expiresAt))
  )
    throw new ConnectionAccessDeniedError();
}

async function lockStartAuthority(
  transaction: HubTransaction,
  access: ConnectionStartAuthority,
): Promise<void> {
  await lockAccountSession(transaction, access);
  const [membership] = await transaction
    .select({ role: schema.members.role })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.id, access.membershipId),
        eq(schema.members.userId, access.userId),
        eq(schema.members.organizationId, access.organizationId),
        inArray(schema.members.role, ["owner", "admin"]),
      ),
    )
    .for("update");
  if (membership === undefined) throw new ConnectionAccessDeniedError();
}

async function lockStoredAuthority(
  transaction: HubTransaction,
  attempt: AttemptRow,
): Promise<void> {
  const [membership] = await transaction
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.userId, attempt.userId),
        eq(schema.members.organizationId, attempt.organizationId),
        inArray(schema.members.role, ["owner", "admin"]),
      ),
    )
    .for("update");
  if (membership === undefined) throw new ConnectionAccessDeniedError();
}

async function expiredAtDatabaseClock(
  transaction: HubTransaction,
  expiresAt: Date,
): Promise<boolean> {
  const clock = await transaction.execute<{ expired: boolean }>(
    sql`select ${expiresAt}::timestamptz <= clock_timestamp() as expired`,
  );
  return clock.rows[0]?.expired ?? true;
}

async function lockExternal(
  locks: Locks,
  transaction: TransactionHandle,
  provider: ConnectionProvider,
  externalId: string,
): Promise<void> {
  await locks.withTxLock(
    transaction,
    JSON.stringify(["paseo-connection", provider, "external", externalId]),
  );
}

async function consumeLockedAttempt(transaction: HubTransaction, attemptId: string): Promise<void> {
  await transaction
    .update(schema.organizationConnectionAttempts)
    .set({ consumedAt: sql`clock_timestamp()`, pkceVerifier: null })
    .where(eq(schema.organizationConnectionAttempts.id, attemptId));
}

function initialConnectionAttemptPhase(provider: ConnectionProvider): ConnectionAttemptPhase {
  if (provider === "github") return "github_setup";
  return provider === "discord" ? "discord_authorization" : "slack_authorization";
}

function toAttempt(row: AttemptRow): ConnectionAttemptRecord {
  return {
    id: row.id,
    provider: row.provider,
    phase: row.phase,
    organizationId: row.organizationId,
    returnRoute: row.returnRoute,
    userId: row.userId,
    sessionId: row.sessionId,
    candidateExternalId: row.candidateExternalId,
    pkceVerifier: row.pkceVerifier,
    configurationVersion: row.configurationVersion,
    callbackOrigin: row.callbackOrigin,
    configurationSnapshot: row.configurationSnapshot,
    expectedConfigurationVersion: row.expectedConfigurationVersion,
    activateConfiguration: row.activateConfiguration,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
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
  };
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
  };
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
  };
}

async function uniqueConnectionSlug(
  transaction: HubTransaction,
  organizationId: string,
  provider: ConnectionProvider,
  identity: string,
): Promise<string> {
  const base = `${slugify(identity, "connection")}-${provider}`;
  const rows = await transaction.execute<{ slug: string }>(sql`
    select slug from (
      select slug from github_connections where organization_id = ${organizationId}
      union all
      select slug from slack_connections where organization_id = ${organizationId}
      union all
      select slug from discord_connections where organization_id = ${organizationId}
    ) slugs
    where slug = ${base} or slug like ${`${base}-%`}
    order by slug
  `);
  const used = new Set(rows.rows.map((row) => row.slug));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
