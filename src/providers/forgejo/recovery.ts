import type { ForgejoConnectionRecord, ForgejoInstanceRecord } from "../../db/types.js";
import type { SecretEncryptionKeySource } from "../../secrets/authenticated-envelope.js";
import type { ForgejoVerifiedDelivery } from "../../triggers/forgejo/webhook.js";
import { type ForgejoDirectory, type ForgejoHttp } from "./instances.js";
import { executeClaimed } from "./recovery-execute.js";
import {
  FORGEJO_HEALTH_TIMEOUT_MS,
  forgejoWorkIdentity,
  type ForgejoClock,
  type ForgejoReceiptRecoverySource,
  type ForgejoRecoveryStore,
  type ForgejoRecoveryWorkRecord,
} from "./recovery-store.js";

export type { ForgejoClock, ForgejoReceiptRecoverySource };
export { forgejoDeliveryFromReceipt } from "./recovery-store.js";

export interface ForgejoRecoveryHealthView {
  workKind: ForgejoRecoveryWorkRecord["workKind"];
  workIdentity: string;
  status: ForgejoRecoveryWorkRecord["status"];
  typedCause: string | null;
  attemptCount: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  nextAttemptAt: string | null;
  remediation: string;
}

export function createForgejoRecoveryCoordinator(options: {
  directory: ForgejoDirectory;
  store: ForgejoRecoveryStore;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
  receipts?: ForgejoReceiptRecoverySource;
  dispatch?: (input: { delivery: ForgejoVerifiedDelivery; receiptId: string }) => Promise<void>;
  clock?: ForgejoClock;
  owner?: string;
}): {
  seed: () => Promise<void>;
  tick: (input?: { includeRemoteCleanup?: boolean; webhookAdminPat?: string }) => Promise<number>;
  healthForInstance: (instanceId: string) => Promise<ForgejoRecoveryHealthView[]>;
  healthForConnection: (connectionId: string) => Promise<ForgejoRecoveryHealthView[]>;
  recoverCleanup: (input: {
    organizationId: string;
    connectionId: string;
    webhookAdminPat: string;
  }) => Promise<number>;
} {
  const clock = options.clock ?? { now: () => new Date() };
  const owner = options.owner ?? "forgejo-recovery";
  const http = withHealthTimeout(options.http);
  return {
    seed: () => seedRecoveryWork({ ...options, clock }),
    tick: (input) =>
      runRecoveryTick({
        ...options,
        http,
        clock,
        owner,
        includeRemoteCleanup: input?.includeRemoteCleanup === true,
        ...(input?.webhookAdminPat === undefined ? {} : { webhookAdminPat: input.webhookAdminPat }),
      }),
    healthForInstance: (instanceId) =>
      options.store.listForInstance(instanceId).then((rows) => rows.map(toHealthView)),
    healthForConnection: (connectionId) =>
      options.store.listForConnection(connectionId).then((rows) => rows.map(toHealthView)),
    recoverCleanup: (input) =>
      runRecoveryTick({
        ...options,
        http,
        clock,
        owner,
        includeRemoteCleanup: true,
        webhookAdminPat: input.webhookAdminPat,
        connectionId: input.connectionId,
      }),
  };
}

export function toHealthView(row: ForgejoRecoveryWorkRecord): ForgejoRecoveryHealthView {
  return {
    workKind: row.workKind,
    workIdentity: row.workIdentity,
    status: row.status,
    typedCause: row.typedCause,
    attemptCount: row.attemptCount,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    remediation: remediationFor(row),
  };
}

async function seedRecoveryWork(options: {
  directory: ForgejoDirectory;
  store: ForgejoRecoveryStore;
  receipts?: ForgejoReceiptRecoverySource;
  clock: ForgejoClock;
}): Promise<void> {
  const now = options.clock.now();
  const instances = await options.directory.listInstances();
  for (const instance of instances) {
    if (instance.status === "revoked") continue;
    await options.store.ensure({
      organizationId: null,
      workKind: "instance_health",
      workIdentity: forgejoWorkIdentity("instance_health", instance.id),
      scope: { instanceId: instance.id },
      now,
    });
  }
  await seedScopedWork(options.directory, options.store, now);
  if (options.receipts === undefined) return;
  const abandoned = await options.receipts.listAbandoned();
  for (const receipt of abandoned) {
    if (receipt.connectionId === null) continue;
    await options.store.ensure({
      organizationId: receipt.organizationId,
      workKind: "receipt_dispatch",
      workIdentity: forgejoWorkIdentity("receipt_dispatch", receipt.id),
      scope: { connectionId: receipt.connectionId, receiptId: receipt.id },
      now,
    });
  }
}

