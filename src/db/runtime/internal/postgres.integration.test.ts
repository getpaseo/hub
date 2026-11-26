import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { Writable } from "node:stream";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, it } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { reportFailure, runWithFailureTracking } from "../../../failures/index.js";
import { createLogger } from "../../../logger.js";
import type { TransactionHandle } from "../index.js";
import { DatabaseUnavailableError } from "../../errors.js";
import { PostgresOutage } from "../../test-utils/outage.js";
import { createPool, createPostgresRuntime } from "./postgres.js";

const diagnosticSchema = z.object({
  phase: z.enum(["acquire", "query", "idle", "checkedOut"]),
  elapsedMs: z.number().nonnegative(),
  pool: z.object({ total: z.number(), idle: z.number(), waiting: z.number() }),
});
const recordSchema = z.object({
  operation: z.string(),
  err: z.object({ message: z.string(), code: z.string().nullable(), diagnostic: diagnosticSchema }),
});

function capture() {
  let output = "";
  const logger = createLogger(
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString();
        done();
      },
    }),
  );
  return {
    logger,
    async rejects(operation: Promise<unknown>, message?: RegExp) {
      await assert.rejects(operation, (error: unknown) => {
        if (message !== undefined) {
          assert.ok(error instanceof Error);
          assert.match(error.message, message);
        }
        reportFailure(
          error,
          { operation: "consumer.database.query", component: "database" },
          { logger },
        );
        return true;
      });
    },
    text: () => output,
    records: () =>
      output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => recordSchema.parse(JSON.parse(line))),
  };
}

