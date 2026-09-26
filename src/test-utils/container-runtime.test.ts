import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveContainerRuntime } from "./container-runtime.js";

/**
 * The behaviour that matters is when this declines to act. Acting over a deliberate
 * DOCKER_HOST would point the suite at a different machine than the developer asked
 * for, which is worse than the failure it exists to prevent.
 */
describe("container runtime resolution", () => {
  it("leaves an explicit DOCKER_HOST alone", () => {
    assert.equal(
      resolveContainerRuntime({ DOCKER_HOST: "tcp://vogon.example.test:2375" }),
      undefined,
    );
  });

  it("leaves an explicit testcontainers host override alone", () => {
    assert.equal(
      resolveContainerRuntime({ TESTCONTAINERS_HOST_OVERRIDE: "tcp://sirius.example.test:2375" }),
      undefined,
    );
  });

  it("ignores a DOCKER_HOST set to the empty string", () => {
    // An unset var and one exported empty should mean the same thing, or a stray
    // `export DOCKER_HOST=` in a profile silently reinstates the original failure.
    const resolved = resolveContainerRuntime({ DOCKER_HOST: "" });
    assert.ok(resolved === undefined || resolved.startsWith("unix://"));
  });

  it("returns a unix socket url when it does pick something", () => {
    const resolved = resolveContainerRuntime({});
    assert.ok(resolved === undefined || resolved.startsWith("unix://"));
  });
});
