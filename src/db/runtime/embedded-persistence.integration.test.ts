import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, it } from "vitest";
import { embeddedDatabaseRuntime, type DatabaseRuntimeBundle } from "./index.js";

const LOCK_FILE_NAME = ".paseo-hub.lock";
const ALREADY_IN_USE = /already in use by another Paseo Hub process/;

let root: string;
let activeRuntime: DatabaseRuntimeBundle | undefined;
let activeChild: ChildProcess | undefined;

let childScript: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hub-pglite-persistence-"));
  childScript = join(root, "open-embedded-runtime.mjs");
  await writeFile(childScript, CHILD_SOURCE);
});

afterEach(async () => {
  if (activeChild !== undefined && activeChild.exitCode === null) {
    activeChild.kill("SIGKILL");
    await once(activeChild, "exit");
  }
  activeChild = undefined;
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
  assert.match(result.stderr, ALREADY_IN_USE);
  assert.match(result.stderr, /Embedded mode supports one process per data directory/);
});

it("rejects opening a data directory that a live child process holds", async () => {
  const dataDirectory = join(root, "database");
  activeChild = await holdEmbeddedRuntimeInChild(dataDirectory);

  await assert.rejects(embeddedDatabaseRuntime(dataDirectory), ALREADY_IN_USE);
});

it("opens a data directory immediately after its holder is killed with SIGKILL", async () => {
  const dataDirectory = join(root, "database");
  const holder = await holdEmbeddedRuntimeInChild(dataDirectory);
  holder.kill("SIGKILL");
  await once(holder, "exit");

  activeRuntime = await embeddedDatabaseRuntime(dataDirectory);
  const result = await activeRuntime.runtime.query<{ ok: number }>(`select 1 as ok`);

  assert.deepEqual(result.rows, [{ ok: 1 }]);
});

it("opens a data directory whose lock file names this process, as after a container restart", async () => {
  const dataDirectory = join(root, "database");
  await writeStaleLockFile(dataDirectory, process.pid);

  activeRuntime = await embeddedDatabaseRuntime(dataDirectory);

  assert.ok(activeRuntime);
});

it("opens a data directory whose lock file names a live foreign process, as after a backup restore", async () => {
  const dataDirectory = join(root, "database");
  await writeStaleLockFile(dataDirectory, process.ppid);

  activeRuntime = await embeddedDatabaseRuntime(dataDirectory);

  assert.ok(activeRuntime);
});

it("lets another process open the data directory after a clean close", async () => {
  const dataDirectory = join(root, "database");
  activeRuntime = await embeddedDatabaseRuntime(dataDirectory);
  await activeRuntime.runtime.close();
  activeRuntime = undefined;

  const result = await openEmbeddedRuntimeInChild(dataDirectory);

  assert.equal(result.exitCode, 0, result.stderr);
});

async function writeStaleLockFile(dataDirectory: string, pid: number): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    join(dataDirectory, LOCK_FILE_NAME),
    JSON.stringify({ pid, token: "left-behind-by-a-previous-run" }),
  );
}

const RUNTIME_MODULE = pathToFileURL(join(process.cwd(), "src", "db", "runtime", "index.ts")).href;
const CHILD_SOURCE = `
  const { embeddedDatabaseRuntime } = await import(${JSON.stringify(RUNTIME_MODULE)});
  try {
    const bundle = await embeddedDatabaseRuntime(process.env.PASEO_TEST_DATA_DIR);
    if (process.env.PASEO_TEST_HOLD === "1") {
      process.stdout.write("ready\\n");
      setInterval(() => {}, 60_000);
    } else {
      await bundle.runtime.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(23);
  }
`;

// PGlite starts worker threads that inherit the parent's exec arguments, so the child runs a
// script file rather than --eval source.
function spawnEmbeddedRuntimeChild(dataDirectory: string, hold: boolean): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", childScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PASEO_TEST_DATA_DIR: dataDirectory,
      PASEO_TEST_HOLD: hold ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function holdEmbeddedRuntimeInChild(dataDirectory: string): Promise<ChildProcess> {
  const child = spawnEmbeddedRuntimeChild(dataDirectory, true);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(
        new Error(`embedded runtime child exited with ${code} before it was ready: ${stderr}`),
      );
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (chunk.includes("ready")) resolve();
    });
  });
  return child;
}

async function openEmbeddedRuntimeInChild(
  dataDirectory: string,
): Promise<{ exitCode: number | null; stderr: string }> {
  const child = spawnEmbeddedRuntimeChild(dataDirectory, false);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { exitCode, stderr };
}
