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
import { createPool, createPostgresRuntime } from "./postgres.js";

const diagnosticSchema = z.object({
  phase: z.enum(["acquire", "query", "idle"]),
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
        await log.rejects(pool.query("select pg_sleep(5)"), /timeout/u);
      }, log.logger);
      const [record] = log.records();
      assert.ok(record);
      assert.equal(record.operation, "consumer.database.query");
      assert.match(record.err.message, /timeout/u);
      assert.equal(record.err.code, null);
      assert.equal(record.err.diagnostic.phase, "query");
      assert.ok(record.err.diagnostic.elapsedMs >= 2900);
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
        const failed = log.rejects(
          pool.runQuery(undefined, "select pg_sleep(5)", []),
          /database query timed out/u,
        );
        await delay(200);
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
