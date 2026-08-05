import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import type { GitHubExecutionTokenAuth } from "../../auth/github.js";
import type { GitHubReactionClient } from "./provider.js";
import { createGitHubTriggerProvider } from "./provider.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";

describe("GitHub Phase 1 trigger provider", () => {
  it("matches a literal one-step prompt only after the security filters pass", async () => {
    const { project, revision, store } = await activeConfiguration();
    const reactions = new TestReactions();
    const provider = createProvider(store, reactions);
    const match = (await provider.match(external(project.id, createEvent())))[0];

    assert.ok(match);
    assert.equal(match.stepId, "github-step");
    assert.equal(match.prompt, "Handle the GitHub issue comment.");
    assert.equal(match.runTimeoutMs, 7_200_000);
    assert.equal(match.timeoutMs, 3_600_000);
    assert.equal(match.configurationRevisionId, revision.id);
    assert.equal(reactions.created.length, 0);

    const wrongActor = await provider.match(
      external(project.id, createEvent({ actor: "untrusted" })),
    );
    assert.deepEqual(wrongActor, []);
  });

  it("injects and revokes the execution-scoped GitHub token at launch cleanup", async () => {
    const { project, store } = await activeConfiguration();
    const reactions = new TestReactions();
    const tokens = new TestExecutionTokens();
    const provider = createProvider(store, reactions, tokens);
    const match = (await provider.match(external(project.id, createEvent())))[0];
    assert.ok(match);

    const materialized = await provider.materializeLaunch?.({
      executionId: "00000000-0000-4000-8000-000000000001",
      organizationId: "org_1",
      projectId: project.id,
      prompt: match.prompt,
      triggerContext: match.triggerContext,
    });
    assert.equal(materialized?.prompt, "Handle the GitHub issue comment.");
    assert.deepEqual(materialized?.environmentEnv, { GH_TOKEN: "execution-token-1" });
    await provider.onAgentExecutionTerminal?.(
      "00000000-0000-4000-8000-000000000001",
      match.triggerContext,
    );
    assert.deepEqual(tokens.revoked, ["execution-token-1"]);
  });

  it("preserves lifecycle reactions and reply-capability configuration", async () => {
    const { project, store } = await activeConfiguration();
    const reactions = new TestReactions();
    const provider = createProvider(store, reactions);
    const match = (await provider.match(external(project.id, createEvent())))[0];
    assert.ok(match);
    assert.deepEqual(match.allowOutputs, [{ type: "github.reply", max: 1 }]);
    await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionStarted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionCompleted?.(match.triggerContext, match.outputContext, {
      status: "succeeded",
    });
    assert.deepEqual(
      reactions.created.map((call) => call.content),
      ["eyes", "rocket", "+1"],
    );
  });
});

function createProvider(
  store: Awaited<ReturnType<typeof activeConfiguration>>["store"],
  reactions: TestReactions,
  executionTokens: GitHubExecutionTokenAuth = new TestExecutionTokens(),
) {
  return createGitHubTriggerProvider({
    configurationStoreForProject: () => store,
    reactions,
    executionTokens,
  });
}

async function activeConfiguration() {
  return createActiveProjectConfiguration(createMemoryDatabase(), {
    environments: [
      {
        name: "github-runner",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/repo",
      },
    ],
    triggers: [
      {
        name: "github-mention",
        on: "github.issue_comment",
        max_runtime: "2h",
        filters: { repo: "boudra/faro", contains: "@paseo", from_users: ["boudra"] },
        steps: [
          {
            id: "github-step",
            environment: "github-runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "claude/opus", mode: "bypassPermissions" },
            prompt: [{ text: "Handle the GitHub issue comment." }],
            allow_outputs: [{ type: "github.reply" }],
            auto_archive: true,
          },
        ],
      },
    ],
  });
}

function external(projectId: string, payload: NormalizedGitHubEvent) {
  return {
    organizationId: "org_1",
    projectId,
    source: `github.${payload.type}`,
    deliveryId: payload.id,
    receivedAt: new Date(),
    payload,
  };
}

function createEvent(overrides: { actor?: string } = {}): NormalizedGitHubEvent {
  const actor = overrides.actor ?? "boudra";
  return {
    id: "github-delivery-1",
    type: "issue_comment",
    repo: "boudra/faro",
    repositoryId: 7,
    installationId: 42,
    payload: {
      issue: { number: 211, title: "smoke", body: "smoke" },
      comment: {
        id: 123,
        body: "hello @paseo",
        html_url: "https://github.com/boudra/faro/issues/211#issuecomment-123",
        user: { login: actor },
      },
      sender: { login: actor },
    },
    createdAt: "2026-05-19T00:00:00.000Z",
  };
}

class TestReactions implements GitHubReactionClient {
  readonly created: Array<{ content: string }> = [];

  async createReaction(input: Parameters<GitHubReactionClient["createReaction"]>[0]) {
    this.created.push({ content: input.content });
    return { id: this.created.length };
  }

  async deleteReaction(): Promise<void> {}
}

class TestExecutionTokens implements GitHubExecutionTokenAuth {
  readonly revoked: string[] = [];
  private count = 0;

  async mintExecutionToken(): Promise<string> {
    this.count += 1;
    return `execution-token-${this.count}`;
  }

  async revokeInstallationToken(token: string): Promise<void> {
    this.revoked.push(token);
  }
}
