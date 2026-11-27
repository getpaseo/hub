import type { QueryHandle, TransactionHandle } from "../../index.js";
import type { Locks, TryLockResult } from "../index.js";
import { reportFailure } from "../../../../failures/index.js";

export class PostgresLocks implements Locks {
  constructor(
    private readonly withConnection: <T>(
      operation: (connection: QueryHandle) => Promise<T>,
    ) => Promise<T>,
  ) {}

  withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.withConnection(async (connection) => {
      await connection.query(`select pg_advisory_lock(hashtextextended($1, 0))`, [key]);
      try {
        return await operation();
      } finally {
        try {
          await connection.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [key]);
        } catch (error) {
          reportFailure(error, {
            operation: "database.postgres.advisory_lock.release",
            component: "database",
          });
        }
      }
    });
  }

  tryWithLock<T>(key: string, operation: () => Promise<T>): Promise<TryLockResult<T>> {
    return this.withConnection(async (connection) => {
      const result = await connection.query<{ acquired: boolean }>(
        `select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired`,
        [key],
      );
      if (result.rows[0]?.acquired !== true) return { acquired: false };
      try {
        return { acquired: true, value: await operation() };
      } finally {
        try {
          await connection.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [key]);
        } catch (error) {
          reportFailure(error, {
            operation: "database.postgres.advisory_lock.release",
            component: "database",
          });
        }
      }
    });
  }

  async withTxLock(transaction: TransactionHandle, key: string): Promise<void> {
    await transaction.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
}
