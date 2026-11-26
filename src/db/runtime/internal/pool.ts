import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { DatabaseUnavailableError } from "../../errors.js";
import { reportFailure } from "../../../failures/index.js";
import { errorForLog } from "../../../logger.js";

const ACQUIRE_TIMEOUT_MS = 3_000;
/** PostgreSQL cancels the statement itself; the connection stays in sync and usable. */
const STATEMENT_TIMEOUT_MS = 3_000;
/**
 * The client gives up only after the server should have cancelled, so reaching it means the
 * server or network stopped answering. The statement is still pending on that socket, so the
 * connection is destroyed on release instead of being reused.
 */
const CLIENT_DEADLINE_MS = 5_000;

/** @package */
export function createPool(connectionString: string): PostgresPool {
  return new PostgresPool(connectionString);
}

/** @package */
export class PostgresPool extends Pool {
  private readonly scrubValues: string[];
  private readonly queryPhase = new AsyncLocalStorage<{ value: "acquire" | "query" }>();
  /** The first query failure of each client's current checkout. */
  private readonly checkoutFailures = new WeakMap<PoolClient, Error>();

  constructor(connectionString: string) {
    super({
      connectionString,
      connectionTimeoutMillis: ACQUIRE_TIMEOUT_MS,
      query_timeout: CLIENT_DEADLINE_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
    const idleSince = new WeakMap<PoolClient, number>();
    const acquiredAt = new WeakMap<PoolClient, number>();
    const url = new URL(connectionString);
    this.scrubValues = [connectionString, url.password, decodeURIComponent(url.password)];

    // The observer forwards pg's receiver through Reflect.apply.
    // oxlint-disable-next-line typescript-eslint/unbound-method
    this.connect = observe(this.connect, (started) => {
      const phase = this.queryPhase.getStore();
      return (error) => {
        if (error) this.failure(error, "acquire", started);
        else if (phase !== undefined) phase.value = "query";
      };
    });
    this.on("connect", (client) => {
      // oxlint-disable-next-line typescript-eslint/unbound-method
      client.query = observe(client.query, (started, args) => (error) => {
        if (!error) return;
        this.recordCheckoutFailure(client, error);
        this.failure(error, "query", started, queryScrubValues(args));
      });
      // pg-pool listens for errors only while a client is idle. A socket that closes while the
      // client is checked out would otherwise emit an unhandled 'error' and end the process.
      client.on("error", (error) => {
        if (idleSince.has(client)) return;
        this.failure(error, "checkedOut", acquiredAt.get(client) ?? performance.now());
        reportFailure(error, { operation: "database.postgres.client", component: "database" });
      });
    });
    this.on("release", (_error, client) => idleSince.set(client, performance.now()));
    this.on("acquire", (client) => {
      idleSince.delete(client);
      acquiredAt.set(client, performance.now());
      this.checkoutFailures.delete(client);
    });
    this.on("error", (error, client) => {
      this.failure(error, "idle", idleSince.get(client) ?? performance.now());
      reportFailure(error, { operation: "database.postgres.pool", component: "database" });
    });
    // Release async context tracking when the owning pool finishes closing.
    // oxlint-disable-next-line typescript-eslint/unbound-method
    this.end = observe(this.end, () => () => this.queryPhase.disable());
  }

  /** Whether a query failed during the client's current checkout. */
  hasFailed(client: PoolClient): boolean {
    return this.checkoutFailures.has(client);
  }

  /**
   * Return a checked-out client. A client whose query failed may still have that query pending
   * or its transaction open, so pg-pool destroys it and opens a fresh connection when needed.
   */
  release(client: PoolClient): void {
    client.release(this.checkoutFailures.get(client));
  }

  private recordCheckoutFailure(client: PoolClient, error: unknown) {
    if (this.checkoutFailures.has(client)) return;
    this.checkoutFailures.set(client, error instanceof Error ? error : new Error(String(error)));
  }

  private failure(
    error: unknown,
    phase: "acquire" | "query" | "idle" | "checkedOut",
    started: number,
    scrubValues: readonly string[] = [],
  ) {
    if (error instanceof Error) {
      // PostgreSQL messages quote user values and identifiers. Never log those, SQL text,
      // parameters, detail, or the pg error's client (which contains connection credentials).
      const diagnosticMessage = error.message
        .replace(/\b(?:postgres(?:ql)?):\/\/\S+/giu, "[Redacted]")
        .replace(/"(?:[^"\\]|\\.|"")*"|'(?:[^'\\]|\\.|'')*'/gu, "[Redacted]");
      errorForLog(error, {
        diagnosticMessage,
        scrubValues: [...this.scrubValues, ...scrubValues],
        diagnostic: {
          phase,
          elapsedMs: Math.round(performance.now() - started),
          pool: { total: this.totalCount, idle: this.idleCount, waiting: this.waitingCount },
        },
      });
    }
  }

  async runQuery<Row extends QueryResultRow>(
    client: PoolClient | undefined,
    sql: string,
    params: readonly unknown[],
  ) {
    const started = performance.now();
    const phase: { value: "acquire" | "query" } = {
      value: client === undefined ? "acquire" : "query",
    };
    let timeout: NodeJS.Timeout | undefined;
    const operation = this.queryPhase.run(phase, () =>
      (client ?? this).query<Row>(sql, [...params]),
    );
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new DatabaseUnavailableError("database query timed out");
            if (client !== undefined) this.recordCheckoutFailure(client, error);
            this.failure(error, phase.value, started);
            reject(error);
          }, CLIENT_DEADLINE_MS);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

/** Preserve pg's callback and promise overloads, including pool.query's internal callbacks. */
function observe<T extends (...args: never[]) => unknown>(
  operation: T,
  onStart: (started: number, args: unknown[]) => (error: unknown) => void,
): T {
  return new Proxy(operation, {
    apply(target, receiver: unknown, args: unknown[]) {
      const settled = onStart(performance.now(), args);
      const callback = args.at(-1);
      if (typeof callback === "function") {
        args[args.length - 1] = (...results: unknown[]) => {
          settled(results[0]);
          const result: unknown = Reflect.apply(callback, undefined, results);
          return result;
        };
      }
      try {
        const result: unknown = Reflect.apply(target, receiver, args);
        if (result instanceof Promise) {
          return result.then(
            (value: unknown) => {
              settled(undefined);
              return value;
            },
            (error: unknown) => {
              settled(error);
              throw error;
            },
          );
        }
        return result;
      } catch (error) {
        settled(error);
        throw error;
      }
    },
  });
}

function queryScrubValues(args: unknown[]): string[] {
  const config = args[0];
  const values: unknown =
    typeof config === "object" && config !== null && "values" in config ? config.values : args[1];
  return Array.isArray(values)
    ? values.filter((value: unknown): value is string => typeof value === "string")
    : [];
}
