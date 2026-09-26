import { execFileSync } from "node:child_process";

// The image runs forgejo as uid 1000 (named `git`) and refuses to run as root, so
// `podman exec` needs a user. Numeric uid instead of the username; reads the same
// to Forgejo either way.

export const CONTAINER_NAME = "cc-forgejo-fixtures";
export const FORGEJO_UID = 1000;

export function podman(args) {
  return execFileSync("podman", args, { encoding: "utf8" });
}

export function startContainer(image, hostPort) {
  podman([
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-p",
    `127.0.0.1:${hostPort}:3000`,
    "-e",
    "FORGEJO__database__DB_TYPE=sqlite3",
    "-e",
    "FORGEJO__security__INSTALL_LOCK=true",
    "-e",
    "FORGEJO__webhook__ALLOWED_HOST_LIST=*",
    "-e",
    "FORGEJO__webhook__DELIVER_TIMEOUT=15",
    "-e",
    `FORGEJO__server__ROOT_URL=http://localhost:${hostPort}/`,
    image,
  ]);
}

export function stopContainer() {
  try {
    podman(["rm", "-f", CONTAINER_NAME]);
  } catch (error) {
    process.stderr.write(`teardown: podman rm failed: ${String(error)}\n`);
  }
}

export async function waitForReady(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/version`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`forgejo did not become ready within ${timeoutMs}ms`);
}

export function createInstanceUser(username, password, email, { admin = false } = {}) {
  podman([
    "exec",
    "-u",
    String(FORGEJO_UID),
    CONTAINER_NAME,
    "forgejo",
    "admin",
    "user",
    "create",
    ...(admin ? ["--admin"] : []),
    "--username",
    username,
    "--password",
    password,
    "--email",
    email,
    "--must-change-password=false",
  ]);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
