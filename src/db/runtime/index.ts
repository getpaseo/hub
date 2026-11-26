import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import type * as schema from "../schema.js";
import type { Locks } from "./locks/index.js";
import { createEmbeddedRuntime } from "./internal/embedded.js";
import { createPostgresRuntime } from "./internal/postgres.js";

export type QueryRow = Record<string, unknown>;

export interface QueryResult<Row extends QueryRow = QueryRow> {
  rows: Row[];
  rowCount: number;
}

export interface QueryHandle {
  query<Row extends QueryRow = QueryRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface TransactionHandle extends QueryHandle {
  drizzle(): DrizzleHandle;
  rollback(result: unknown): never;
}
interface RuntimeDrizzleResult<Row> {
  rows: Row[];
  rowCount: number;
}

interface RuntimeQueryResultHKT extends PgQueryResultHKT {
  type: RuntimeDrizzleResult<this["row"]>;
}

/**
 * The driver-neutral PostgreSQL-dialect Drizzle surface consumed by repositories. It has no
 * `transaction()`: open transactions with `DatabaseRuntime.transaction` and use its `drizzle()`.
 * Drizzle's node-postgres transaction sends BEGIN before it starts the code that returns the
 * connection, so a failed BEGIN keeps that connection out of the pool for good.
 */
export type DrizzleHandle = Omit<PgDatabase<RuntimeQueryResultHKT, typeof schema>, "transaction">;

export interface DatabaseRuntime extends QueryHandle {
  transaction<T>(operation: (transaction: TransactionHandle) => Promise<T>): Promise<T>;
  drizzle(): DrizzleHandle;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseRuntimeBundle {
  runtime: DatabaseRuntime;
  locks: Locks;
}

export function postgresDatabaseRuntime(connectionString: string): Promise<DatabaseRuntimeBundle> {
  return createPostgresRuntime(connectionString);
}

export function embeddedDatabaseRuntime(dataDirectory: string): Promise<DatabaseRuntimeBundle> {
  return createEmbeddedRuntime(dataDirectory);
}

/** @package */
export class TransactionRollback {
  constructor(readonly result: unknown) {}
}
