import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import type { SlackBotClient, SlackThreadMessage } from "./client.js";
import { createSlackTriggerProvider } from "./provider.js";

describe("Slack trigger provider", () => {
  it("keeps Slack context inside the provider while producing a generic dispatch match", async () => {
    const database = createMemoryDatabase();
    const { project, store } = await createActiveProjectConfiguration(database, config(), {
      organizationId: "org-1",
    });
    const client = new RecordingSlackClient();
    let integrationResolutions = 0;
    let resolutionContext: { executionId?: string } | undefined;
    let workspaceAvailable = true;
    const botUserLookups: Array<[string, string]> = [];
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      connectionsForProject: () => (_slug, value, context) => {
        integrationResolutions += 1;
        resolutionContext = context;
        assert.equal(value, "token");
        return "secret-token";
      },
      botUserIdForWorkspace: (organizationId, teamId) => {
        if (!workspaceAvailable) throw new Error("workspace lookup must not run during recovery");
        botUserLookups.push([organizationId, teamId]);
        return Promise.resolve("UBOT");
      },
      client,
    });

    const [match] = await provider.match({
      organizationId: "org-1",
      projectId: project.id,
      source: "slack.mention",
      deliveryId: "slack-Ev1",
      receivedAt: new Date(),
      payload: event(),
    });

    assert.equal(
      match?.prompt,
      "Handle ${{ paseo.event.slack.trigger_message.body }} from ${{ paseo.event.slack.trigger_message.author.id }} with ${{ paseo.connections.getpaseo-github.token }}",
    );
    assert.deepEqual(match?.environment, {
      kind: "daemon",
      daemonId: "daemon-main",
      authoredSlug: "main",
      cwd: "/repo",
      env: { GITHUB_TOKEN: "${{ paseo.connections.getpaseo-github.token }}" },
      worktree: {
        mode: "branch-off",
        newBranch:
          "slack-${{ paseo.event.slack.trigger_message.ts }}-${{ paseo.connections.getpaseo-github.token }}",
        base: "body-${{ paseo.event.slack.trigger_message.body }}",
      },
    });
    assert.equal(integrationResolutions, 0);
    assert.deepEqual(match?.triggerContext, {
      provider: "slack",
      target: {
        provider: "slack",
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1700000000.000001",
        messageTs: "1700000000.000001",
      },
      event: {
        slack: {
          event_type: "app_mention",
          event_id: "Ev1",
          event_ts: "1700000000.000001",
          event_time: 1_700_000_001,
          team: { id: "T1" },
          app: { id: "A1" },
          trigger_message: {
            ts: "1700000000.000001",
            content: "<@UBOT> deploy now",
            body: "deploy now",
            author: { id: "U1" },
            channel: { id: "C1" },
            thread: { ts: "1700000000.000001" },
            created_at: new Date(1_700_000_000_000).toISOString(),
            attachments: [],
          },
          trigger_thread_context: { messages: [] },
        },
      },
    });
    assert.deepEqual(match?.outputContext, {
      provider: "slack",
      organizationId: "org-1",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1700000000.000001",
      messageTs: "1700000000.000001",
    });
    assert.deepEqual(match?.allowOutputs, [{ type: "slack.reply", max: 1 }]);

    assert(match !== undefined);
    workspaceAvailable = false;
    const materialized = await provider.materializeLaunch?.({
      executionId: "execution-1",
      organizationId: "org-1",
      projectId: project.id,
      prompt: match.prompt,
      environmentEnv: match.environment.env,
      environmentWorktree: match.environment.worktree,
      triggerContext: structuredClone(match.triggerContext),
    });
    assert.deepEqual(materialized, {
      prompt: "Handle deploy now from U1 with secret-token",
      environmentEnv: { GITHUB_TOKEN: "secret-token" },
      environmentWorktree: {
        mode: "branch-off",
        newBranch: "slack-1700000000.000001-secret-token",
        base: "body-deploy now",
      },
    });
    assert.equal(integrationResolutions, 1);
    assert.equal(resolutionContext?.executionId, "execution-1");
    assert.deepEqual(botUserLookups, [["org-1", "T1"]]);
    await provider.onAgentExecutionStarted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionCompleted?.(match.triggerContext, match.outputContext, {
      status: "succeeded",
    });
    assert.deepEqual(client.reactions, [
      "org-1:T1:remove:eyes",
      "org-1:T1:add:hourglass_flowing_sand",
      "org-1:T1:remove:hourglass_flowing_sand",
      "org-1:T1:add:white_check_mark",
    ]);
  });

  it("preserves a root message as root while routing replies to its message thread", async () => {
    const { project, store } = await createActiveProjectConfiguration(
      createMemoryDatabase(),
      config(),
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });

    const [match] = await provider.match({
      organizationId: "org-1",
      projectId: project.id,
      source: "slack.mention",
      deliveryId: "slack-root",
      receivedAt: new Date(),
      payload: event({ threadTs: null }),
    });

    assert.ok(match);
    assert.equal(match.triggerContext.event.slack.trigger_message.thread, null);
    assert.equal(match.outputContext.threadTs, match.outputContext.messageTs);
    assert.equal(
      match.triggerContext.event.slack.trigger_message.created_at,
      "2023-11-14T22:13:20.000Z",
    );
  });

  it("hydrates only the preceding thread replies and leaves top-level mentions alone", async () => {
    const database = createMemoryDatabase();
    const { project, store } = await createActiveProjectConfiguration(database, config(), {
      organizationId: "org-1",
    });
    const client = new RecordingSlackClient({
      threadMessages: Array.from({ length: 50 }, (_, index) => ({
        ts: `1700000000.${String(index + 1).padStart(6, "0")}`,
        createdAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
        content: `reply-${index + 1}`,
        author: { id: index === 49 ? "B1" : `U${index + 1}` },
        attachments: [],
      })),
    });
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });

    const [threadMatch] = await provider.match({
      organizationId: "org-1",
      projectId: project.id,
      source: "slack.mention",
      deliveryId: "slack-thread",
      receivedAt: new Date(),
      payload: event(),
    });
    assert.equal(
      threadMatch?.triggerContext.event.slack.trigger_thread_context.messages.length,
      50,
    );
    assert.equal(
      threadMatch?.triggerContext.event.slack.trigger_thread_context.messages[0]?.content,
      "reply-1",
    );
    assert.equal(
      threadMatch?.triggerContext.event.slack.trigger_thread_context.messages.at(-1)?.author.id,
      "B1",
    );

    const [rootMatch] = await provider.match({
      organizationId: "org-1",
      projectId: project.id,
      source: "slack.mention",
      deliveryId: "slack-root-no-history",
      receivedAt: new Date(),
      payload: event({ threadTs: null }),
    });
    assert.equal(rootMatch?.triggerContext.event.slack.trigger_thread_context.messages.length, 0);
    assert.deepEqual(client.threadReads, ["1700000000.000001"]);
  });
});

