import { createPostgresQueryRuntime } from "./runtime.js";

type QueryRuntime = Awaited<ReturnType<typeof createPostgresQueryRuntime>>;

/**
 * Makes one test database fail the way a stalled or restarting Postgres looks to Hub, while the
 * server itself keeps running. The administrative connection uses the server's `postgres`
 * database, so it stays up throughout.
 */
export class PostgresOutage {
  private constructor(
    private readonly connectionString: string,
    private readonly admin: QueryRuntime,
    private readonly databaseName: string,
  ) {}

  static async connect(connectionString: string): Promise<PostgresOutage> {
    const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
    const admin = new URL(connectionString);
    admin.pathname = "/postgres";
    return new PostgresOutage(
      connectionString,
      await createPostgresQueryRuntime(admin.toString()),
      databaseName,
    );
  }

  /** Terminates every open connection to the database and refuses new ones. */
  async begin(): Promise<void> {
    await this.admin.query(
      `alter database ${quote(this.databaseName)} with allow_connections false`,
    );
    await this.admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [this.databaseName],
    );
  }

  async end(): Promise<void> {
    await this.admin.query(
      `alter database ${quote(this.databaseName)} with allow_connections true`,
    );
  }

  /**
   * Holds an exclusive lock on `table`, so every statement that touches it waits until the
   * server's statement timeout cancels it. Resolves once the lock is held.
   */
  async stall(table: string): Promise<{ release(): Promise<void> }> {
    const runtime = await createPostgresQueryRuntime(this.connectionString);
    let locked: (() => void) | undefined;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = runtime.transaction(async (connection) => {
      await connection.query(`lock table ${quote(table)} in access exclusive mode`);
      locked?.();
      await released;
    });
    await Promise.race([held, transaction]);
    return {
      async release() {
        release?.();
        await transaction;
        await runtime.close();
      },
    };
  }

  close(): Promise<void> {
    return this.admin.close();
  }
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
