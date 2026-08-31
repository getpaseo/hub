import { logger } from "../../logger.js";
import type { ForgejoConnectionRecord, ForgejoInstanceRecord } from "../../db/types.js";
import {
  decryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import type { ForgejoVerifiedDelivery } from "../../triggers/forgejo/webhook.js";
import { removeForgejoManagedHook } from "./hooks.js";
import {
  ForgejoContractError,
  forgejoJson,
  originFromInstance,
  probeForgejoInstance,
  type ForgejoDirectory,
  type ForgejoHttp,
} from "./instances.js";
import {
  FORGEJO_HEALTH_INTERVAL_MS,
  classifyForgejoRecoveryFailure,
  forgejoDeliveryFromReceipt,
  type ForgejoClock,
  type ForgejoReceiptRecoverySource,
  type ForgejoRecoveryStore,
  type ForgejoRecoveryWorkRecord,
} from "./recovery-store.js";

export async function executeClaimed(
  claimed: ForgejoRecoveryWorkRecord,
  options: {
    directory: ForgejoDirectory;
    store: ForgejoRecoveryStore;
    http: ForgejoHttp;
    secrets: SecretEncryptionKeySource;
    receipts?: ForgejoReceiptRecoverySource;
    dispatch?: (input: { delivery: ForgejoVerifiedDelivery; receiptId: string }) => Promise<void>;
    clock: ForgejoClock;
    webhookAdminPat?: string;
  },
): Promise<void> {
  try {
    await runClaimedKind(claimed, options);
    const now = options.clock.now();
    await options.store.complete({
      id: claimed.id,
      now,
      nextAttemptAt: nextHealthAttempt(claimed, now),
    });
  } catch (error) {
    const classified = classifyForgejoRecoveryFailure(error);
    logger.warn(
      { err: error, workKind: claimed.workKind, workIdentity: claimed.workIdentity },
      "forgejo recovery work failed",
    );
    await applyFailure(claimed, classified, options);
  }
}

async function runClaimedKind(
  claimed: ForgejoRecoveryWorkRecord,
  options: {
    directory: ForgejoDirectory;
    http: ForgejoHttp;
    secrets: SecretEncryptionKeySource;
    receipts?: ForgejoReceiptRecoverySource;
    dispatch?: (input: { delivery: ForgejoVerifiedDelivery; receiptId: string }) => Promise<void>;
    webhookAdminPat?: string;
  },
): Promise<void> {
  if (claimed.workKind === "instance_health") {
    await probeInstanceHealth(claimed, options);
    return;
  }
  if (claimed.workKind === "connection_health") {
    await probeConnectionHealth(claimed, options);
    return;
  }
  if (claimed.workKind === "repository_health" || claimed.workKind === "hook_health") {
    await probeRepositoryOrHookHealth(claimed, options);
    return;
  }
  if (claimed.workKind === "receipt_dispatch" || claimed.workKind === "hydration_signal") {
    await recoverReceiptDispatch(claimed, options);
    return;
  }
  await recoverRemoteCleanup(claimed, options);
}

async function probeInstanceHealth(
  claimed: ForgejoRecoveryWorkRecord,
  options: { directory: ForgejoDirectory; http: ForgejoHttp },
): Promise<void> {
  const instanceId = claimed.scope.instanceId;
  if (instanceId === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo instance was not found");
  }
  const existing = await options.directory.findInstanceById(instanceId);
  if (existing === undefined || existing.status === "revoked") {
    throw new ForgejoContractError("forgejo_origin_unapproved", 409, "Forgejo instance is revoked");
  }
  if (existing.status === "incompatible" || existing.status === "identity_drifted") {
    throw new ForgejoContractError(
      existing.status === "incompatible"
        ? "forgejo_version_unsupported"
        : "forgejo_identity_mismatch",
      409,
      "Forgejo instance is contract-invalid",
    );
  }
  const origin = originFromInstance(existing);
  const probe = await probeForgejoInstance(origin, options.http);
  const drifted = identityFingerprintChanged(existing, probe.identity.fingerprint);
  const now = new Date();
  await options.directory.updateInstance({
    ...existing,
    reportedVersion: probe.version,
    externalIdentity: probe.identity,
    status: drifted ? "identity_drifted" : "active",
    lastHealthAt: now,
    lastHealthError: drifted ? "Forgejo instance identity drifted" : null,
    updatedAt: now,
  });
  if (drifted) {
    throw new ForgejoContractError(
      "forgejo_identity_mismatch",
      409,
      "Forgejo instance identity drifted",
    );
  }
}

async function probeConnectionHealth(
  claimed: ForgejoRecoveryWorkRecord,
  options: {
    directory: ForgejoDirectory;
    http: ForgejoHttp;
    secrets: SecretEncryptionKeySource;
  },
): Promise<void> {
  const connection = await requireUsableConnection(options.directory, claimed.scope.connectionId);
  const instance = await requireActiveInstance(options.directory, connection.instanceId);
  const token = await decryptConnectionPat(options, connection);
  const repositories = await options.directory.listRepositoriesForConnection(connection.id);
  const enrolled = repositories.find((repository) => repository.enrolled) ?? repositories[0];
  if (enrolled === undefined) return;
  const path = `/api/v1/repos/${encodeURIComponent(enrolled.ownerLogin)}/${encodeURIComponent(enrolled.name)}`;
  const body = await forgejoJson(options.http, originFromInstance(instance), path, token);
  if (!isRecord(body) || Number(body["id"]) !== enrolled.repositoryId) {
    throw new ForgejoContractError(
      "forgejo_identity_mismatch",
      409,
      "Forgejo repository identity drifted",
    );
  }
  if (connection.status === "degraded") {
    await options.directory.updateConnection({ ...connection, status: "active" });
  }
}

async function probeRepositoryOrHookHealth(
  claimed: ForgejoRecoveryWorkRecord,
  options: {
    directory: ForgejoDirectory;
    http: ForgejoHttp;
    secrets: SecretEncryptionKeySource;
  },
): Promise<void> {
  const connection = await requireUsableConnection(options.directory, claimed.scope.connectionId);
  const instance = await requireActiveInstance(options.directory, connection.instanceId);
  const repositoryId = claimed.scope.repositoryId;
  if (repositoryId === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo repository was not found");
  }
  const repositories = await options.directory.listRepositoriesForConnection(connection.id);
  const repository = repositories.find((row) => row.repositoryId === repositoryId);
  if (repository === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo repository was not found");
  }
  const token = await decryptConnectionPat(options, connection);
  const origin = originFromInstance(instance);
  if (claimed.workKind === "repository_health") {
    const path = `/api/v1/repos/${encodeURIComponent(repository.ownerLogin)}/${encodeURIComponent(repository.name)}`;
    await forgejoJson(options.http, origin, path, token);
    return;
  }
  const hook = await options.directory.findRepositoryHook(connection.id, repositoryId);
  if (hook === undefined || hook.forgejoHookId === null) {
    throw new ForgejoContractError("not_found", 404, "Forgejo hook was not found");
  }
  const hookPath = `/api/v1/repos/${encodeURIComponent(repository.ownerLogin)}/${encodeURIComponent(repository.name)}/hooks/${String(hook.forgejoHookId)}`;
  await forgejoJson(options.http, origin, hookPath, token);
  await options.directory.upsertRepositoryHook({ ...hook, lastVerifiedAt: new Date() });
}

async function recoverReceiptDispatch(
  claimed: ForgejoRecoveryWorkRecord,
  options: {
    receipts?: ForgejoReceiptRecoverySource;
    dispatch?: (input: { delivery: ForgejoVerifiedDelivery; receiptId: string }) => Promise<void>;
  },
): Promise<void> {
  const receiptId = claimed.scope.receiptId;
  if (receiptId === undefined || options.receipts === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo receipt was not found");
  }
  const abandoned = await options.receipts.listAbandoned();
  const receipt = abandoned.find((row) => row.id === receiptId);
  if (receipt === undefined) return;
  const delivery = forgejoDeliveryFromReceipt(receipt);
  if (delivery === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo receipt payload is not recoverable");
  }
  if (options.dispatch === undefined) return;
  await options.dispatch({ delivery, receiptId: receipt.id });
  await options.receipts.markDispatched(receipt.id);
}

async function recoverRemoteCleanup(
  claimed: ForgejoRecoveryWorkRecord,
  options: {
    directory: ForgejoDirectory;
    http: ForgejoHttp;
    webhookAdminPat?: string;
  },
): Promise<void> {
  if (options.webhookAdminPat === undefined || options.webhookAdminPat.length === 0) {
    throw new ForgejoContractError("forgejo_credential_unavailable", 409, "REMOTE_CLEANUP_PENDING");
  }
  const connectionId = claimed.scope.connectionId;
  const repositoryId = claimed.scope.repositoryId;
  if (connectionId === undefined || repositoryId === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo hook was not found");
  }
  const connection = await options.directory.findConnectionById(connectionId);
  if (connection === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo connection was not found");
  }
  const instance = await requireActiveInstance(options.directory, connection.instanceId);
  const hook = await options.directory.findRepositoryHook(connection.id, repositoryId);
  if (hook === undefined || !hook.managed || hook.status !== "cleanup_failed") return;
  const repositories = await options.directory.listRepositoriesForConnection(connection.id);
  const repository = repositories.find((row) => row.repositoryId === repositoryId);
  if (repository === undefined || hook.forgejoHookId === null) {
    await options.directory.upsertRepositoryHook({
      ...hook,
      forgejoHookId: null,
      status: "unconfigured",
      lastVerifiedAt: null,
    });
    return;
  }
  await removeForgejoManagedHook({
    http: options.http,
    origin: originFromInstance(instance),
    token: options.webhookAdminPat,
    repository,
    hook,
  });
  await options.directory.upsertRepositoryHook({
    ...hook,
    forgejoHookId: null,
    status: "unconfigured",
    lastVerifiedAt: null,
  });
}

async function applyFailure(
  claimed: ForgejoRecoveryWorkRecord,
  classified: { classification: "transient" | "permanent"; typedCause: string },
  options: { directory: ForgejoDirectory; store: ForgejoRecoveryStore; clock: ForgejoClock },
): Promise<void> {
  await options.store.fail({
    id: claimed.id,
    now: options.clock.now(),
    typedCause: classified.typedCause,
    classification: classified.classification,
  });
  if (claimed.workKind !== "instance_health" || claimed.scope.instanceId === undefined) return;
  const existing = await options.directory.findInstanceById(claimed.scope.instanceId);
  if (existing === undefined) return;
  await options.directory.updateInstance({
    ...existing,
    status: instanceStatusForCause(existing.status, classified),
    lastHealthAt: options.clock.now(),
    lastHealthError: classified.typedCause,
    updatedAt: options.clock.now(),
  });
}

function instanceStatusForCause(
  current: ForgejoInstanceRecord["status"],
  classified: { classification: "transient" | "permanent"; typedCause: string },
): ForgejoInstanceRecord["status"] {
  if (current === "revoked") return current;
  if (classified.typedCause === "forgejo_version_unsupported") return "incompatible";
  if (
    classified.typedCause === "forgejo_identity_mismatch" ||
    classified.typedCause === "identity_drifted"
  ) {
    return "identity_drifted";
  }
  if (classified.typedCause === "unsafe_redirect" || classified.typedCause === "origin_drift") {
    return "identity_drifted";
  }
  return "unreachable";
}

function nextHealthAttempt(claimed: ForgejoRecoveryWorkRecord, now: Date): Date | null {
  if (
    claimed.workKind === "instance_health" ||
    claimed.workKind === "connection_health" ||
    claimed.workKind === "repository_health" ||
    claimed.workKind === "hook_health"
  ) {
    return new Date(now.getTime() + FORGEJO_HEALTH_INTERVAL_MS);
  }
  return null;
}

function identityFingerprintChanged(
  existing: ForgejoInstanceRecord,
  nextFingerprint: string,
): boolean {
  const previous = existing.externalIdentity;
  if (!isRecord(previous)) return false;
  const fingerprint = previous["fingerprint"];
  return (
    typeof fingerprint === "string" && fingerprint.length > 0 && fingerprint !== nextFingerprint
  );
}

async function requireUsableConnection(
  directory: ForgejoDirectory,
  connectionId: string | undefined,
): Promise<ForgejoConnectionRecord> {
  if (connectionId === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo connection was not found");
  }
  const connection = await directory.findConnectionById(connectionId);
  if (connection === undefined || connection.status === "disconnected") {
    throw new ForgejoContractError(
      "forgejo_credential_unavailable",
      409,
      "Forgejo connection is disconnected",
    );
  }
  return connection;
}

async function requireActiveInstance(
  directory: ForgejoDirectory,
  instanceId: string,
): Promise<ForgejoInstanceRecord> {
  const instance = await directory.findInstanceById(instanceId);
  if (instance === undefined || instance.status !== "active") {
    throw new ForgejoContractError(
      "forgejo_origin_unapproved",
      409,
      "Forgejo instance is not approved",
    );
  }
  return instance;
}

async function decryptConnectionPat(
  options: { directory: ForgejoDirectory; secrets: SecretEncryptionKeySource },
  connection: ForgejoConnectionRecord,
): Promise<string> {
  const credential = await options.directory.findActiveConnectionCredential(connection.id);
  if (credential === undefined) {
    throw new ForgejoContractError(
      "forgejo_credential_unavailable",
      409,
      "Forgejo connection credential is unavailable",
    );
  }
  return decryptSecret(
    options.secrets,
    {
      alg: "aes-256-gcm",
      keyId: credential.keyId,
      nonce: credential.nonce,
      ciphertext: credential.ciphertext,
      aadVersion: 1,
    },
    {
      organizationId: credential.organizationId,
      credentialId: credential.id,
      kind: "connection",
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