function config() {
  return {
    environments: [
      {
        name: "work",
        kind: "daemon",
        daemon: "main",
        cwd: "/repo",
        worktree: {
          mode: "branch-off",
          newBranch:
            "slack-${{ paseo.event.slack.trigger_message.ts }}-${{ paseo.connections.getpaseo-github.token }}",
          base: "body-${{ paseo.event.slack.trigger_message.body }}",
        },
      },
    ],
    triggers: [
      {
        name: "slack-run",
        on: "slack.mention",
        environment: "work",
        filters: { workspace: "T1", channels: ["C1"], from_users: ["U1"] },
        agent: { provider: "test", mode: "full-access" },
        prompt:
          "Handle ${{ paseo.event.slack.trigger_message.body }} from ${{ paseo.event.slack.trigger_message.author.id }} with ${{ paseo.connections.getpaseo-github.token }}",
        env: { GITHUB_TOKEN: "${{ paseo.connections.getpaseo-github.token }}" },
        allow_outputs: [{ type: "slack.reply" }],
      },
    ],
  };
}

function event(overrides: { threadTs?: string | null } = {}) {
  return {
    type: "mention",
    id: "Ev1",
    teamId: "T1",
    appId: "A1",
    channelId: "C1",
    messageTs: "1700000000.000001",
    threadTs: overrides.threadTs === undefined ? "1700000000.000001" : overrides.threadTs,
    eventTs: "1700000000.000001",
    eventTime: 1_700_000_001,
    content: "<@UBOT> deploy now",
    author: { id: "U1" },
    createdAt: new Date(1_700_000_000_000).toISOString(),
    attachments: [],
    threadContextMessages: [],
  };
}

class RecordingSlackClient implements SlackBotClient {
  reactions: string[] = [];
  threadReads: string[] = [];
  private readonly threadMessages: SlackThreadMessage[];

  constructor(options: { threadMessages?: SlackThreadMessage[] } = {}) {
    this.threadMessages = options.threadMessages ?? [];
  }
  sendMessage(): Promise<void> {
    return Promise.resolve();
  }
  addReaction(input: { organizationId: string; teamId: string; name: string }): Promise<void> {
    this.reactions.push(`${input.organizationId}:${input.teamId}:add:${input.name}`);
    return Promise.resolve();
  }
  removeReaction(input: { organizationId: string; teamId: string; name: string }): Promise<void> {
    this.reactions.push(`${input.organizationId}:${input.teamId}:remove:${input.name}`);
    return Promise.resolve();
  }
  readThreadMessages(input: {
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    beforeTs: string;
  }): Promise<SlackThreadMessage[]> {
    this.threadReads.push(input.threadTs);
    return Promise.resolve(this.threadMessages);
  }
}
