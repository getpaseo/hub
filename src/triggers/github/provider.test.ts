import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import type { DurableProviderEvent } from "../../db/types.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { createDurableWorkflowHandler } from "../../workflows/engine.js";
import type { GitHubExecutionTokenAuth } from "../../auth/github.js";
import type { GitHubReactionClient } from "./provider.js";
import { createGitHubTriggerProvider } from "./provider.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { isAcceptedTriggerProviderMatch } from "../index.js";
import { createUnlimitedEntitlementsService } from "../../entitlements/test-utils.js";

describe("GitHub Phase 1 trigger provider", () => {
  it("normalizes typed inputs identically at the provider boundary", async () => {
    const { project, revision, store } = await activeConfiguration(inputConfiguration());
    const provider = createProvider(store, new TestReactions());

    const match = (
      await provider.match(
        external(
          project.id,
          revision.id,
          createEvent({ body: "@paseo repo=hub agent=opus investigate" }),
        ),
      )
    )[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.deepEqual(match.invocation, {
      status: "accepted",
      rawMessage: "@paseo repo=hub agent=opus investigate",
      prompt: "investigate",
      inputs: { repo: "hub", agent: "opus" },
    });
  });

  it("parses typed inputs after a matched contains marker in leading prose", async () => {
    const { project, revision, store } = await activeConfiguration(inputConfiguration());
    const provider = createProvider(store, new TestReactions());

    const match = (
      await provider.match(
        external(
          project.id,
          revision.id,
          createEvent({ body: "please @paseo repo=hub agent=opus investigate" }),
        ),
      )
    )[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.deepEqual(match.invocation, {
      status: "accepted",
      rawMessage: "please @paseo repo=hub agent=opus investigate",
      prompt: "investigate",
      inputs: { repo: "hub", agent: "opus" },
    });
  });

  it("matches a literal one-step prompt only after the security filters pass", async () => {
    const { project, revision, store } = await activeConfiguration();
    const reactions = new TestReactions();
    const provider = createProvider(store, reactions);
    const match = (await provider.match(external(project.id, revision.id, createEvent())))[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.configurationRevisionId, revision.id);
    assert.equal(reactions.created.length, 0);

    const wrongActor = await provider.match(
      external(project.id, revision.id, createEvent({ actor: "untrusted" })),
    );
    assert.deepEqual(wrongActor, []);
  });

  it("injects and revokes the execution-scoped GitHub token at launch cleanup", async () => {
    const { project, revision, store } = await activeConfiguration();
    const reactions = new TestReactions();
    const tokens = new TestExecutionTokens();
    const provider = createProvider(store, reactions, tokens);
    const match = (await provider.match(external(project.id, revision.id, createEvent())))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    const materialized = await provider.materializeLaunch?.({
      executionId: "00000000-0000-4000-8000-000000000001",
      organizationId: "org_1",
      projectId: project.id,
      prompt: "Handle the GitHub issue comment.",
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
    const { project, revision, store } = await activeConfiguration();
    const reactions = new TestReactions();
    const provider = createProvider(store, reactions);
    const match = (await provider.match(external(project.id, revision.id, createEvent())))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
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

  it("replaces GitHub in-progress reactions on terminal failure at the event target", async () => {
    const { project, revision, store } = await activeConfiguration();
    const reactions = new TestReactions();
    const provider = createProvider(store, reactions);
    const match = (await provider.match(external(project.id, revision.id, createEvent())))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionFailed?.(match.triggerContext, match.outputContext, "boom");

    assert.deepEqual(
      reactions.created.map((call) => call.content),
      ["eyes", "-1"],
    );
    assert.deepEqual(
      reactions.deleted.map((call) => call.reactionId),
      [1],
    );
    assert.deepEqual(reactions.deleted[0], {
      installationId: 42,
      repo: "boudra/faro",
      subject: { kind: "issue_comment", commentId: 123 },
      reactionId: 1,
    });
  });

  it("passes a static worktree target through durable launch recovery", async () => {
    const { project, revision, store } = await activeConfiguration(githubWorktreeConfiguration());
    const provider = createProvider(store, new TestReactions());
    const match = (await provider.match(external(project.id, revision.id, createEvent())))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    const worktree = {
      mode: "branch-off",
      newBranch: "github-recovery",
      base: "main",
    } as const;
    const materialized = await provider.materializeLaunch?.({
      executionId: "00000000-0000-4000-8000-000000000002",
      organizationId: "org_1",
      projectId: project.id,
      prompt: "Handle the GitHub issue comment.",
      environmentWorktree: worktree,
      triggerContext: match.triggerContext,
    });
    assert.deepEqual(materialized?.environmentWorktree, worktree);
  });

  it("revokes every token minted before terminal cleanup", async () => {
    const { project, revision, store } = await activeConfiguration();
    const tokens = new TestExecutionTokens();
    const provider = createProvider(store, new TestReactions(), tokens);
    const match = (await provider.match(external(project.id, revision.id, createEvent())))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    const launch = {
      executionId: "00000000-0000-4000-8000-000000000003",
      organizationId: "org_1",
      projectId: project.id,
      prompt: "Handle the GitHub issue comment.",
      triggerContext: match.triggerContext,
    };

    await provider.materializeLaunch?.(launch);
    await provider.materializeLaunch?.(launch);
    await provider.onAgentExecutionTerminal?.(launch.executionId, match.triggerContext);
    assert.deepEqual(tokens.revoked, ["execution-token-1", "execution-token-2"]);
  });

  it("rejects materialization when the execution becomes terminal mid-flight", async () => {
    const { project, revision, store } = await activeConfiguration();
    const tokens = new DeferredExecutionTokens();
    const provider = createProvider(store, new TestReactions(), tokens);
    const match = (await provider.match(external(project.id, revision.id, createEvent())))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    const executionId = "00000000-0000-4000-8000-000000000004";
    const materialization = provider.materializeLaunch?.({
      executionId,
      organizationId: "org_1",
      projectId: project.id,
      prompt: "Handle the GitHub issue comment.",
      triggerContext: match.triggerContext,
    });
    assert.ok(materialization);
    await provider.onAgentExecutionTerminal?.(executionId, match.triggerContext);
    tokens.resolve("racing-execution-token");
    await assert.rejects(materialization, /cannot materialize terminal execution/u);
    assert.deepEqual(tokens.revoked, ["racing-execution-token"]);
  });

  it("bounds cleanup when GitHub token revocation hangs", async () => {
    vi.useFakeTimers();
    try {
      const { project, revision, store } = await activeConfiguration();
      const tokens = new TestExecutionTokens(true);
      const provider = createProvider(store, new TestReactions(), tokens);
      const match = (await provider.match(external(project.id, revision.id, createEvent())))[0];
      if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
      const executionId = "00000000-0000-4000-8000-000000000005";
      await provider.materializeLaunch?.({
        executionId,
        organizationId: "org_1",
        projectId: project.id,
        prompt: "Handle the GitHub issue comment.",
        triggerContext: match.triggerContext,
      });
      const cleanup = provider.onAgentExecutionTerminal?.(executionId, match.triggerContext);
      assert.ok(cleanup);
      await vi.advanceTimersByTimeAsync(10_000);
      await cleanup;
      assert.deepEqual(tokens.revoked, ["execution-token-1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands every matching configured GitHub trigger to the durable fan-out boundary", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await activeFanoutConfiguration(database);
    const provider = createProvider(store, new TestReactions());
    const matches = await provider.match(external(project.id, revision.id, createEvent()));
    assert.deepEqual(
      matches.map((match) => match.triggerName),
      ["github-mention", "github-mention-secondary"],
    );

    let dispatches = 0;
    const { handler, engine } = createDurableWorkflowHandler({
      database,
      entitlements: createUnlimitedEntitlementsService(),
      providers: [provider],
      dispatchLaunchMachineIntent: async (intent) => {
        dispatches += 1;
        if (intent.workflowStepRunId === undefined) throw new Error("workflow step is required");
        const execution = await database.findAgentExecutionByWorkflowStepRunId(
          intent.workflowStepRunId,
        );
        if (execution === undefined) throw new Error("workflow execution was not persisted");
        return {
          execution,
        };
      },
    });
    const trigger = {
      providerEventReceiptId: "github-fanout-trigger",
      organizationId: "org_1",
      projectId: project.id,
      configurationRevisionId: revision.id,
      source: "github.issue_comment",
      deliveryId: "github-fanout-delivery",
      receivedAt: new Date(),
      payload: createEvent(),
      connectionId: null,
      resourceId: null,
    } satisfies DurableProviderEvent;

    await handler(trigger);
    await handler(trigger);
    await engine.processAvailable();

    const runs = await database.findTriggerRunsByProviderEventReceiptId(
      trigger.providerEventReceiptId,
    );
    assert.equal(runs.length, 2);
    assert.equal(dispatches, 2);
    assert.equal(
      new Set(
        await Promise.all(
          runs.map(async (run) => {
            const step = await database.findWorkflowStepRunByTriggerRun(run.id);
            assert.ok(step);
            const execution = await database.findAgentExecutionByWorkflowStepRunId(step.id);
            assert.ok(execution);
            return execution.id;
          }),
        ),
      ).size,
      2,
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

async function activeConfiguration(rawConfiguration = githubConfiguration()) {
  return createActiveProjectConfiguration(createMemoryDatabase(), rawConfiguration);
}

function inputConfiguration() {
  const base = githubConfiguration();
  const trigger = base.triggers[0]!;
  return {
    ...base,
    triggers: [
      {
        ...trigger,
        inputs: {
          repo: { type: "string", choices: ["paseo", "hub"] },
          agent: { type: "string", default: "codex", choices: ["codex", "opus"] },
        },
        filters: { ...trigger.filters, inputs: { repo: "hub" } },
        steps: [
          {
            ...trigger.steps[0]!,
            agent: { provider: "${{ paseo.inputs.agent }}", mode: "bypassPermissions" },
            prompt: [{ text: "Request: ${{ paseo.prompt }}" }],
          },
        ],
      },
    ],
  };
}

function githubWorktreeConfiguration() {
  const configuration = githubConfiguration();
  return {
    ...configuration,
    environments: [
      {
        ...configuration.environments[0]!,
        worktree: { mode: "branch-off" as const, newBranch: "github-recovery", base: "main" },
      },
    ],
  };
}

async function activeFanoutConfiguration(database: ReturnType<typeof createMemoryDatabase>) {
  const configuration = githubConfiguration();
  const first = configuration.triggers[0]!;
  configuration.triggers.push({
    ...first,
    name: "github-mention-secondary",
    steps: [{ ...first.steps[0]!, id: "github-step-secondary" }],
  });
  return createActiveProjectConfiguration(database, configuration);
}

function githubConfiguration() {
  return {
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
  };
}

function external(
  projectId: string,
  configurationRevisionId: string,
  payload: NormalizedGitHubEvent,
) {
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
    organizationId: "org_1",
    projectId,
    configurationRevisionId,
    source: `github.${payload.type}`,
    deliveryId: payload.id,
    receivedAt: new Date(),
    payload,
  };
}

function createEvent(overrides: { actor?: string; body?: string } = {}): NormalizedGitHubEvent {
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
        body: overrides.body ?? "hello @paseo",
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
  readonly deleted: Array<Parameters<GitHubReactionClient["deleteReaction"]>[0]> = [];

  async createReaction(input: Parameters<GitHubReactionClient["createReaction"]>[0]) {
    this.created.push({ content: input.content });
    return { id: this.created.length };
  }

  async deleteReaction(input: Parameters<GitHubReactionClient["deleteReaction"]>[0]) {
    this.deleted.push(input);
  }
}

class TestExecutionTokens implements GitHubExecutionTokenAuth {
  readonly revoked: string[] = [];
  private count = 0;

  constructor(private readonly hangRevocation = false) {}

  async mintExecutionToken(): Promise<string> {
    this.count += 1;
    return `execution-token-${this.count}`;
  }

  async revokeInstallationToken(token: string): Promise<void> {
    this.revoked.push(token);
    if (this.hangRevocation) return new Promise(() => undefined);
  }
}

class DeferredExecutionTokens implements GitHubExecutionTokenAuth {
  readonly revoked: string[] = [];
  private resolveMint!: (token: string) => void;

  async mintExecutionToken(): Promise<string> {
    return new Promise((resolve) => {
      this.resolveMint = resolve;
    });
  }

  resolve(token: string): void {
    this.resolveMint(token);
  }

  async revokeInstallationToken(token: string): Promise<void> {
    this.revoked.push(token);
  }
}
