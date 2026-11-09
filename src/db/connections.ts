import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ProviderRegistry } from "../providers/registry.js";
import { slugify } from "../slug.js";
import { ConnectionAccessDeniedError, ConnectionAttemptUnavailableError } from "./errors.js";
import type { DatabaseRuntime, DrizzleHandle, TransactionHandle } from "./runtime/index.js";
import type { Locks } from "./runtime/locks/index.js";
import * as schema from "./schema.js";
import type {
  ConnectionAccountAccess,
  ConnectionAttemptRecord,
  ConnectionProvider,
  ConnectionStartAuthority,
  ReadConnectionAttemptInput,
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
    private readonly providers: ProviderRegistry,
  ) {
    this.database = runtime.drizzle();
  }

  async requireConsumableAttempt(transaction: HubTransaction, attempt: AttemptRow): Promise<void> {
    const application = this.providers.require(attempt.provider).application;
    await requireConsumableAttempt(
      transaction,
      attempt,
      application.connectionConfigurationActivation === true,
    );
  }

  async uniqueSlug(
    transaction: TransactionHandle,
    organizationId: string,
    provider: string,
    identity: string,
  ): Promise<string> {
    const base = `${slugify(identity, "connection")}-${provider}`;
    const used = new Set<string>();
    for (const module of this.providers.list()) {
      const inventory = module.application.persistence(this.runtime);
      for (const slug of await inventory.connectionSlugs(transaction, organizationId))
        used.add(slug);
    }
    if (!used.has(base)) return base;
    let suffix = 2;
    while (used.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  }

  async startAttempt(input: StartConnectionAttemptInput): Promise<void> {
    const phase = this.providers.require(input.provider).application.initialConnectionPhase;
    await this.runtime.transaction(async (runtimeTransaction) => {
      const transaction = runtimeTransaction.drizzle();
      await lockStartAuthority(transaction, input.access);
      await transaction.delete(schema.organizationConnectionAttempts).where(orExpiredOrConsumed());
      await transaction.insert(schema.organizationConnectionAttempts).values({
        provider: input.provider,
        phase,
        stateVerifier: input.stateVerifier,
        organizationId: input.access.organizationId,
        returnRoute: input.access.returnRoute,
        userId: input.access.userId,
        sessionId: input.access.sessionId,
        configurationVersion: input.configurationVersion,
        providerApplicationId: input.providerApplicationId,
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
      await lockProviderApplication(this.locks, runtimeTransaction, attempt.provider);
      await this.requireConsumableAttempt(transaction, attempt);
      await consumeLockedAttempt(transaction, attempt.id);
    });
  }
}

function orExpiredOrConsumed() {
  return sql`${schema.organizationConnectionAttempts.expiresAt} <= clock_timestamp() or ${schema.organizationConnectionAttempts.consumedAt} is not null`;
}

export async function lockAttempt(
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
    throw new ConnectionAttemptUnavailableError();
  return attempt;
}

export async function lockAccountSession(
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

export async function lockStartAuthority(
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

export async function lockStoredAuthority(
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

export async function lockExternal(
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

export async function lockProviderApplication(
  locks: Locks,
  transaction: TransactionHandle,
  provider: ConnectionProvider,
): Promise<void> {
  await locks.withTxLock(transaction, JSON.stringify(["provider-application", provider]));
}

export async function requireCurrentAttempt(
  transaction: HubTransaction,
  attempt: AttemptRow,
  bindingApplicationId?: string,
): Promise<void> {
  const applicationId = attempt.providerApplicationId;
  if (
    applicationId === null ||
    (bindingApplicationId !== undefined && applicationId !== bindingApplicationId)
  ) {
    throw providerApplicationChanged();
  }
  const [activation] = await transaction
    .select({
      applicationId: schema.runtimeProviderActivations.providerApplicationId,
      configurationVersion: schema.runtimeProviderActivations.configurationVersion,
    })
    .from(schema.runtimeProviderActivations)
    .where(eq(schema.runtimeProviderActivations.provider, attempt.provider))
    .for("update");
  if (
    activation?.applicationId !== applicationId ||
    activation?.configurationVersion !== attempt.configurationVersion
  ) {
    throw providerApplicationChanged();
  }
}

async function requireConsumableAttempt(
  transaction: HubTransaction,
  attempt: AttemptRow,
  allowsActivation: boolean,
): Promise<void> {
  if (!attempt.activateConfiguration) {
    await requireCurrentAttempt(transaction, attempt);
    return;
  }
  if (!allowsActivation) {
    throw providerApplicationChanged();
  }
  const provider = attempt.provider;
  const [stored] = await transaction
    .select({
      version: schema.runtimeProviderConfiguration.version,
      identity: schema.runtimeProviderConfiguration.verifiedExternalIdentity,
    })
    .from(schema.runtimeProviderConfiguration)
    .where(eq(schema.runtimeProviderConfiguration.provider, provider))
    .for("update");
  const [activation] = await transaction
    .select({
      applicationId: schema.runtimeProviderActivations.providerApplicationId,
      configurationVersion: schema.runtimeProviderActivations.configurationVersion,
    })
    .from(schema.runtimeProviderActivations)
    .where(eq(schema.runtimeProviderActivations.provider, provider))
    .for("update");
  if (stored?.version !== (attempt.expectedConfigurationVersion ?? undefined)) {
    throw providerApplicationChanged();
  }
  if (stored === undefined) {
    if (activation !== undefined) throw providerApplicationChanged();
    return;
  }
  if (
    activation?.applicationId !== externalIdentityId(stored.identity) ||
    activation?.configurationVersion !== stored.version
  ) {
    throw providerApplicationChanged();
  }
}

export async function writeProviderActivation(
  transaction: HubTransaction,
  provider: ConnectionProvider,
  applicationId: string,
  configurationVersion: number,
): Promise<void> {
  await transaction
    .insert(schema.runtimeProviderActivations)
    .values({ provider, providerApplicationId: applicationId, configurationVersion })
    .onConflictDoUpdate({
      target: schema.runtimeProviderActivations.provider,
      set: {
        providerApplicationId: applicationId,
        configurationVersion,
        activatedAt: sql`clock_timestamp()`,
      },
    });
}

export function externalIdentityId(value: unknown): string | undefined {
  return value !== null && typeof value === "object" && typeof Reflect.get(value, "id") === "string"
    ? String(Reflect.get(value, "id"))
    : undefined;
}

export function providerApplicationChanged(): Error {
  const error = new Error("provider application changed");
  error.name = "ProviderApplicationChangedError";
  return error;
}

export async function consumeLockedAttempt(
  transaction: HubTransaction,
  attemptId: string,
): Promise<void> {
  await transaction
    .update(schema.organizationConnectionAttempts)
    .set({ consumedAt: sql`clock_timestamp()`, pkceVerifier: null })
    .where(eq(schema.organizationConnectionAttempts.id, attemptId));
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
    providerApplicationId: row.providerApplicationId,
    callbackOrigin: row.callbackOrigin,
    configurationSnapshot: row.configurationSnapshot,
    expectedConfigurationVersion: row.expectedConfigurationVersion,
    activateConfiguration: row.activateConfiguration,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

export async function commitProviderApplication(
  transaction: DrizzleHandle,
  provider: ConnectionProvider,
  providerConfiguration: {
    configuration: unknown;
    identity: { id: string };
    expectedVersion: number | undefined;
    updatedByUserId: string;
  },
  applicationId: string,
  configurationVersion: number,
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
      provider: provider,
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
  await writeProviderActivation(transaction, provider, applicationId, configurationVersion);
}
