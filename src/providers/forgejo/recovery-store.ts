import { randomUUID } from "node:crypto";
import type { ProviderEventReceiptRecord } from "../../db/types.js";
import type { ForgejoRecoveryWorkKind, ForgejoRecoveryWorkStatus } from "../../db/schema.js";
import { ForgejoContractError } from "./instances.js";
import { ApprovedOriginError } from "../../http/approved-origin.js";
import type { ForgejoVerifiedDelivery } from "../../triggers/forgejo/webhook.js";

export const FORGEJO_HEALTH_TIMEOUT_MS = 10_000;
export const FORGEJO_HEALTH_INTERVAL_MS = 300_000;
export const FORGEJO_RETRY_INITIAL_MS = 1_000;
export const FORGEJO_RETRY_MULTIPLIER = 2;
export const FORGEJO_RETRY_MAX_MS = 60_000;
export const FORGEJO_RETRY_MAX_ATTEMPTS = 8;
export const FORGEJO_CLAIM_LEASE_MS = 30_000;
export const PERMANENT_HTTP_STATUSES = new Set([401, 403, 404, 405, 409, 422]);

export interface ForgejoClock {
  now(): Date;
}

export interface ForgejoReceiptRecoverySource {
  listAbandoned(): Promise<readonly ProviderEventReceiptRecord[]>;
  markDispatched(receiptId: string): Promise<void>;
}

export type { ForgejoRecoveryWorkKind, ForgejoRecoveryWorkStatus };

export interface ForgejoRecoveryWorkRecord {
  id: string;
  organizationId: string | null;
  workKind: ForgejoRecoveryWorkKind;
  workIdentity: string;
  status: ForgejoRecoveryWorkStatus;
  typedCause: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  scope: ForgejoRecoveryScope;
  createdAt: Date;
  updatedAt: Date;
}

export interface ForgejoRecoveryScope {
  instanceId?: string;
  connectionId?: string;
  repositoryId?: number;
  receiptId?: string;
  hookId?: string;
}

export interface EnsureForgejoRecoveryWorkInput {
  organizationId: string | null;
  workKind: ForgejoRecoveryWorkKind;
  workIdentity: string;
  scope: ForgejoRecoveryScope;
  now: Date;
}

export interface ClaimForgejoRecoveryWorkInput {
  owner: string;
  now: Date;
  leaseMs?: number;
  includeRemoteCleanup?: boolean;
  connectionId?: string;
}

export interface CompleteForgejoRecoveryWorkInput {
  id: string;
  now: Date;
  nextAttemptAt: Date | null;
}

export interface FailForgejoRecoveryWorkInput {
  id: string;
  now: Date;
  typedCause: string;
  classification: "transient" | "permanent";
}

export interface ForgejoRecoveryStore {
  ensure(input: EnsureForgejoRecoveryWorkInput): Promise<ForgejoRecoveryWorkRecord>;
  claimNext(input: ClaimForgejoRecoveryWorkInput): Promise<ForgejoRecoveryWorkRecord | undefined>;
  complete(input: CompleteForgejoRecoveryWorkInput): Promise<ForgejoRecoveryWorkRecord>;
  fail(input: FailForgejoRecoveryWorkInput): Promise<ForgejoRecoveryWorkRecord>;
  cancelForConnection(connectionId: string, now: Date): Promise<void>;
  listForInstance(instanceId: string): Promise<ForgejoRecoveryWorkRecord[]>;
  listForConnection(connectionId: string): Promise<ForgejoRecoveryWorkRecord[]>;
  find(
    workKind: ForgejoRecoveryWorkKind,
    workIdentity: string,
  ): Promise<ForgejoRecoveryWorkRecord | undefined>;
}

export function forgejoWorkIdentity(kind: ForgejoRecoveryWorkKind, id: string): string {
  return `${kind}:${id}`;
}

