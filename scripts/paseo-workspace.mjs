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
  case "evidence":
    await runEvidenceApplication();
    break;
  case "teardown":
    break;
  default:
    throw new Error("Expected one of: setup, dev, evidence, teardown");
}

async function runEvidenceApplication() {
  await runNpm(["run", "build"], {});
  await runCommand(process.execPath, ["dist/index.js"], {
    PORT: requiredPort(),
    PASEO_HUB_BIND: process.env.HOST ?? "127.0.0.1",
    PASEO_HUB_DATA_DIR: join(workspacePath, ".dev", "operator-app-evidence", "runtime"),
    DATABASE_URL: "",
    PASEO_HUB_APP_URL: "",
    PASEO_HUB_AUTH_SECRET: "",
    GITHUB_APP_ID: "",
    GITHUB_APP_SLUG: "",
    GITHUB_APP_CLIENT_ID: "",
    GITHUB_APP_CLIENT_SECRET: "",
    GITHUB_APP_PRIVATE_KEY: "",
    GITHUB_APP_PRIVATE_KEY_PATH: "",
    GITHUB_WEBHOOK_SECRET: "",
    SLACK_APP_ID: "",
    SLACK_CLIENT_ID: "",
    SLACK_CLIENT_SECRET: "",
    SLACK_SIGNING_SECRET: "",
    DISCORD_CLIENT_ID: "",
    DISCORD_CLIENT_SECRET: "",
    DISCORD_BOT_TOKEN: "",
    PASEO_BOOTSTRAP_ORGANIZATION: "",
    PASEO_BOOTSTRAP_OWNER_EMAIL: "",
    PASEO_BOOTSTRAP_OWNER_PASSWORD: "",
  });
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
  await runCommand(command, args, environment);
}

async function runCommand(command, args, environment) {
  const childEnvironment = { ...process.env, ...environment };
  const child = spawn(command, args, {
    cwd: workspacePath,
    env: childEnvironment,
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
