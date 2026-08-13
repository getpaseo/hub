import { spawn } from "node:child_process";
import { copyFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const action = process.argv[2];
const workspacePath = resolve(process.env.PASEO_WORKTREE_PATH ?? process.cwd());

switch (action) {
  case "setup":
    await copyWorkspaceEnvironment();
    break;
  case "dev":
    await runNpm(
      ["run", "dev", "--", "--host", process.env.HOST ?? "127.0.0.1", "--port", requiredPort()],
      {
        PASEO_HUB_APP_URL: process.env.PASEO_URL ?? `http://127.0.0.1:${requiredPort()}`,
      },
    );
    break;
  case "teardown":
    break;
  default:
    throw new Error("Expected one of: setup, dev, teardown");
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
