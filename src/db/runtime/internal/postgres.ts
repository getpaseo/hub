import { basename } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { reportFailure } from "../../../failures/index.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, type PoolClient } from "pg";
import { createPool, type PostgresPool } from "./pool.js";
export { createPool } from "./pool.js";
import * as schema from "../../schema.js";
import { toDatabaseError } from "../../errors.js";
import { TransactionRollback } from "../index.js";
import type {
  DatabaseRuntime,
  DatabaseRuntimeBundle,
  QueryHandle,
  DrizzleHandle,
  QueryResult,
  QueryRow,
  TransactionHandle,
} from "../index.js";
import { postgresLocks } from "../locks/index.js";
import { runtimeFile } from "../../../runtime-files.js";

const MIGRATIONS_FOLDER = runtimeFile("drizzle");
const DEFAULT_POSTGRES_DATABASE = "postgres";
const MIGRATION_LOCK_KEY = "paseo-hub:migrations";
const MIGRATION_CONNECT_TIMEOUT_MS = 10_000;

export async function createPostgresRuntime(
  connectionString: string,
): Promise<DatabaseRuntimeBundle> {
  await ensureDatabaseExists(connectionString);
  const pool = createPool(connectionString);
  const runtime = new PostgresRuntime(pool, connectionString);
  return {
    runtime,
    locks: postgresLocks((operation) => runtime.withConnection(operation)),
  };
}

class PostgresRuntime implements DatabaseRuntime {
  private readonly database;

  constructor(
    private readonly pool: PostgresPool,
    private readonly connectionString: string,
  ) {
    this.database = drizzle(pool, { schema });
  }

  query<Row extends QueryRow = QueryRow>(sql: string, params: readonly unknown[] = []) {
    return query<Row>(this.pool, sql, params);
  }

  async transaction<T>(operation: (transaction: TransactionHandle) => Promise<T>): Promise<T> {
    return this.checkout(async (client) => {
      const connection = new PostgresTransactionHandle(client, this.pool);
      await connection.query("begin");
      try {
        const result = await operation(connection);
        await connection.query("commit");
        return result;
      } catch (error) {
        // A failed query means the connection is destroyed on release, which ends the
        // transaction server-side. A ROLLBACK would only queue behind a stalled statement.
        if (!this.pool.hasFailed(client)) await rollback(connection);
        // The rollback value originated in this same generic transaction callback.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        if (error instanceof TransactionRollback) return error.result as T;
        throw error;
      }
    });
  }

  drizzle() {
    // Drizzle's driver query-result generics are invariant; the shared public surface hides the
    // node-postgres result envelope while preserving the PostgreSQL-dialect query builders.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return this.database as unknown as DrizzleHandle;
  }

  async migrate(): Promise<void> {
    const scrubValues = connectionScrubValues(this.connectionString);
    const client = new Client({
      connectionString: this.connectionString,
      connectionTimeoutMillis: MIGRATION_CONNECT_TIMEOUT_MS,
    });
    client.on("error", (error) => {
      reportFailure(
        error,
        {
          operation: "database.postgres.migrate.client",
          component: "database",
        },
        { scrubValues },
      );
    });
    await client.connect();
    let locked = false;
    try {
      // Dedicated migration session: never inherit the pool's 3s statement_timeout or 5s
      // query_timeout, and override any low database/role default so DDL and lock waits complete.
      await client.query("set statement_timeout = 0");
      await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [MIGRATION_LOCK_KEY]);
      locked = true;
      await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      if (locked) {
        try {
          await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [
            MIGRATION_LOCK_KEY,
          ]);
        } catch (error) {
          reportFailure(
            error,
            {
              operation: "database.postgres.migrate.unlock",
              component: "database",
            },
            { scrubValues },
          );
        }
      }
      await client.end().catch((error: unknown) => {
        reportFailure(
          error,
          {
            operation: "database.postgres.migrate.close",
            component: "database",
          },
          { scrubValues },
        );
      });
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  withConnection<T>(operation: (connection: QueryHandle) => Promise<T>): Promise<T> {
    return this.checkout((client) => operation(new PostgresQueryHandle(client, this.pool)));
  }

  private async checkout<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await operation(client);
    } finally {
      this.pool.release(client);
    }
  }
}

class PostgresQueryHandle implements TransactionHandle {
  constructor(
    private readonly client: PoolClient,
    private readonly pool: PostgresPool,
  ) {}

  query<Row extends QueryRow = QueryRow>(sql: string, params: readonly unknown[] = []) {
    return query<Row>(this.pool, sql, params, this.client);
  }

  drizzle() {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    return drizzle(this.client, { schema }) as unknown as DrizzleHandle;
  }

  rollback(result: unknown): never {
    throw new TransactionRollback(result);
  }
}

class PostgresTransactionHandle extends PostgresQueryHandle {}

async function rollback(connection: PostgresTransactionHandle): Promise<void> {
  try {
    await connection.query("rollback");
  } catch (rollbackError) {
    reportFailure(rollbackError, {
      operation: "database.postgres.transaction.rollback",
      component: "database",
    });
  }
}

async function ensureDatabaseExists(connectionString: string): Promise<void> {
  const targetPool = createPool(connectionString);
  try {
    await query(targetPool, "select 1", []);
    return;
  } catch (error) {
    if (!isMissingDatabaseError(error)) throw toDatabaseError(error);
  } finally {
    await targetPool.end();
  }

  const targetUrl = new URL(connectionString);
  const databaseName = basename(targetUrl.pathname);
  const postgresUrl = new URL(connectionString);
  postgresUrl.pathname = `/${DEFAULT_POSTGRES_DATABASE}`;
  const pool = createPool(postgresUrl.toString());
  try {
    const exists = await query(pool, "select 1 from pg_database where datname = $1", [
      databaseName,
    ]);
    if (exists.rowCount === 0)
      await query(pool, `create database ${quoteIdentifier(databaseName)}`, []);
  } catch (error) {
    throw toDatabaseError(error);
  } finally {
    await pool.end();
  }
}

function isMissingDatabaseError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "3D000";
}

async function query<Row extends QueryRow>(
  pool: PostgresPool,
  sql: string,
  params: readonly unknown[],
  client?: PoolClient,
): Promise<QueryResult<Row>> {
  const result = await pool.runQuery<Row>(client, sql, params);
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid database name: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
}

function connectionScrubValues(connectionString: string): string[] {
  try {
    const url = new URL(connectionString);
    return [connectionString, url.password, decodeURIComponent(url.password)].filter(
      (value) => value.length > 0,
    );
  } catch {
    return [connectionString];
  }
}
