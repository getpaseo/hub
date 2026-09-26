import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { z } from "zod";

/**
 * A throwaway Forgejo instance in Podman, for the live end to end test. Duplicates a
 * handful of functions from `scripts/lib/forgejo-capture-*.mjs`, since tsc's
 * rootDir/include can't see .mjs files. Keep both in sync if Forgejo's admin CLI or
 * token API ever change shape.
 */

export const FORGEJO_UID = 1000;

export function podman(args: readonly string[]): string {
  return execFileSync("podman", [...args], { encoding: "utf8" });
}

export function startForgejoContainer(
  containerName: string,
  image: string,
  hostPort: number,
): void {
  podman([
    "run",
    "-d",
    "--name",
    containerName,
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

export function stopForgejoContainer(containerName: string): void {
  try {
    podman(["rm", "-f", containerName]);
  } catch (error) {
    process.stderr.write(`forgejo live teardown: podman rm failed: ${String(error)}\n`);
  }
}

export async function waitForForgejoReady(baseUrl: string, timeoutMs = 60_000): Promise<void> {
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

export function createForgejoInstanceUser(
  containerName: string,
  username: string,
  password: string,
  email: string,
  options: { admin?: boolean } = {},
): void {
  podman([
    "exec",
    "-u",
    String(FORGEJO_UID),
    containerName,
    "forgejo",
    "admin",
    "user",
    "create",
    ...(options.admin === true ? ["--admin"] : []),
    "--username",
    username,
    "--password",
    password,
    "--email",
    email,
    "--must-change-password=false",
  ]);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask the OS for a free TCP port by binding to port 0 and reading it back. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : undefined;
      server.close(() => {
        if (port === undefined) {
          reject(new Error("could not read back the bound port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

export interface ForgejoLiveUser {
  username: string;
  password: string;
  email: string;
}

/** Mint a personal access token for a freshly created user via HTTP basic auth. */
export async function mintForgejoToken(base: string, user: ForgejoLiveUser): Promise<string> {
  const res = await fetch(`${base}/api/v1/users/${user.username}/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${user.username}:${user.password}`).toString("base64")}`,
    },
    body: JSON.stringify({
      name: "hub-live-e2e",
      scopes: ["write:repository", "write:issue", "write:user", "write:organization"],
    }),
  });
  if (!res.ok) throw new Error(`minting token for ${user.username} failed: ${res.status}`);
  const json: unknown = await res.json();
  return TokenResponseSchema.parse(json).sha1;
}

const TokenResponseSchema = z.object({ sha1: z.string() });

export interface ForgejoRawResponse {
  status: number;
  body: unknown;
}

/** A tiny token-authenticated JSON client, bound to one user, driving the raw Forgejo
 * REST API directly (unlike `ForgejoApiClient`, which only covers what Hub itself
 * needs). Used here for fixture setup: orgs, repos, labels, comments. */
export function forgejoRawApiClient(
  base: string,
  token: string,
): (method: string, urlPath: string, jsonBody?: unknown) => Promise<ForgejoRawResponse> {
  return async function call(method, urlPath, jsonBody) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: { "content-type": "application/json", authorization: `token ${token}` },
      ...(jsonBody === undefined ? {} : { body: JSON.stringify(jsonBody) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status}: ${text.slice(0, 500)}`);
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
  };
}
