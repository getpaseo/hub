import type { QueryHandle, QueryRow } from "./runtime/index.js";
import type { ForgejoRecoveryWorkKind, ForgejoRecoveryWorkStatus } from "./schema.js";
import { ForgejoContractError } from "../providers/forgejo/instances.js";
import {
  FORGEJO_CLAIM_LEASE_MS,
  FORGEJO_RETRY_MAX_ATTEMPTS,
  nextRetryDelayMs,
  type FailForgejoRecoveryWorkInput,
  type ForgejoRecoveryScope,
  type ForgejoRecoveryStore,
  type ForgejoRecoveryWorkRecord,
} from "../providers/forgejo/recovery-store.js";

export function createSqlForgejoRecoveryStore(runtime: QueryHandle): ForgejoRecoveryStore {
  return {
    async ensure(input) {
      const inserted = await runtime.query<WorkRow>(
        `insert into forgejo_recovery_work (
           organization_id, work_kind, work_identity, status, typed_cause, attempt_count,
           next_attempt_at, scope, created_at, updated_at
         ) values ($1, $2, $3, 'ready', null, 0, $4, $5::jsonb, $4, $4)
         on conflict (work_kind, work_identity) do nothing
         returning ${WORK_RETURNING}`,
        [
          input.organizationId,
          input.workKind,
          input.workIdentity,
          input.now,
          JSON.stringify(input.scope),
        ],
      );
      const row = inserted.rows[0] ?? (await loadWork(runtime, input.workKind, input.workIdentity));
      if (row === undefined) {
        throw new ForgejoContractError("not_found", 404, "Forgejo recovery work was not found");
      }
      return mapWork(row);
    },
    async claimNext(input) {
      const leaseMs = input.leaseMs ?? FORGEJO_CLAIM_LEASE_MS;
      const expires = new Date(input.now.getTime() + leaseMs);
      const includeCleanup = input.includeRemoteCleanup === true;
      const claimed = await runtime.query<WorkRow>(
        `update forgejo_recovery_work as work
         set status = 'claimed', claimed_by = $1, claim_expires_at = $2, updated_at = $3
         where work.id = (
           select candidate.id
           from forgejo_recovery_work as candidate
           where ${CLAIM_PREDICATE}
           order by candidate.next_attempt_at nulls first, candidate.created_at, candidate.id
           limit 1
           for update skip locked
         )
         returning ${WORK_RETURNING}`,
        [input.owner, expires, input.now, includeCleanup, input.connectionId ?? null],
      );
      const row = claimed.rows[0];
      return row === undefined ? undefined : mapWork(row);
    },
    async complete(input) {
      const rows = await runtime.query<WorkRow>(
        `update forgejo_recovery_work
         set status = 'succeeded', typed_cause = null, attempt_count = 0,
             next_attempt_at = $2, claimed_by = null, claim_expires_at = null,
             last_success_at = $3, updated_at = $3
         where id = $1
         returning ${WORK_RETURNING}`,
        [input.id, input.nextAttemptAt, input.now],
      );
      return mapRequired(rows.rows[0]);
    },
    async fail(input) {
      const current = await loadWorkById(runtime, input.id);
      const next = failedValues(current, input);
      const rows = await runtime.query<WorkRow>(
        `update forgejo_recovery_work
         set status = $2, typed_cause = $3, attempt_count = $4, next_attempt_at = $5,
             claimed_by = null, claim_expires_at = null, last_failure_at = $6, updated_at = $6
         where id = $1
         returning ${WORK_RETURNING}`,
        [input.id, next.status, next.typedCause, next.attemptCount, next.nextAttemptAt, input.now],
      );
      return mapRequired(rows.rows[0]);
    },
    async cancelForConnection(connectionId, now) {
      await runtime.query(
        `update forgejo_recovery_work
         set status = 'cancelled', claimed_by = null, claim_expires_at = null,
             next_attempt_at = null, updated_at = $2
         where work_kind <> 'remote_cleanup'
           and status not in ('cancelled', 'failed_permanent')
           and scope->>'connectionId' = $1`,
        [connectionId, now],
      );
    },
    async listForInstance(instanceId) {
      const rows = await runtime.query<WorkRow>(
        `${WORK_SELECT} where scope->>'instanceId' = $1 order by work_kind, work_identity`,
        [instanceId],
      );
      return rows.rows.map(mapWork);
    },
    async listForConnection(connectionId) {
      const rows = await runtime.query<WorkRow>(
        `${WORK_SELECT} where scope->>'connectionId' = $1 order by work_kind, work_identity`,
        [connectionId],
      );
      return rows.rows.map(mapWork);
    },
    async find(workKind, workIdentity) {
      const row = await loadWork(runtime, workKind, workIdentity);
      return row === undefined ? undefined : mapWork(row);
    },
  };
}