describe("PostgreSQL failure diagnostics", () => {
  let postgres: StartedPostgreSqlContainer;
  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine")
      .withPassword("private-db-password-canary")
      .start();
  }, 120_000);
  afterAll(async () => {
    await postgres?.stop();
  });

  it("reports a database that refuses connections as unavailable to every caller", async () => {
    const url = new URL(postgres.getConnectionUri());
    url.pathname = "/refusing_connections";
    const { runtime } = await createPostgresRuntime(url.toString());
    const outage = await PostgresOutage.connect(url.toString());
    try {
      await runtime.query("select 1");
      await outage.begin();
      // The first query finds its idle connection terminated; the next cannot open a new one.
      await assert.rejects(runtime.query("select 1"), DatabaseUnavailableError);
      await assert.rejects(runtime.query("select 1"), DatabaseUnavailableError);
      await assert.rejects(
        runtime.transaction((transaction) => transaction.query("select 1")),
        DatabaseUnavailableError,
      );
      await outage.end();
      assert.deepEqual((await runtime.query("select 1 as one")).rows, [{ one: 1 }]);
      await assert.rejects(runtime.query("select 1 / 0"), (error: unknown) => {
        assert.equal(error instanceof DatabaseUnavailableError, false);
        assert.equal(z.object({ code: z.string() }).parse(error).code, "22012");
        return true;
      });
    } finally {
      await outage.end();
      await outage.close();
      await runtime.close();
    }
  });

  it("reports a real pool acquisition timeout without query parameters", async () => {
    const pool = createPool(postgres.getConnectionUri());
    pool.options.max = 1;
    const held = await pool.connect();
    const log = capture();
    try {
      await runWithFailureTracking(async () => {
        await log.rejects(pool.query("select $1::text", ["private-query-parameter"]), /timeout/u);
      }, log.logger);
      const [record] = log.records();
      assert.ok(record);
      assert.equal(record.operation, "consumer.database.query");
      assert.match(record.err.message, /timeout/u);
      assert.equal(record.err.code, null);
      assert.equal(record.err.diagnostic.phase, "acquire");
      assert.ok(record.err.diagnostic.elapsedMs >= 2900);
      assert.deepEqual(record.err.diagnostic.pool, { total: 1, idle: 0, waiting: 0 });
      assert.equal(log.text().includes("private-query-parameter"), false);
      assert.equal(log.text().includes(postgres.getConnectionUri()), false);
      assert.equal(log.text().includes("private-db-password-canary"), false);
    } finally {
      held.release();
      await pool.end();
    }
  });

  it("reports a real query read timeout and the busy pool", async () => {
    const pool = createPool(postgres.getConnectionUri());
    const log = capture();
    try {
      await pool.query("set statement_timeout = 0");
      await runWithFailureTracking(async () => {
        await log.rejects(pool.query("select pg_sleep(10)"), /timeout/u);
      }, log.logger);
      const [record] = log.records();
      assert.ok(record);
      assert.equal(record.operation, "consumer.database.query");
      assert.match(record.err.message, /timeout/u);
      assert.equal(record.err.code, null);
      assert.equal(record.err.diagnostic.phase, "query");
      assert.ok(record.err.diagnostic.elapsedMs >= 4900);
      assert.deepEqual(record.err.diagnostic.pool, { total: 1, idle: 0, waiting: 0 });
    } finally {
      await pool.end();
    }
  });

  it("preserves SQLSTATE for a server timeout and redacts values in server messages", async () => {
    const pool = createPool(postgres.getConnectionUri());
    const client = await pool.connect();
    const log = capture();
    try {
      await client.query("set statement_timeout = 100");
      await runWithFailureTracking(async () => {
        await log.rejects(client.query("select pg_sleep(5)"));
        await log.rejects(client.query("select $1::integer", ["private-query-parameter"]));
        await client.query(`create function pg_temp.reject_parameter(value text) returns void
          language plpgsql as $$ begin raise exception 'rejected %', value; end $$`);
        await log.rejects(
          client.query({
            text: "select pg_temp.reject_parameter($1)",
            values: ["private-unquoted-parameter"],
          }),
        );
      }, log.logger);
      const [timeout, invalid, unquoted] = log.records();
      assert.ok(timeout && invalid && unquoted);
      assert.equal(timeout.err.code, "57014");
      assert.equal(timeout.err.message, "canceling statement due to statement timeout");
      assert.equal(timeout.err.diagnostic.phase, "query");
      assert.equal(invalid.err.code, "22P02");
      assert.equal(log.text().includes("private-query-parameter"), false);
      assert.equal(log.text().includes("private-unquoted-parameter"), false);
      assert.equal(log.text().includes("private-db-password-canary"), false);
      assert.equal(unquoted.err.message, "rejected [Redacted]");
    } finally {
      client.release();
      await pool.end();
    }
  });
  it("reports idle-client errors from PostgreSQL with SQLSTATE and idle duration", async () => {
    const pool = createPool(postgres.getConnectionUri());
    const admin = createPool(postgres.getConnectionUri());
    const log = capture();
    try {
      await runWithFailureTracking(async () => {
        const result = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
        const failed = once(pool, "error");
        await admin.query("select pg_terminate_backend($1)", [result.rows[0]!.pid]);
        await failed;
      }, log.logger);
      const [record] = log.records();
      assert.ok(record);
      assert.equal(record.operation, "database.postgres.pool");
      assert.equal(record.err.message, "terminating connection due to administrator command");
      assert.equal(record.err.code, "57P01");
      assert.equal(record.err.diagnostic.phase, "idle");
      assert.deepEqual(record.err.diagnostic.pool, { total: 0, idle: 0, waiting: 0 });
    } finally {
      await pool.end();
      await admin.end();
    }
  });

  it("reports the overall query deadline with its active phase", async () => {
    const pool = createPool(postgres.getConnectionUri());
    pool.options.max = 1;
    const held = await pool.connect();
    const log = capture();
    try {
      await runWithFailureTracking(async () => {
        // Acquisition and the statement each stay inside their own limit; together they pass
        // the overall deadline before PostgreSQL cancels the statement.
        const failed = log.rejects(
          pool.runQuery(undefined, "select pg_sleep(5)", []),
          /database query timed out/u,
        );
        await delay(2_500);
        held.release();
        await failed;
      }, log.logger);
      const [record] = log.records();
      assert.ok(record);
      assert.equal(record.err.message, "database query timed out");
      assert.equal(record.err.diagnostic.phase, "query");
      assert.deepEqual(record.err.diagnostic.pool, { total: 1, idle: 0, waiting: 0 });
    } finally {
      await pool.end();
    }
  });
  it("destroys a connection whose query hit the client deadline", async () => {
    const { runtime } = await createPostgresRuntime(postgres.getConnectionUri());
    let pid: string | undefined;
    try {
      await assert.rejects(
        runtime.transaction(async (transaction) => {
          const backend = await transaction.query<{ pid: number }>(
            "select pg_backend_pid() as pid",
          );
          pid = String(backend.rows[0]!.pid);
          // A stopped backend answers nothing, so the client gives up with the statement still
          // on the socket. When the backend resumes, that statement aborts the transaction.
          await postgres.exec(["kill", "-STOP", pid]);
          await transaction.query("select 1 / 0");
        }),
        /timeout|timed out/u,
      );
      await postgres.exec(["kill", "-CONT", pid!]);
      const next = await runtime.transaction((transaction) =>
        transaction.query<{ value: number }>("select 1 as value"),
      );
      assert.deepEqual(next.rows, [{ value: 1 }]);
    } finally {
      if (pid !== undefined) await postgres.exec(["kill", "-CONT", pid]);
      await runtime.close();
    }
  }, 60_000);

  it("reports a checked-out connection that PostgreSQL terminates without crashing", async () => {
    const { runtime } = await createPostgresRuntime(postgres.getConnectionUri());
    const admin = createPool(postgres.getConnectionUri());
    const log = capture();
    try {
      const terminateWhileHeld = async (transaction: TransactionHandle) => {
        const backend = await transaction.query<{ pid: number }>("select pg_backend_pid() as pid");
        await admin.query("select pg_terminate_backend($1)", [backend.rows[0]!.pid]);
        await until(() => log.text().includes("database.postgres.client"));
      };
      await runWithFailureTracking(async () => {
        await assert.rejects(runtime.transaction(terminateWhileHeld));
      }, log.logger);
      const record = log.records().find((entry) => entry.operation === "database.postgres.client");
      assert.ok(record);
      assert.equal(record.err.code, "57P01");
      assert.equal(record.err.diagnostic.phase, "checkedOut");
      const next = await runtime.query<{ value: number }>("select 1 as value");
      assert.deepEqual(next.rows, [{ value: 1 }]);
    } finally {
      await runtime.close();
      await admin.end();
    }
  }, 60_000);

  it("preserves caller operation and diagnostics through a Drizzle error cause", async () => {
    const { runtime } = await createPostgresRuntime(postgres.getConnectionUri());
    const log = capture();
    try {
      await log.rejects(runtime.drizzle().execute(sql`select ${"private-drizzle-value"}::integer`));
      const record = z
        .object({
          operation: z.string(),
          err: z.object({
            cause: z.object({
              message: z.string(),
              code: z.string(),
              diagnostic: diagnosticSchema,
            }),
          }),
        })
        .parse(JSON.parse(log.text()));
      assert.equal(record.operation, "consumer.database.query");
      assert.equal(record.err.cause.code, "22P02");
      assert.equal(record.err.cause.diagnostic.phase, "query");
      assert.equal(log.text().includes("private-drizzle-value"), false);
      assert.equal(log.text().includes("select $1"), false);
    } finally {
      await runtime.close();
    }
  });
});

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) await delay(100);
}
