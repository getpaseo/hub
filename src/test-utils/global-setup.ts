import { resolveContainerRuntime } from "./container-runtime.js";

/**
 * Runs once before the suite, in the main vitest process, which is early enough that
 * no test has constructed a container yet. Setting DOCKER_HOST here reaches the forks
 * because vitest passes the parent environment down.
 */
export default function setup(): void {
  const host = resolveContainerRuntime();
  if (host === undefined) return;
  process.env["DOCKER_HOST"] = host;
  // Ryuk (testcontainers' reaper, cleans up after a crashed run) bind-mounts the
  // runtime socket, and on a Podman machine that socket sits under $TMPDIR, where the
  // mount fails ("mkdir .../podman-machine-default-api.sock: operation not supported").
  // Turn it off and let the suite's own afterAll hooks stop what they started.
  process.env["TESTCONTAINERS_RYUK_DISABLED"] ??= "true";
  process.stderr.write(`[testcontainers] using ${host}\n`);
}