const WORK_RETURNING = `id, organization_id, work_kind, work_identity, status, typed_cause,
       attempt_count, next_attempt_at, claimed_by, claim_expires_at, last_success_at,
       last_failure_at, scope, created_at, updated_at`;

const WORK_SELECT = `select ${WORK_RETURNING} from forgejo_recovery_work`;

const CLAIM_PREDICATE = `(
             (
               candidate.status in ('ready', 'retry_scheduled', 'succeeded')
               and candidate.next_attempt_at is not null
               and candidate.next_attempt_at <= $3
             )
             or (
               candidate.status = 'claimed'
               and candidate.claim_expires_at is not null
               and candidate.claim_expires_at < $3
             )
           )
           and candidate.status not in ('cancelled', 'failed_permanent')
           and ($4 or candidate.work_kind <> 'remote_cleanup')
           and ($5::text is null or candidate.scope->>'connectionId' = $5)`;

interface WorkRow extends QueryRow {
  id: string;
  organization_id: string | null;
  work_kind: ForgejoRecoveryWorkKind;
  work_identity: string;
  status: ForgejoRecoveryWorkStatus;
  typed_cause: string | null;
  attempt_count: number;
  next_attempt_at: Date | null;
  claimed_by: string | null;
  claim_expires_at: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  scope: unknown;
  created_at: Date;
  updated_at: Date;
}

async function loadWork(
  runtime: QueryHandle,
  workKind: ForgejoRecoveryWorkKind,
  workIdentity: string,
): Promise<WorkRow | undefined> {
  const rows = await runtime.query<WorkRow>(
    `${WORK_SELECT} where work_kind = $1 and work_identity = $2 limit 1`,
    [workKind, workIdentity],
  );
  return rows.rows[0];
}

async function loadWorkById(runtime: QueryHandle, id: string): Promise<ForgejoRecoveryWorkRecord> {
  const rows = await runtime.query<WorkRow>(`${WORK_SELECT} where id = $1 limit 1`, [id]);
  return mapRequired(rows.rows[0]);
}

function failedValues(
  current: ForgejoRecoveryWorkRecord,
  input: FailForgejoRecoveryWorkInput,
): {
  status: ForgejoRecoveryWorkStatus;
  typedCause: string;
  attemptCount: number;
  nextAttemptAt: Date | null;
} {
  const attemptCount = current.attemptCount + 1;
  if (input.classification === "permanent" || attemptCount >= FORGEJO_RETRY_MAX_ATTEMPTS) {
    return {
      status: "failed_permanent",
      typedCause: input.typedCause,
      attemptCount,
      nextAttemptAt: null,
    };
  }
  return {
    status: "retry_scheduled",
    typedCause: input.typedCause,
    attemptCount,
    nextAttemptAt: new Date(input.now.getTime() + nextRetryDelayMs(attemptCount)),
  };
}

function mapRequired(row: WorkRow | undefined): ForgejoRecoveryWorkRecord {
  if (row === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo recovery work was not found");
  }
  return mapWork(row);
}

function mapWork(row: WorkRow): ForgejoRecoveryWorkRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workKind: row.work_kind,
    workIdentity: row.work_identity,
    status: row.status,
    typedCause: row.typed_cause,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    claimedBy: row.claimed_by,
    claimExpiresAt: row.claim_expires_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    scope: parseScope(row.scope),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseScope(value: unknown): ForgejoRecoveryScope {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value["instanceId"] === "string" ? { instanceId: value["instanceId"] } : {}),
    ...(typeof value["connectionId"] === "string" ? { connectionId: value["connectionId"] } : {}),
    ...(typeof value["repositoryId"] === "number" ? { repositoryId: value["repositoryId"] } : {}),
    ...(typeof value["receiptId"] === "string" ? { receiptId: value["receiptId"] } : {}),
    ...(typeof value["hookId"] === "string" ? { hookId: value["hookId"] } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
