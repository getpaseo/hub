import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { Client } from "pg";

const POSTGRES_ADMIN_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const DATABASE_PREFIX = "paseo_hub_";

const action = process.argv[2];
const workspacePath = resolve(process.env.PASEO_WORKTREE_PATH ?? process.cwd());
const databaseName = workspaceDatabaseName(workspacePath);
const databaseUrl = workspaceDatabaseUrl(databaseName);

switch (action) {
  case "setup":
    await copyWorkspaceEnvironment();
    await runNpm(["run", "db:migrate"], { DATABASE_URL: databaseUrl });
    break;
  case "dev":
    await runNpm(
      ["run", "dev", "--", "--host", process.env.HOST ?? "127.0.0.1", "--port", requiredPort()],
      {
        DATABASE_URL: databaseUrl,
        PASEO_HUB_APP_URL: process.env.PASEO_URL ?? `http://127.0.0.1:${requiredPort()}`,
      },
    );
    break;
  case "teardown":
    await dropWorkspaceDatabase(databaseName);
    break;
  default:
    throw new Error("Expected one of: setup, dev, teardown");
}

function workspaceDatabaseName(path) {
  const label = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 12);
  return `${DATABASE_PREFIX}${label || "workspace"}_${digest}`;
}

function workspaceDatabaseUrl(name) {
  const url = new URL(POSTGRES_ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function copyWorkspaceEnvironment() {
  const sourceRoot = process.env.PASEO_SOURCE_CHECKOUT_PATH;
  if (sourceRoot === undefined || resolve(sourceRoot) === workspacePath) return;

  const source = join(sourceRoot, ".env");
  try {
    await stat(source);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await copyFile(source, join(workspacePath, ".env"));
}

async function dropWorkspaceDatabase(name) {
  if (!name.startsWith(DATABASE_PREFIX)) {
    throw new Error(`Refusing to drop unexpected database: ${name}`);
  }

  const client = new Client({ connectionString: POSTGRES_ADMIN_URL });
  await client.connect();
  try {
    await client.query(`drop database if exists ${quoteIdentifier(name)} with (force)`);
  } finally {
    await client.end();
  }
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function requiredPort() {
  const port = process.env.PASEO_PORT;
  if (port === undefined || !/^\d+$/.test(port)) {
    throw new Error("PASEO_PORT must be set to the service port assigned by Paseo");
  }
  return port;
}

async function runNpm(args, environment) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(command, args, {
    cwd: workspacePath,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }

  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(signal === null ? (code ?? 1) : 1));
  });
  if (exitCode !== 0) process.exit(exitCode);
}
