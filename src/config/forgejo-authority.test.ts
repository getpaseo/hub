import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "./compiler.js";
import { compileForgejoAuthority } from "./forgejo-authority.js";

const environment = { name: "runner", kind: "daemon" as const, daemon: "runner", cwd: "/repo" };

function compileSteps(steps: unknown) {
  return compileHubConfig({
    environments: [environment],
    triggers: [
      {
        name: "demo",
        on: "manual.run",
        max_runtime: "10m",
        steps,
      },
    ],
  });
}

describe("forgejo authority schema", () => {
  it("compiles connection, optional repositories, and contents/issues levels", () => {
    const compiled = compileForgejoAuthority(
      {
        connection: "acme-forgejo",
        repositories: ["acme/widgets"],
        contents: "write",
        issues: "read",
      },
      "step.forgejo",
    );
    assert.deepEqual(compiled, {
      connection: "acme-forgejo",
      repositories: ["acme/widgets"],
      contents: "write",
      issues: "read",
    });
  });

  it("defaults omitted contents and issues to read", () => {
    assert.deepEqual(compileForgejoAuthority({ connection: "acme-forgejo" }, "step.forgejo"), {
      connection: "acme-forgejo",
      contents: "read",
      issues: "read",
    });
  });

  it("rejects a step that declares both github and forgejo", () => {
    assert.throws(
      () =>
        compileSteps([
          {
            id: "run",
            environment: "runner",
            max_runtime: "5m",
            idle_timeout: "1m",
            agent: { provider: "codex", model: "gpt-5" },
            prompt: [{ text: "go" }],
            github: { connection: "acme-github", repositories: ["acme/widgets"] },
            forgejo: { connection: "acme-forgejo", repositories: ["acme/widgets"] },
          },
        ]),
      /github or forgejo/,
    );
  });

  it("rejects reserved Forgejo environment keys", () => {
    assert.throws(
      () =>
        compileSteps([
          {
            id: "run",
            environment: "runner",
            max_runtime: "5m",
            idle_timeout: "1m",
            agent: { provider: "codex", model: "gpt-5" },
            prompt: [{ text: "go" }],
            env: { FORGEJO_TOKEN: "user-authored" },
            forgejo: { connection: "acme-forgejo", repositories: ["acme/widgets"] },
          },
        ]),
      /reserved by the step-level forgejo authority/,
    );
  });

  it("requires repositories for non-forgejo triggers", () => {
    assert.throws(
      () =>
        compileSteps([
          {
            id: "run",
            environment: "runner",
            max_runtime: "5m",
            idle_timeout: "1m",
            agent: { provider: "codex", model: "gpt-5" },
            prompt: [{ text: "go" }],
            forgejo: { connection: "acme-forgejo" },
          },
        ]),
      /forgejo\.repositories is required/,
    );
  });
});
