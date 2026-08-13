import type { QueryHandle, TransactionHandle } from "../../index.js";
import type { Locks } from "../index.js";

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
        await connection
          .query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [key])
          .catch(() => undefined);
      }
    });
  }

  async withTxLock(transaction: TransactionHandle, key: string): Promise<void> {
    await transaction.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }
}