export function forgejoDeliveryFromReceipt(
  receipt: ProviderEventReceiptRecord,
): ForgejoVerifiedDelivery | undefined {
  if (receipt.provider !== "forgejo") return undefined;
  if (receipt.connectionId === null || receipt.resourceId === null) return undefined;
  if (!isRecord(receipt.payload)) return undefined;
  const headers = receipt.payload["headers"];
  const raw = receipt.payload["raw"];
  if (!isRecord(headers) || typeof raw !== "string") return undefined;
  const event = headers["x-forgejo-event"];
  const eventType = headers["x-forgejo-event-type"];
  if (typeof event !== "string" || typeof eventType !== "string") return undefined;
  const repositoryId = Number(receipt.resourceId);
  if (!Number.isInteger(repositoryId)) return undefined;
  return {
    connectionId: receipt.connectionId,
    organizationId: receipt.organizationId,
    repositoryId,
    deliveryId: receipt.deliveryId,
    event,
    eventType,
    signatureHash: receipt.signatureHash ?? "",
    rawBody: new TextEncoder().encode(raw),
    receivedAt: receipt.receivedAt,
  };
}

export function nextRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  const delay = FORGEJO_RETRY_INITIAL_MS * FORGEJO_RETRY_MULTIPLIER ** exponent;
  return Math.min(delay, FORGEJO_RETRY_MAX_MS);
}

export function classifyForgejoRecoveryFailure(error: unknown): {
  classification: "transient" | "permanent";
  typedCause: string;
} {
  if (error instanceof ApprovedOriginError) {
    return { classification: "permanent", typedCause: error.code };
  }
  if (error instanceof ForgejoContractError) {
    return classifyContractError(error);
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { classification: "transient", typedCause: "timeout" };
  }
  if (error instanceof Error) {
    return { classification: "transient", typedCause: "unreachable" };
  }
  return { classification: "transient", typedCause: "unreachable" };
}

