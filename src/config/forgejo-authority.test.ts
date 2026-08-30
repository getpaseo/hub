import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { load } from "js-yaml";
import { compileHubConfig } from "./compiler.js";
import {
  compileForgejoAuthority,
  forgejoDaemonEnvironment,
  isForgejoAuthorityEnvironmentKey,
  repositoriesForForgejoAuthority,
  requiredForgejoPatScopes,
  ForgejoAuthorityError,
} from "./forgejo-authority.js";

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

const authorizedStep = {
  id: "run",
  environment: "runner",
  max_runtime: "5m",
  idle_timeout: "1m",
  agent: { provider: "codex", model: "gpt-5" },
  prompt: [{ text: "go" }],
};

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

  it("round-trips YAML forgejo authority without introducing a secret", () => {
    const yaml = `
environments:
  - name: runner
    kind: daemon
    daemon: runner
    cwd: /repo
triggers:
  - name: demo
    on: manual.run
    max_runtime: 10m
    steps:
      - id: run
        environment: runner
        max_runtime: 5m
        idle_timeout: 1m
        agent: { provider: codex, model: gpt-5 }
        prompt: [{ text: go }]
        forgejo:
          connection: acme-forgejo
          repositories: [acme/widgets]
          contents: write
          issues: read
`;
    const compiled = compileHubConfig(load(yaml));
    assert.deepEqual(compiled.triggers[0]?.steps[0]?.forgejo, {
      connection: "acme-forgejo",
      repositories: ["acme/widgets"],
      contents: "write",
      issues: "read",
    });
    const serialized = JSON.stringify(compiled);
    assert.equal(serialized.includes("FORGEJO_TOKEN"), false);
    assert.equal(serialized.includes("token"), false);
  });

  it("omits Forgejo authority when the step has no forgejo block", () => {
    const compiled = compileSteps([authorizedStep]);
    assert.equal(compiled.triggers[0]?.steps[0]?.forgejo, undefined);
    assert.equal(compiled.triggers[0]?.steps[0]?.env, undefined);
  });

  it("rejects a step that declares both github and forgejo", () => {
    assert.throws(
      () =>
        compileSteps([
          {
            ...authorizedStep,
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
            ...authorizedStep,
            env: { FORGEJO_TOKEN: "user-authored" },
            forgejo: { connection: "acme-forgejo", repositories: ["acme/widgets"] },
          },
        ]),
      /reserved by the step-level forgejo authority/,
    );
  });

  it.each([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_3",
  ])("rejects reserved Forgejo rewrite key %s", (key) => {
    assert.throws(
      () =>
        compileSteps([
          {
            ...authorizedStep,
            env: { [key]: "user-authored" },
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
            ...authorizedStep,
            forgejo: { connection: "acme-forgejo" },
          },
        ]),
      /forgejo\.repositories is required/,
    );
  });

  it("allows omitted repositories for forgejo trigger events", () => {
    const compiled = compileHubConfig({
      environments: [environment],
      triggers: [
        {
          name: "issue",
          on: "forgejo.issue_created",
          max_runtime: "10m",
          filters: { from_users: ["*"] },
          steps: [
            {
              ...authorizedStep,
              forgejo: { connection: "acme-forgejo" },
            },
          ],
        },
      ],
    });
    assert.deepEqual(compiled.triggers[0]?.steps[0]?.forgejo, {
      connection: "acme-forgejo",
      contents: "read",
      issues: "read",
    });
  });
});

describe("forgejo authority runtime helpers", () => {
  it("maps contents/issues write to write:repository and write:issue", () => {
    assert.deepEqual(requiredForgejoPatScopes({ contents: "write", issues: "write" }), [
      "write:repository",
      "write:issue",
    ]);
    assert.deepEqual(requiredForgejoPatScopes({ contents: "read", issues: "read" }), [
      "read:repository",
      "read:issue",
    ]);
  });

  it("expands omitted repositories only for a forgejo trigger repository", () => {
    const compiled = compileForgejoAuthority({ connection: "acme-forgejo" }, "step.forgejo");
    assert.deepEqual(
      repositoriesForForgejoAuthority(compiled, {
        provider: "forgejo",
        target: { repository: "acme/widgets" },
      }),
      ["acme/widgets"],
    );
    assert.throws(
      () => repositoriesForForgejoAuthority(compiled, { provider: "manual" }),
      (error: unknown) =>
        error instanceof ForgejoAuthorityError && error.code === "forgejo_authority_scope_invalid",
    );
  });

  it("injects FORGEJO_TOKEN and origin Git rewrite without putting the token in git config values", () => {
    const token = "fj_exec_canary_token_not_for_git_config";
    const env = forgejoDaemonEnvironment(
      {
        origin: "https://forgejo.example.test",
        userId: 2,
        login: "t00bot",
      },
      token,
    );
    assert.equal(env["FORGEJO_TOKEN"], token);
    assert.equal(env["GH_TOKEN"], undefined);
    assert.equal(env["GITHUB_TOKEN"], undefined);
    assert.equal(env["GIT_CONFIG_COUNT"], "5");
    assert.equal(env["GIT_CONFIG_KEY_2"], "url.https://forgejo.example.test/.insteadOf");
    assert.equal(env["GIT_CONFIG_VALUE_2"], "git@forgejo.example.test:");
    assert.equal(env["GIT_CONFIG_KEY_4"], "credential.https://forgejo.example.test.helper");
    assert.equal(env["GIT_CONFIG_VALUE_4"]?.includes(token), false);
    assert.equal(env["GIT_CONFIG_VALUE_4"]?.includes("$FORGEJO_TOKEN"), true);
    assert.equal(isForgejoAuthorityEnvironmentKey("FORGEJO_TOKEN"), true);
    assert.equal(isForgejoAuthorityEnvironmentKey("GIT_CONFIG_VALUE_4"), true);
  });
});
