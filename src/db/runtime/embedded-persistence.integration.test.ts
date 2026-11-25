import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, it } from "vitest";
import { embeddedDatabaseRuntime, type DatabaseRuntimeBundle } from "./index.js";

let root: string;
let activeRuntime: DatabaseRuntimeBundle | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hub-pglite-persistence-"));
});

afterEach(async () => {
  await activeRuntime?.runtime.close();
  activeRuntime = undefined;
  await rm(root, { recursive: true, force: true });
});

it("persists embedded data across runtime restarts", async () => {
  const dataDirectory = join(root, "database");
  activeRuntime = await embeddedDatabaseRuntime(dataDirectory);
  await activeRuntime.runtime.query(`create table persistence_probe (value text not null)`);
  await activeRuntime.runtime.query(`insert into persistence_probe (value) values ('kept')`);
  await activeRuntime.runtime.close();

  activeRuntime = await embeddedDatabaseRuntime(dataDirectory);
  const result = await activeRuntime.runtime.query<{ value: string }>(
    `select value from persistence_probe`,
  );

  assert.deepEqual(result.rows, [{ value: "kept" }]);
});

it("rejects a second process using the same embedded data directory", async () => {
  const dataDirectory = join(root, "database");
  activeRuntime = await embeddedDatabaseRuntime(dataDirectory);

  const result = await openEmbeddedRuntimeInChild(dataDirectory);

  assert.equal(result.exitCode, 23);
  assert.match(result.stderr, /already in use by another Paseo Hub process/);
  assert.match(result.stderr, /Embedded mode supports one process per data directory/);
});

it("recovers a lock left by an earlier process with the same PID", async () => {
  // A restarted container runs Hub as PID 1 again, so the stale lock names a live PID: this one.
  const dataDirectory = join(root, "database");
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    join(dataDirectory, ".paseo-hub.lock"),
    JSON.stringify({ pid: process.pid, token: "left-by-an-earlier-process", hostname: hostname() }),
  );

  activeRuntime = await embeddedDatabaseRuntime(dataDirectory);
  const result = await activeRuntime.runtime.query<{ value: number }>(`select 1 as value`);

  assert.deepEqual(result.rows, [{ value: 1 }]);
});

async function openEmbeddedRuntimeInChild(
  dataDirectory: string,
): Promise<{ exitCode: number | null; stderr: string }> {
  const runtimeModule = pathToFileURL(join(process.cwd(), "src", "db", "runtime", "index.ts"));
  const source = `
    const { embeddedDatabaseRuntime } = await import(${JSON.stringify(runtimeModule.href)});
    try {
      const bundle = await embeddedDatabaseRuntime(process.env.PASEO_TEST_DATA_DIR);
      await bundle.runtime.close();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(23);
    }
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: process.cwd(),
      env: { ...process.env, PASEO_TEST_DATA_DIR: dataDirectory },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, stderr };
}
