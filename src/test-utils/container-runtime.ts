import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Testcontainers only probes for a socket literally named `docker.sock`. Podman on
 * macOS puts its socket under `$TMPDIR/podman/<machine>-api.sock`, so a healthy
 * `podman machine` still fails every test with "Could not find a working container
 * runtime strategy" unless we export DOCKER_HOST ourselves first.
 */
export function resolveContainerRuntime(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // An explicit choice always wins. Someone pointing at a remote or rootful daemon
  // means it, and guessing over them is how a test suite quietly targets the wrong host.
  if (usable(env["DOCKER_HOST"]) || usable(env["TESTCONTAINERS_HOST_OVERRIDE"])) return undefined;
  // Testcontainers finds these on its own, so leave it alone and let it.
  if (dockerSocketExists(env)) return undefined;

  return podmanSocket() ?? dockerContextSocket();
}

/** Mirrors RootlessUnixSocketStrategy, so we only step in where it would give up. */
function dockerSocketExists(env: NodeJS.ProcessEnv): boolean {
  const runtimeDir = env["XDG_RUNTIME_DIR"];
  return [
    runtimeDir === undefined ? undefined : path.join(runtimeDir, "docker.sock"),
    path.join(os.homedir(), ".docker", "run", "docker.sock"),
    path.join(os.homedir(), ".docker", "desktop", "docker.sock"),
    path.join("/run", "user", String(os.userInfo().uid), "docker.sock"),
    "/var/run/docker.sock",
  ].some((candidate) => candidate !== undefined && existsSync(candidate));
}

function podmanSocket(): string | undefined {
  // A stopped machine has a socket path but nothing listening on it, and pointing at
  // a dead socket fails later and more confusingly than not pointing at all.
  if (probe("podman", ["machine", "inspect", "--format", "{{.State}}"]) !== "running") {
    return undefined;
  }
  const socket = probe("podman", [
    "machine",
    "inspect",
    "--format",
    "{{.ConnectionInfo.PodmanSocket.Path}}",
  ]);
  return socket === undefined || !existsSync(socket) ? undefined : `unix://${socket}`;
}

/** Covers a Docker context whose socket is somewhere non-standard. */
function dockerContextSocket(): string | undefined {
  const host = probe("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  return host !== undefined && host.startsWith("unix://") && existsSync(host.slice(7))
    ? host
    : undefined;
}

/** Best effort: a missing binary or an unhappy machine is a normal answer here. */
function probe(command: string, args: readonly string[]): string | undefined {
  try {
    const out = execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    // podman prints one line per machine; the first is the default connection.
    const first = out.split("\n")[0]?.trim();
    return usable(first) ? first : undefined;
  } catch {
    return undefined;
  }
}

function usable(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
