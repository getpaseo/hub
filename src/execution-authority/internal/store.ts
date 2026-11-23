import type { QueryHandle } from "../../db/runtime/index.js";

export interface ExecutionCredentialLease {
  id: string;
  executionId: string;
  token: string;
  provider: "github";
  expiresAt: number;
  deadlineAt: number;
  revoking: boolean;
  attempts: number;
  nextAttemptAt: number;
}

export interface ExecutionAuthorityRecord {
  executionId: string;
  env: Record<string, string>;
  leaseIds: string[];
}

export interface ExecutionAuthorityStore {
  executions(): Promise<string[]>;
  read(executionId: string): Promise<ExecutionAuthorityRecord | undefined>;
  commit(record: ExecutionAuthorityRecord): Promise<ExecutionAuthorityRecord>;
  remove(executionId: string): Promise<void>;
  leases(executionId?: string): Promise<ExecutionCredentialLease[]>;
  saveLease(lease: ExecutionCredentialLease): Promise<void>;
  removeLease(id: string): Promise<void>;
}

export class ExecutionAuthorityRepository implements ExecutionAuthorityStore {
  constructor(private readonly database: QueryHandle) {}

  async executions() {
    const result = await this.database.query<{ execution_id: string }>(
      "select execution_id from execution_authorities",
    );
    return result.rows.map((row) => row.execution_id);
  }

  async read(executionId: string) {
    const result = await this.database.query<{ data: ExecutionAuthorityRecord }>(
      "select data from execution_authorities where execution_id = $1",
      [executionId],
    );
    return result.rows[0]?.data;
  }

  async commit(record: ExecutionAuthorityRecord) {
    await this.database.query(
      `insert into execution_authorities (execution_id, data) values ($1, $2)
       on conflict (execution_id) do nothing`,
      [record.executionId, record],
    );
    const stored = await this.read(record.executionId);
    if (!stored) throw new Error("Execution authority disappeared during materialization");
    return stored;
  }

  async remove(executionId: string) {
    await this.database.query("delete from execution_authorities where execution_id = $1", [
      executionId,
    ]);
  }

  async leases(executionId?: string) {
    const result = await this.database.query<{ data: ExecutionCredentialLease }>(
      executionId === undefined
        ? "select data from execution_credential_leases"
        : "select data from execution_credential_leases where execution_id = $1",
      executionId === undefined ? [] : [executionId],
    );
    return result.rows.map((row) => row.data);
  }

  async saveLease(lease: ExecutionCredentialLease) {
    await this.database.query(
      `insert into execution_credential_leases (id, execution_id, data) values ($1, $2, $3)
       on conflict (id) do update set data = excluded.data`,
      [lease.id, lease.executionId, lease],
    );
  }

  async removeLease(id: string) {
    await this.database.query("delete from execution_credential_leases where id = $1", [id]);
  }
}
