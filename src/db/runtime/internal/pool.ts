import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import { DatabaseUnavailableError } from "../../errors.js";
import { reportFailure } from "../../../failures/index.js";
import { errorForLog } from "../../../logger.js";

const QUERY_DEADLINE_MS = 3_000;

/** @package */
export function createPool(connectionString: string): PostgresPool {
  return new PostgresPool(connectionString);
}

/** @package */
export class PostgresPool extends Pool {
  private readonly scrubValues: string[];
  private readonly queryPhase = new AsyncLocalStorage<{ value: "acquire" | "query" }>();

  constructor(connectionString: string) {
    super({
      connectionString,
      connectionTimeoutMillis: QUERY_DEADLINE_MS,
      query_timeout: QUERY_DEADLINE_MS,
      statement_timeout: QUERY_DEADLINE_MS,
    });
    const idleSince = new WeakMap<PoolClient, number>();
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
        if (error) this.failure(error, "query", started, queryScrubValues(args));
      });
    });
    this.on("release", (_error, client) => idleSince.set(client, performance.now()));
    this.on("acquire", (client) => idleSince.delete(client));
    this.on("error", (error, client) => {
      this.failure(error, "idle", idleSince.get(client) ?? performance.now());
      reportFailure(error, { operation: "database.postgres.pool", component: "database" });
    });
  }

  private failure(
    error: unknown,
    phase: "acquire" | "query" | "idle",
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
            this.failure(error, phase.value, started);
            reject(error);
          }, QUERY_DEADLINE_MS);
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