async function seedScopedWork(
  directory: ForgejoDirectory,
  store: ForgejoRecoveryStore,
  now: Date,
): Promise<void> {
  const instances = await directory.listInstances();
  for (const instance of instances) {
    await seedInstanceConnections(directory, store, instance, now);
  }
}

async function seedInstanceConnections(
  directory: ForgejoDirectory,
  store: ForgejoRecoveryStore,
  instance: ForgejoInstanceRecord,
  now: Date,
): Promise<void> {
  const connections = await directory.listConnections();
  for (const connection of connections) {
    if (connection.instanceId !== instance.id) continue;
    if (connection.status === "disconnected") {
      await seedCleanupWork(directory, store, connection, now);
      continue;
    }
    await store.ensure({
      organizationId: connection.organizationId,
      workKind: "connection_health",
      workIdentity: forgejoWorkIdentity("connection_health", connection.id),
      scope: { instanceId: instance.id, connectionId: connection.id },
      now,
    });
    const repositories = await directory.listRepositoriesForConnection(connection.id);
    for (const repository of repositories) {
      if (!repository.enrolled) continue;
      await store.ensure({
        organizationId: connection.organizationId,
        workKind: "repository_health",
        workIdentity: forgejoWorkIdentity(
          "repository_health",
          `${connection.id}:${String(repository.repositoryId)}`,
        ),
        scope: {
          instanceId: instance.id,
          connectionId: connection.id,
          repositoryId: repository.repositoryId,
        },
        now,
      });
      const hook = await directory.findRepositoryHook(connection.id, repository.repositoryId);
      if (hook === undefined) continue;
      await store.ensure({
        organizationId: connection.organizationId,
        workKind: "hook_health",
        workIdentity: forgejoWorkIdentity("hook_health", hook.id),
        scope: {
          instanceId: instance.id,
          connectionId: connection.id,
          repositoryId: repository.repositoryId,
          hookId: hook.id,
        },
        now,
      });
    }
  }
}

async function seedCleanupWork(
  directory: ForgejoDirectory,
  store: ForgejoRecoveryStore,
  connection: ForgejoConnectionRecord,
  now: Date,
): Promise<void> {
  const hooks = await directory.listRepositoryHooksForConnection(connection.id);
  for (const hook of hooks) {
    if (!hook.managed || hook.status !== "cleanup_failed") continue;
    await store.ensure({
      organizationId: connection.organizationId,
      workKind: "remote_cleanup",
      workIdentity: forgejoWorkIdentity("remote_cleanup", hook.id),
      scope: {
        instanceId: connection.instanceId,
        connectionId: connection.id,
        repositoryId: hook.repositoryId,
        hookId: hook.id,
      },
      now,
    });
  }
}

async function runRecoveryTick(options: {
  directory: ForgejoDirectory;
  store: ForgejoRecoveryStore;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
  receipts?: ForgejoReceiptRecoverySource;
  dispatch?: (input: { delivery: ForgejoVerifiedDelivery; receiptId: string }) => Promise<void>;
  clock: ForgejoClock;
  owner: string;
  includeRemoteCleanup: boolean;
  webhookAdminPat?: string;
  connectionId?: string;
}): Promise<number> {
  await seedRecoveryWork(options);
  let processed = 0;
  for (;;) {
    const claimed = await options.store.claimNext({
      owner: options.owner,
      now: options.clock.now(),
      includeRemoteCleanup: options.includeRemoteCleanup,
      ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
    });
    if (claimed === undefined) return processed;
    await executeClaimed(claimed, options);
    processed += 1;
  }
}

function withHealthTimeout(http: ForgejoHttp): ForgejoHttp {
  return {
    resolver: http.resolver,
    fetch: (input, init) =>
      http.fetch(input, {
        ...init,
        signal: AbortSignal.timeout(FORGEJO_HEALTH_TIMEOUT_MS),
      }),
  };
}

function remediationFor(row: ForgejoRecoveryWorkRecord): string {
  if (row.status === "succeeded") return "healthy";
  if (
    row.typedCause === "REMOTE_CLEANUP_PENDING" ||
    row.typedCause === "forgejo_credential_unavailable"
  ) {
    return "supply_webhook_admin_pat";
  }
  if (row.status === "failed_permanent") return "correct_and_reverify";
  if (row.status === "retry_scheduled" || row.status === "ready") return "automatic_retry";
  if (row.status === "claimed") return "in_progress";
  return "none";
}