export function createMemoryForgejoRecoveryStore(
  seed: readonly ForgejoRecoveryWorkRecord[] = [],
): ForgejoRecoveryStore {
  const rows = new Map(seed.map((row) => [row.id, cloneWork(row)]));
  return {
    async ensure(input) {
      const existing = [...rows.values()].find(
        (row) => row.workKind === input.workKind && row.workIdentity === input.workIdentity,
      );
      if (existing !== undefined) return cloneWork(existing);
      const created: ForgejoRecoveryWorkRecord = {
        id: randomUUID(),
        organizationId: input.organizationId,
        workKind: input.workKind,
        workIdentity: input.workIdentity,
        status: "ready",
        typedCause: null,
        attemptCount: 0,
        nextAttemptAt: input.now,
        claimedBy: null,
        claimExpiresAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        scope: { ...input.scope },
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.set(created.id, created);
      return cloneWork(created);
    },
    async claimNext(input) {
      const leaseMs = input.leaseMs ?? FORGEJO_CLAIM_LEASE_MS;
      const candidate = dueWork(rows, input).at(0);
      if (candidate === undefined) return undefined;
      const claimed: ForgejoRecoveryWorkRecord = {
        ...candidate,
        status: "claimed",
        claimedBy: input.owner,
        claimExpiresAt: new Date(input.now.getTime() + leaseMs),
        updatedAt: input.now,
      };
      rows.set(claimed.id, claimed);
      return cloneWork(claimed);
    },
    async complete(input) {
      const current = requireWork(rows, input.id);
      const completed: ForgejoRecoveryWorkRecord = {
        ...current,
        status: "succeeded",
        typedCause: null,
        attemptCount: 0,
        nextAttemptAt: input.nextAttemptAt,
        claimedBy: null,
        claimExpiresAt: null,
        lastSuccessAt: input.now,
        updatedAt: input.now,
      };
      rows.set(completed.id, completed);
      return cloneWork(completed);
    },
    async fail(input) {
      const current = requireWork(rows, input.id);
      const failed = failedWork(current, input);
      rows.set(failed.id, failed);
      return cloneWork(failed);
    },
    async cancelForConnection(connectionId, now) {
      for (const row of rows.values()) {
        if (row.scope.connectionId !== connectionId) continue;
        if (row.workKind === "remote_cleanup") continue;
        if (row.status === "cancelled" || row.status === "failed_permanent") continue;
        rows.set(row.id, {
          ...row,
          status: "cancelled",
          claimedBy: null,
          claimExpiresAt: null,
          nextAttemptAt: null,
          updatedAt: now,
        });
      }
    },
    async listForInstance(instanceId) {
      return listed(rows, (row) => row.scope.instanceId === instanceId);
    },
    async listForConnection(connectionId) {
      return listed(rows, (row) => row.scope.connectionId === connectionId);
    },
    async find(workKind, workIdentity) {
      const row = [...rows.values()].find(
        (candidate) => candidate.workKind === workKind && candidate.workIdentity === workIdentity,
      );
      return row === undefined ? undefined : cloneWork(row);
    },
  };
}

function classifyContractError(error: ForgejoContractError): {
  classification: "transient" | "permanent";
  typedCause: string;
} {
  if (PERMANENT_HTTP_STATUSES.has(error.status)) {
    return { classification: "permanent", typedCause: error.code };
  }
  if (
    error.code === "forgejo_version_unsupported" ||
    error.code === "forgejo_identity_mismatch" ||
    error.code === "forgejo_credential_unavailable"
  ) {
    return { classification: "permanent", typedCause: error.code };
  }
  return { classification: "transient", typedCause: error.code };
}

function dueWork(
  rows: Map<string, ForgejoRecoveryWorkRecord>,
  input: ClaimForgejoRecoveryWorkInput,
): ForgejoRecoveryWorkRecord[] {
  const due: ForgejoRecoveryWorkRecord[] = [];
  for (const row of rows.values()) {
    if (!isClaimable(row, input)) continue;
    due.push(row);
  }
  due.sort(compareDue);
  return due;
}

function isClaimable(
  row: ForgejoRecoveryWorkRecord,
  input: ClaimForgejoRecoveryWorkInput,
): boolean {
  if (row.workKind === "remote_cleanup" && input.includeRemoteCleanup !== true) return false;
  if (input.connectionId !== undefined && row.scope.connectionId !== input.connectionId) {
    return false;
  }
  if (row.status === "cancelled" || row.status === "failed_permanent") return false;
  if (row.status === "claimed") {
    return row.claimExpiresAt !== null && row.claimExpiresAt.getTime() < input.now.getTime();
  }
  if (row.status !== "ready" && row.status !== "retry_scheduled" && row.status !== "succeeded") {
    return false;
  }
  if (row.nextAttemptAt === null) return false;
  return row.nextAttemptAt.getTime() <= input.now.getTime();
}

function compareDue(left: ForgejoRecoveryWorkRecord, right: ForgejoRecoveryWorkRecord): number {
  const leftAt = left.nextAttemptAt?.getTime() ?? 0;
  const rightAt = right.nextAttemptAt?.getTime() ?? 0;
  if (leftAt !== rightAt) return leftAt - rightAt;
  return left.createdAt.getTime() - right.createdAt.getTime();
}

function failedWork(
  current: ForgejoRecoveryWorkRecord,
  input: FailForgejoRecoveryWorkInput,
): ForgejoRecoveryWorkRecord {
  const attemptCount = current.attemptCount + 1;
  if (input.classification === "permanent" || attemptCount >= FORGEJO_RETRY_MAX_ATTEMPTS) {
    return {
      ...current,
      status: "failed_permanent",
      typedCause: input.typedCause,
      attemptCount,
      nextAttemptAt: null,
      claimedBy: null,
      claimExpiresAt: null,
      lastFailureAt: input.now,
      updatedAt: input.now,
    };
  }
  return {
    ...current,
    status: "retry_scheduled",
    typedCause: input.typedCause,
    attemptCount,
    nextAttemptAt: new Date(input.now.getTime() + nextRetryDelayMs(attemptCount)),
    claimedBy: null,
    claimExpiresAt: null,
    lastFailureAt: input.now,
    updatedAt: input.now,
  };
}

function requireWork(
  rows: Map<string, ForgejoRecoveryWorkRecord>,
  id: string,
): ForgejoRecoveryWorkRecord {
  const current = rows.get(id);
  if (current === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo recovery work was not found");
  }
  return current;
}

function listed(
  rows: Map<string, ForgejoRecoveryWorkRecord>,
  match: (row: ForgejoRecoveryWorkRecord) => boolean,
): ForgejoRecoveryWorkRecord[] {
  return [...rows.values()].filter(match).map(cloneWork);
}

function cloneWork(row: ForgejoRecoveryWorkRecord): ForgejoRecoveryWorkRecord {
  return { ...row, scope: { ...row.scope } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
