import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { buildLaunchMachineIntent } from "../../dispatcher/launch-machine-intent.js";
import type { GitHubReactionClient } from "./provider.js";
import { createGitHubTriggerProvider } from "./provider.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";

describe("GitHub trigger provider", () => {
  it("matches without side effects and acknowledges only after dispatch acceptance", async () => {
    const { project, revision: version, store } = await activeConfiguration(createConfig(true));
    const reactions = new MemoryGitHubReactions();
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions,
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.issue_comment",
      deliveryId: "delivery-1",
      receivedAt: new Date(),
      payload: createEvent(),
    });
    assert.equal(reactions.calls.length, 0);
    const match = matches[0];
    assert.ok(match);
    await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext);

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.configurationRevisionId, version.id);
    assert.equal(matches[0]?.environment.kind, "daemon");
    assert.equal(matches[0]?.environment.authoredSlug, "mob-hetzner");
    assert.equal(matches[0]?.autoArchive, true);
    assert.deepEqual(
      reactions.calls.map((call) => call.content),
      ["eyes"],
    );
  });

  it("interpolates rich GitHub webhook fields into the dispatched prompt", async () => {
    const { project, store } = await activeConfiguration(createConfig());
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions: new MemoryGitHubReactions(),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.issue_comment",
      deliveryId: "delivery-2",
      receivedAt: new Date(),
      payload: createEvent(),
    });

    const match = matches[0];
    assert.ok(match);
    const materialized = await provider.materializeLaunch?.({
      executionId: "execution-prompt",
      organizationId: "org_1",
      projectId: project.id,
      prompt: match.prompt,
      ...(match.environment.env === undefined ? {} : { environmentEnv: match.environment.env }),
      triggerContext: match.triggerContext,
    });
    assert.equal(materialized?.prompt, "Handle hello @paseo for issue 211");
  });

  it("interpolates pull_request_review_comment events through the same merge engine", async () => {
    const { project, store } = await activeConfiguration(createPullRequestReviewCommentConfig());
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions: new MemoryGitHubReactions(),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.pull_request_review_comment",
      deliveryId: "delivery-3",
      receivedAt: new Date(),
      payload: {
        id: "delivery-3",
        type: "pull_request_review_comment",
        repo: "boudra/faro",
        repositoryId: 7,
        installationId: 42,
        payload: {
          comment: { id: 999, body: "@paseo refactor this", user: { login: "boudra" } },
          sender: { login: "boudra" },
          pull_request: { head: { ref: "topic-branch" } },
        },
        createdAt: "2026-05-19T00:00:00.000Z",
      },
    });

    const match = matches[0];
    assert.ok(match);
    const materialized = await provider.materializeLaunch?.({
      executionId: "execution-review",
      organizationId: "org_1",
      projectId: project.id,
      prompt: match.prompt,
      ...(match.environment.env === undefined ? {} : { environmentEnv: match.environment.env }),
      triggerContext: match.triggerContext,
    });
    assert.match(materialized?.prompt ?? "", /^review comment from .+: @paseo refactor this$/u);
  });

  it("passes daemon worktree targets through matched trigger environments", async () => {
    const { project, store } = await activeConfiguration(createConfigWithWorktree());
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions: new MemoryGitHubReactions(),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.issue_comment",
      deliveryId: "delivery-worktree",
      receivedAt: new Date(),
      payload: createEvent(),
    });

    assert.deepEqual(matches[0]?.environment, {
      kind: "daemon",
      daemonId: "daemon-mob-hetzner",
      authoredSlug: "mob-hetzner",
      cwd: "/home/moboudra/dev/faro",
      worktree: {
        mode: "branch-off",
        newBranch: "trigger-${{ paseo.event.github.issue.number }}",
        base: "main",
      },
    });
  });

  it("keeps worktree integration secrets out of durable intent and resolves them on recovery", async () => {
    const {
      project,
      revision: version,
      store,
    } = await activeConfiguration(createConfigWithIntegrationWorktree());
    const calls: string[] = [];
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions: new MemoryGitHubReactions(),
      connectionsForProject: () => (_slug, value) => {
        calls.push(value);
        return Promise.resolve("worktree-secret");
      },
    });

    const [match] = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.issue_comment",
      deliveryId: "delivery-worktree-integration",
      receivedAt: new Date(),
      payload: createEvent(),
    });
    assert.ok(match);
    const intent = buildLaunchMachineIntent({
      ...match,
      organizationId: "org_1",
      projectId: project.id,
      triggerId: "trigger-worktree-integration",
      configurationRevisionId: version.id,
    });

    assert.equal(JSON.stringify(intent).includes("worktree-secret"), false);
    assert.deepEqual(calls, []);
    const materialized = await provider.materializeLaunch?.({
      executionId: "execution-worktree-integration",
      organizationId: intent.organizationId,
      projectId: intent.projectId,
      prompt: intent.prompt,
      ...(intent.environment.env === undefined ? {} : { environmentEnv: intent.environment.env }),
      ...(intent.environment.worktree === undefined
        ? {}
        : { environmentWorktree: intent.environment.worktree }),
      triggerContext: structuredClone(match.triggerContext),
    });

    assert.deepEqual(materialized?.environmentWorktree, {
      mode: "branch-off",
      newBranch: "trigger-worktree-secret",
      base: "issue-211",
    });
    assert.deepEqual(calls, ["value"]);
  });

  it("resolves the project's GitHub integration into the environment", async () => {
    const { project, store } = await activeConfiguration(createConfigWithGithubToken());
    const calls: Array<{ organizationId: string; slug: string; value: string }> = [];
    const executionTokens = new MemoryGitHubExecutionTokens();
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions: new MemoryGitHubReactions(),
      connectionsForProject: (projectId) => (slug, value) => {
        calls.push({ organizationId: projectId, slug, value });
        return Promise.resolve("test-install-token-42");
      },
      executionTokens,
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.issue_comment",
      deliveryId: "delivery-4",
      receivedAt: new Date(),
      payload: createEvent(),
    });

    const match = matches[0];
    assert.ok(match);
    assert.equal(
      match.environment.env?.["GITHUB_TOKEN"],
      "${{ paseo.connections.getpaseo-github.token }}",
    );
    const materialized = await provider.materializeLaunch?.({
      executionId: "execution-token",
      organizationId: "org_1",
      projectId: project.id,
      prompt: match.prompt,
      ...(match.environment.env === undefined ? {} : { environmentEnv: match.environment.env }),
      triggerContext: match.triggerContext,
    });
    assert.deepEqual(materialized?.environmentEnv, {
      GITHUB_TOKEN: "test-install-token-42",
      ISSUE_NUMBER: "211",
      GH_TOKEN: "test-execution-token-1",
    });
    assert.deepEqual(calls, [
      { organizationId: project.id, slug: "getpaseo-github", value: "token" },
    ]);
  });

  it("keeps GitHub token templates out of durable match materialization", async () => {
    const { project, store } = await activeConfiguration(createConfigWithGithubToken());
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions: new MemoryGitHubReactions(),
    });

    const [match] = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.issue_comment",
      deliveryId: "delivery-5",
      receivedAt: new Date(),
      payload: createEvent(),
    });
    assert.equal(
      match?.environment.env?.["GITHUB_TOKEN"],
      "${{ paseo.connections.getpaseo-github.token }}",
    );
  });

  it("exposes the typed GitHub trigger URL from comment payloads", async () => {
    const { project, store } = await activeConfiguration(createUrlConfig("github.issue_comment"));
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions: new MemoryGitHubReactions(),
    });

    const [match] = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.issue_comment",
      deliveryId: "delivery-url",
      receivedAt: new Date(),
      payload: createEvent(),
    });

    assert.ok(match);
    const materialized = await provider.materializeLaunch?.({
      executionId: "execution-url",
      organizationId: "org_1",
      projectId: project.id,
      prompt: match.prompt,
      ...(match.environment.env === undefined ? {} : { environmentEnv: match.environment.env }),
      triggerContext: match.triggerContext,
    });
    assert.equal(
      materialized?.prompt,
      "inspect https://github.com/boudra/faro/issues/211#issuecomment-123",
    );
    assert.equal("agentEnv" in Object(match), false);
  });

  it("exposes the typed GitHub trigger URL from review payloads", async () => {
    const { project, store } = await activeConfiguration(
      createUrlConfig("github.pull_request_review"),
    );
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions: new MemoryGitHubReactions(),
    });

    const [match] = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.pull_request_review",
      deliveryId: "delivery-review-url",
      receivedAt: new Date(),
      payload: createReviewEvent(),
    });

    assert.ok(match);
    const materialized = await provider.materializeLaunch?.({
      executionId: "execution-review-url",
      organizationId: "org_1",
      projectId: project.id,
      prompt: match.prompt,
      ...(match.environment.env === undefined ? {} : { environmentEnv: match.environment.env }),
      triggerContext: match.triggerContext,
    });
    assert.equal(
      materialized?.prompt,
      "inspect https://github.com/boudra/faro/pull/211#pullrequestreview-456",
    );
  });

  it("posts lifecycle reactions against the original event target", async () => {
    const reactions = new MemoryGitHubReactions();
    const { store } = await activeConfiguration(createConfig());
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions,
    });
    const source = createEvent();
    const context = {
      provider: "github" as const,
      target: { installationId: source.installationId, repository: source.repo },
      event: {
        github: {
          delivery_id: source.id,
          event_name: source.type,
          repository_full_name: source.repo,
          installation_id: source.installationId,
          received_at: source.createdAt,
        },
      },
      reactionSubject: { kind: "issue_comment" as const, commentId: 123 },
    };

    await provider.onAgentExecutionStarted?.(context, context);
    await provider.onAgentExecutionCompleted?.(context, context, { status: "succeeded" });
    await provider.onAgentExecutionFailed?.(context, context, "failed");

    assert.deepEqual(
      reactions.calls.map((call) => call.content),
      ["rocket", "+1", "-1"],
    );
  });

  it("replaces the in-progress reaction when an execution starts", async () => {
    const { project, store } = await activeConfiguration(createConfig());
    const reactions = new MemoryGitHubReactions();
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions,
    });

    const [match] = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.issue_comment",
      deliveryId: "delivery-6",
      receivedAt: new Date(),
      payload: createEvent(),
    });
    assert.ok(match);
    await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionStarted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionCompleted?.(match.triggerContext, match.outputContext, {
      status: "succeeded",
    });

    assert.deepEqual(
      reactions.deletions.map((call) => call.reactionId),
      [1],
    );
    assert.deepEqual(
      reactions.calls.map((call) => call.content),
      ["eyes", "rocket", "+1"],
    );
  });

  it("replaces the in-progress reaction when an execution fails", async () => {
    const { project, store } = await activeConfiguration(createConfig());
    const reactions = new MemoryGitHubReactions();
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions,
    });

    const [match] = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.issue_comment",
      deliveryId: "delivery-7",
      receivedAt: new Date(),
      payload: createEvent(),
    });
    assert.ok(match);
    await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionFailed?.(match.triggerContext, match.outputContext, "boom");

    assert.deepEqual(
      reactions.deletions.map((call) => call.reactionId),
      [1],
    );
    assert.deepEqual(
      reactions.calls.map((call) => call.content),
      ["eyes", "-1"],
    );
  });

  it("revokes every token minted for an execution on its terminal hook", async () => {
    const { project, store } = await activeConfiguration(createConfig());
    const executionTokens = new MemoryGitHubExecutionTokens();
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions: new MemoryGitHubReactions(),
      executionTokens,
    });
    const [match] = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.issue_comment",
      deliveryId: "delivery-terminal",
      receivedAt: new Date(),
      payload: createEvent(),
    });
    assert.ok(match);
    const launch = {
      executionId: "execution-terminal",
      organizationId: "org_1",
      projectId: project.id,
      prompt: match.prompt,
      ...(match.environment.env === undefined ? {} : { environmentEnv: match.environment.env }),
      triggerContext: match.triggerContext,
    };

    await provider.materializeLaunch?.(launch);
    await provider.materializeLaunch?.(launch);
    await provider.onAgentExecutionTerminal?.("execution-terminal", match.triggerContext);

    assert.deepEqual(executionTokens.mints, [
      { installationId: 42, repository: createEvent().repo },
      { installationId: 42, repository: createEvent().repo },
    ]);
    assert.deepEqual(executionTokens.revocations, [
      "test-execution-token-1",
      "test-execution-token-2",
    ]);
  });

  it("revokes a token whose mint resolves after the execution becomes terminal", async () => {
    const { project, store } = await activeConfiguration(createConfig());
    const executionTokens = new DeferredGitHubExecutionTokens();
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions: new MemoryGitHubReactions(),
      executionTokens,
    });
    const [match] = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.issue_comment",
      deliveryId: "delivery-terminal-mint-race",
      receivedAt: new Date(),
      payload: createEvent(),
    });
    assert.ok(match);

    const materialization = provider.materializeLaunch?.({
      executionId: "execution-terminal-mint-race",
      organizationId: "org_1",
      projectId: project.id,
      prompt: match.prompt,
      triggerContext: match.triggerContext,
    });
    assert.ok(materialization);
    await provider.onAgentExecutionTerminal?.("execution-terminal-mint-race", match.triggerContext);
    executionTokens.resolveMint("test-racing-execution");

    await assert.rejects(materialization, /cannot materialize terminal execution/u);
    assert.deepEqual(executionTokens.revocations, ["test-racing-execution"]);
  });

  it("rejects materialization that becomes terminal during interpolation", async () => {
    const { project, store } = await activeConfiguration(createConfigWithDeferredIntegration());
    let releaseInterpolation!: () => void;
    const interpolationGate = new Promise<string>((resolve) => {
      releaseInterpolation = () => resolve("resolved");
    });
    let interpolationStarted = false;
    const executionTokens = new MemoryGitHubExecutionTokens();
    const provider = createProvider({
      configurationStoreForProject: () => store,
      reactions: new MemoryGitHubReactions(),
      executionTokens,
      connectionsForProject: () => (_slug, value) => {
        if (value === "deferred") {
          interpolationStarted = true;
          return interpolationGate;
        }
        throw new Error(`unexpected connection value: ${value}`);
      },
    });
    const [match] = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "github.issue_comment",
      deliveryId: "delivery-terminal-interpolation-race",
      receivedAt: new Date(),
      payload: createEvent(),
    });
    assert.ok(match);

    const materialization = provider.materializeLaunch?.({
      executionId: "execution-terminal-interpolation-race",
      organizationId: "org_1",
      projectId: project.id,
      prompt: match.prompt,
      triggerContext: match.triggerContext,
    });
    assert.ok(materialization);
    await vi.waitFor(() => assert.equal(interpolationStarted, true));
    await provider.onAgentExecutionTerminal?.(
      "execution-terminal-interpolation-race",
      match.triggerContext,
    );
    releaseInterpolation();

    await assert.rejects(materialization, /cannot materialize terminal execution/u);
    assert.deepEqual(executionTokens.revocations, ["test-execution-token-1"]);
  });

  it("bounds terminal cleanup when GitHub token revocation hangs", async () => {
    vi.useFakeTimers();
    try {
      const { project, store } = await activeConfiguration(createConfig());
      const executionTokens = new MemoryGitHubExecutionTokens(true);
      const provider = createProvider({
        configurationStoreForProject: () => store,
        reactions: new MemoryGitHubReactions(),
        executionTokens,
      });
      const [match] = await provider.match({
        organizationId: "org_1",
        projectId: project.id,
        source: "github.issue_comment",
        deliveryId: "delivery-hanging-revocation",
        receivedAt: new Date(),
        payload: createEvent(),
      });
      assert.ok(match);
      await provider.materializeLaunch?.({
        executionId: "execution-hanging-revocation",
        organizationId: "org_1",
        projectId: project.id,
        prompt: match.prompt,
        triggerContext: match.triggerContext,
      });

      const cleanup = provider.onAgentExecutionTerminal?.(
        "execution-hanging-revocation",
        match.triggerContext,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await cleanup;

      assert.deepEqual(executionTokens.revocations, ["test-execution-token-1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

class MemoryGitHubReactions implements GitHubReactionClient {
  readonly calls: Parameters<GitHubReactionClient["createReaction"]>[0][] = [];
  readonly deletions: Parameters<GitHubReactionClient["deleteReaction"]>[0][] = [];
  private nextId = 1;

  async createReaction(input: Parameters<GitHubReactionClient["createReaction"]>[0]) {
    this.calls.push(input);
    return { id: this.nextId++ };
  }

  async deleteReaction(input: Parameters<GitHubReactionClient["deleteReaction"]>[0]) {
    this.deletions.push(input);
  }
}

class MemoryGitHubExecutionTokens {
  readonly mints: Array<{ installationId: number; repository: string }> = [];
  readonly revocations: string[] = [];

  constructor(private readonly hangRevocation = false) {}

  mintExecutionToken(input: { installationId: number; repository: string }): Promise<string> {
    this.mints.push(input);
    return Promise.resolve(`test-execution-token-${this.mints.length}`);
  }

  revokeInstallationToken(token: string): Promise<void> {
    this.revocations.push(token);
    if (this.hangRevocation) return new Promise(() => undefined);
    return Promise.resolve();
  }
}

class DeferredGitHubExecutionTokens extends MemoryGitHubExecutionTokens {
  private resolvePendingMint: ((token: string) => void) | undefined;

  override mintExecutionToken(input: {
    installationId: number;
    repository: string;
  }): Promise<string> {
    this.mints.push(input);
    return new Promise((resolve) => {
      this.resolvePendingMint = resolve;
    });
  }

  resolveMint(token: string): void {
    assert.ok(this.resolvePendingMint);
    this.resolvePendingMint(token);
    this.resolvePendingMint = undefined;
  }
}

function createProvider(
  options: Omit<Parameters<typeof createGitHubTriggerProvider>[0], "executionTokens"> & {
    executionTokens?: MemoryGitHubExecutionTokens | DeferredGitHubExecutionTokens;
  },
) {
  return createGitHubTriggerProvider({
    ...options,
    executionTokens: options.executionTokens ?? new MemoryGitHubExecutionTokens(),
  });
}

function activeConfiguration(rawConfiguration: unknown) {
  return createActiveProjectConfiguration(createMemoryDatabase(), rawConfiguration);
}

function createConfig(autoArchive = false): unknown {
  return {
    environments: [
      {
        name: "hetzner-faro",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/home/moboudra/dev/faro",
      },
    ],
    triggers: [
      {
        name: "faro-mention",
        on: "github.issue_comment",
        environment: "hetzner-faro",
        filters: {
          repo: "boudra/faro",
          contains: "@paseo",
          from_users: ["boudra"],
        },
        agent: { provider: "claude/opus", mode: "bypassPermissions" },
        prompt:
          "Handle ${{ paseo.event.github.comment.body }} for issue ${{ paseo.event.github.issue.number }}",
        auto_archive: autoArchive,
      },
    ],
  };
}

function createConfigWithGithubToken(prompt = "ping"): unknown {
  return {
    environments: [
      {
        name: "hetzner-faro",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/home/moboudra/dev/faro",
      },
    ],
    triggers: [
      {
        name: "faro-mention",
        on: "github.issue_comment",
        environment: "hetzner-faro",
        filters: {
          repo: "boudra/faro",
          contains: "@paseo",
          from_users: ["boudra"],
        },
        agent: { provider: "claude/opus", mode: "bypassPermissions" },
        prompt,
        env: {
          GITHUB_TOKEN: "${{ paseo.connections.getpaseo-github.token }}",
          ISSUE_NUMBER: "${{ paseo.event.github.issue.number }}",
        },
      },
    ],
  };
}

function createConfigWithDeferredIntegration(): unknown {
  return createConfigWithGithubToken("${{ paseo.connections.getpaseo-github.deferred }}");
}

function createConfigWithWorktree(): unknown {
  return {
    environments: [
      {
        name: "hetzner-faro",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/home/moboudra/dev/faro",
        worktree: {
          mode: "branch-off",
          newBranch: "trigger-${{ paseo.event.github.issue.number }}",
          base: "main",
        },
      },
    ],
    triggers: [
      {
        name: "faro-mention",
        on: "github.issue_comment",
        environment: "hetzner-faro",
        filters: {
          repo: "boudra/faro",
          contains: "@paseo",
          from_users: ["boudra"],
        },
        agent: { provider: "claude/opus", mode: "bypassPermissions" },
        prompt:
          "Handle ${{ paseo.event.github.comment.body }} for issue ${{ paseo.event.github.issue.number }}",
      },
    ],
  };
}

function createConfigWithIntegrationWorktree(): unknown {
  return {
    environments: [
      {
        name: "hetzner-faro",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/home/moboudra/dev/faro",
        worktree: {
          mode: "branch-off",
          newBranch: "trigger-${{ paseo.connections.getpaseo-github.value }}",
          base: "issue-${{ paseo.event.github.issue.number }}",
        },
      },
    ],
    triggers: [
      {
        name: "faro-mention",
        on: "github.issue_comment",
        environment: "hetzner-faro",
        filters: {
          repo: "boudra/faro",
          contains: "@paseo",
          from_users: ["boudra"],
        },
        agent: { provider: "claude/opus", mode: "bypassPermissions" },
        prompt: "Handle ${{ paseo.event.github.comment.body }}",
      },
    ],
  };
}

function createUrlConfig(on: string): unknown {
  return {
    environments: [
      {
        name: "hetzner-faro",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/home/moboudra/dev/faro",
      },
    ],
    triggers: [
      {
        name: "faro-mention",
        on,
        environment: "hetzner-faro",
        filters: {
          repo: "boudra/faro",
          contains: "@paseo",
          from_users: ["boudra"],
        },
        agent: { provider: "claude/opus", mode: "bypassPermissions" },
        prompt: "inspect ${{ paseo.event.github.trigger_url }}",
      },
    ],
  };
}

function createPullRequestReviewCommentConfig(): unknown {
  return {
    environments: [
      {
        name: "hetzner-faro",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/home/moboudra/dev/faro",
      },
    ],
    triggers: [
      {
        name: "faro-review",
        on: "github.pull_request_review_comment",
        environment: "hetzner-faro",
        filters: { repo: "boudra/faro", contains: "@paseo", from_users: ["boudra"] },
        agent: { provider: "claude/opus", mode: "bypassPermissions" },
        prompt:
          "review comment from ${{ paseo.event.github.sender.login }}: ${{ paseo.event.github.comment.body }}",
      },
    ],
  };
}

function createEvent(): NormalizedGitHubEvent {
  return {
    id: "delivery-1",
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
        user: { login: "boudra" },
      },
      sender: { login: "boudra" },
    },
    createdAt: "2026-05-19T00:00:00.000Z",
  };
}

function createReviewEvent(): NormalizedGitHubEvent {
  return {
    id: "delivery-review",
    type: "pull_request_review",
    repo: "boudra/faro",
    repositoryId: 7,
    installationId: 42,
    payload: {
      pull_request: {
        html_url: "https://github.com/boudra/faro/pull/211",
        head: { ref: "topic-branch" },
      },
      review: {
        body: "@paseo review this",
        html_url: "https://github.com/boudra/faro/pull/211#pullrequestreview-456",
        user: { login: "boudra" },
      },
      sender: { login: "boudra" },
    },
    createdAt: "2026-05-19T00:00:00.000Z",
  };
}
