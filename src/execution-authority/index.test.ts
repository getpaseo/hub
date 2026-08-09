import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { CompiledGitHubAuthority } from "../config/github-authority.js";
import type { ExecutionAuthorityClock } from "./index.js";
import { createExecutionAuthority } from "./index.js";

describe("Hub execution authority", () => {
  it.each(["discord", "slack", "github", "manual"] as const)(
    "resolves explicit connection templates for the %s trigger source without automatic GitHub authority",
    async (provider) => {
      const connectionRevocations: string[] = [];
      const authority = createExecutionAuthority({
        connectionsForProject: () => async (slug, value, context) => {
          await context?.registerToken?.(`${slug}-${value}`, async () => {
            connectionRevocations.push(`${slug}-${value}`);
          });
          return "resolved-secret";
        },
        githubAuthority: githubAuthorityFake(),
      });
      const authoredEnv = {
        SOME_TOKEN: "prefix-${{ paseo.connections.some-connection.token }}",
        SAME_TOKEN: "${{ paseo.connections.some-connection.token }}",
      };

      const launch = await authority.materialize({
        executionId: "execution-discord",
        projectId: "project-1",
        triggerContext: { provider },
        env: authoredEnv,
      });

      assert.deepEqual(launch.env, {
        SOME_TOKEN: "prefix-resolved-secret",
        SAME_TOKEN: "resolved-secret",
      });
      const launchEnv = launch.env as Record<string, string>;
      assert.equal(launchEnv["GH_TOKEN"], undefined);
      assert.equal(launchEnv["GIT_CONFIG_COUNT"], undefined);
      assert.deepEqual(authoredEnv, {
        SOME_TOKEN: "prefix-${{ paseo.connections.some-connection.token }}",
        SAME_TOKEN: "${{ paseo.connections.some-connection.token }}",
      });
      await authority.onExecutionTerminal("execution-discord");
      assert.deepEqual(connectionRevocations, ["some-connection-token"]);
    },
  );

  it("mints only explicit scoped GitHub authority and installs ordinary Git environment", async () => {
    const mint = githubAuthorityFake();
    const authority = createExecutionAuthority({
      connectionsForProject: () => async () => "unused",
      githubAuthority: mint,
    });
    const github: CompiledGitHubAuthority = {
      connection: "getpaseo-github",
      repositories: ["getpaseo/paseo", "getpaseo/hub"],
      permissions: { contents: "write", pull_requests: "write", issues: "read" },
      durationMs: 30 * 60 * 1000,
    };

    const launch = await authority.materialize({
      executionId: "execution-manual",
      projectId: "project-1",
      triggerContext: { provider: "manual" },
      github,
    });

    assert.deepEqual(mint.inputs, [
      {
        projectId: "project-1",
        connectionSlug: "getpaseo-github",
        repositories: ["getpaseo/paseo", "getpaseo/hub"],
        permissions: { contents: "write", pull_requests: "write", issues: "read" },
      },
    ]);
    assert.deepEqual(launch.env, {
      GH_TOKEN: "scoped-token-1",
      GIT_CONFIG_COUNT: "5",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "paseo[bot]",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "9876+paseo[bot]@users.noreply.github.com",
      GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_2: "git@github.com:",
      GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
      GIT_CONFIG_KEY_4: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_4: "!gh auth git-credential",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("defaults an omitted repository list to only the GitHub event repository", async () => {
    const mint = githubAuthorityFake();
    const authority = createExecutionAuthority({
      connectionsForProject: () => async () => "unused",
      githubAuthority: mint,
    });

    await authority.materialize({
      executionId: "execution-github",
      projectId: "project-1",
      triggerContext: {
        provider: "github",
        target: { repository: "getpaseo/paseo" },
      },
      github: {
        connection: "getpaseo-github",
        permissions: { contents: "read" },
        durationMs: 60 * 60 * 1000,
      },
    });

    assert.deepEqual(mint.inputs[0]?.repositories, ["getpaseo/paseo"]);
  });

  it("rejects an omitted repository list when no safe event repository exists", async () => {
    const mint = githubAuthorityFake();
    const authority = createExecutionAuthority({
      connectionsForProject: () => async () => "unused",
      githubAuthority: mint,
    });

    await assert.rejects(
      authority.materialize({
        executionId: "execution-manual-missing-repo",
        projectId: "project-1",
        triggerContext: { provider: "manual" },
        github: {
          connection: "getpaseo-github",
          permissions: { contents: "read" },
          durationMs: 60 * 60 * 1000,
        },
      }),
      /github\.repositories is required.*cannot safely expand/iu,
    );
    assert.deepEqual(mint.inputs, []);
  });

  it("revokes shorter leases at their deadline and every lease at terminal", async () => {
    const clock = new TestClock();
    const mint = githubAuthorityFake(() => clock.now());
    const authority = createExecutionAuthority({
      connectionsForProject: () => async () => "unused",
      githubAuthority: mint,
      clock,
    });
    const github = {
      connection: "getpaseo-github",
      repositories: ["getpaseo/paseo"],
      permissions: { contents: "read" },
      durationMs: 5 * 60 * 1000,
    } satisfies CompiledGitHubAuthority;

    await authority.materialize({
      executionId: "execution-short",
      projectId: "project-1",
      triggerContext: { provider: "manual" },
      github,
    });
    await clock.advance(4 * 60 * 1000);
    assert.deepEqual(mint.revoked, []);
    await clock.advance(60 * 1000);
    assert.deepEqual(mint.revoked, ["scoped-token-1"]);

    await authority.materialize({
      executionId: "execution-terminal",
      projectId: "project-1",
      triggerContext: { provider: "manual" },
      github,
    });
    await authority.onExecutionTerminal("execution-terminal");
    assert.deepEqual(mint.revoked, ["scoped-token-1", "scoped-token-2"]);
  });

  it("isolates per-step leases so terminal cleanup cannot revoke another step", async () => {
    const mint = githubAuthorityFake();
    const authority = createExecutionAuthority({
      connectionsForProject: () => async () => "unused",
      githubAuthority: mint,
    });
    const github = {
      connection: "getpaseo-github",
      repositories: ["getpaseo/paseo"],
      permissions: { contents: "read" },
      durationMs: 60 * 60 * 1000,
    } satisfies CompiledGitHubAuthority;

    await authority.materialize({
      executionId: "step-one-execution",
      projectId: "project-1",
      triggerContext: { provider: "manual" },
      github,
    });
    await authority.materialize({
      executionId: "step-two-execution",
      projectId: "project-1",
      triggerContext: { provider: "manual" },
      env: { CLASSIFIER_ONLY: "no-credential" },
    });
    await authority.onExecutionTerminal("step-two-execution");
    assert.deepEqual(mint.revoked, []);
    await authority.onExecutionTerminal("step-one-execution");
    assert.deepEqual(mint.revoked, ["scoped-token-1"]);
  });
});

function githubAuthorityFake(now: () => number = Date.now) {
  const inputs: Array<{
    projectId: string;
    connectionSlug: string;
    repositories: readonly string[];
    permissions: Readonly<Record<string, "read" | "write" | "admin">>;
  }> = [];
  const revoked: string[] = [];
  let count = 0;
  return {
    inputs,
    revoked,
    async mint(input: (typeof inputs)[number]) {
      inputs.push(input);
      count += 1;
      return {
        token: `scoped-token-${count}`,
        expiresAt: now() + 60 * 60 * 1000,
        botUserId: 9876,
        botLogin: "paseo[bot]",
      };
    },
    async revoke(token: string) {
      revoked.push(token);
    },
  };
}

class TestClock implements ExecutionAuthorityClock {
  private current = Date.parse("2026-08-01T00:00:00.000Z");
  private nextId = 0;
  private timers = new Map<number, { at: number; callback: () => Promise<void> }>();

  now(): number {
    return this.current;
  }

  schedule(callback: () => Promise<void>, delayMs: number): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return () => this.timers.delete(id);
  }

  async advance(delayMs: number): Promise<void> {
    this.current += delayMs;
    for (const [id, timer] of this.timers) {
      if (timer.at > this.current) continue;
      this.timers.delete(id);
      await timer.callback();
    }
  }
}
