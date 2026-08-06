import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import type { SlackBotClient, SlackThreadMessage } from "./client.js";
import { createSlackTriggerProvider } from "./provider.js";
import { isAcceptedTriggerProviderMatch } from "../index.js";

describe("Slack Phase 1 trigger provider", () => {
  it("normalizes typed inputs identically at the provider boundary", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      inputConfiguration(),
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });

    const match = (
      await provider.match(
        external(project.id, revision.id, { content: "<@UBOT> repo=hub agent=opus investigate" }),
      )
    )[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.deepEqual(match.invocation, {
      status: "accepted",
      rawMessage: "<@UBOT> repo=hub agent=opus investigate",
      prompt: "investigate",
      inputs: { repo: "hub", agent: "opus" },
    });
  });

  it("parses typed inputs after a matched command marker", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      inputMarkerConfiguration(),
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });

    const match = (
      await provider.match(
        external(project.id, revision.id, { content: "<@UBOT> run repo=hub investigate" }),
      )
    )[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.invocation.prompt, "investigate");
    assert.equal(match.invocation.inputs["repo"], "hub");
  });

  it("uses exact input filters to select one configured trigger", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      inputFilterFanoutConfiguration(),
      { organizationId: "org-1" },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });

    const matches = await provider.match(
      external(project.id, revision.id, { content: "<@UBOT> repo=hub investigate" }),
    );

    assert.deepEqual(
      matches.map((match) => match.triggerName),
      ["hub-only"],
    );
  });

  it("matches the literal step and preserves the message reply target", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const match = (await provider.match(external(project.id, revision.id)))[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.configurationRevisionId, revision.id);
    assert.equal(match.outputContext.threadTs, "1700000000.000001");
    assert.equal(match.outputContext.messageTs, "1700000000.000001");
  });

  it("keeps provider reactions idempotent across the durable lifecycle hooks", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      {
        organizationId: "org-1",
      },
    );
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
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

  it("keeps a root Slack mention as the reply thread root", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      {
        organizationId: "org-1",
      },
    );
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: new RecordingSlackClient(),
    });
    const match = (await provider.match(external(project.id, revision.id, { threadTs: null })))[0];

    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");
    assert.equal(match.triggerContext.event.slack.trigger_message.thread, null);
    assert.equal(match.outputContext.threadTs, match.outputContext.messageTs);
    assert.equal(
      match.triggerContext.event.slack.trigger_message.created_at,
      "2023-11-14T22:13:20.000Z",
    );
  });

  it("targets Slack failure output at the originating message thread", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      {
        organizationId: "org-1",
      },
    );
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const match = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    await provider.onAgentExecutionFailed?.(match.triggerContext, match.outputContext, "boom");
    assert.deepEqual(client.messages, [
      {
        organizationId: "org-1",
        teamId: "T1",
        channelId: "C1",
        threadTs: "1700000000.000001",
        content: "Paseo agent failed: boom",
      },
    ]);
  });

  it("propagates terminal Slack reaction and notice failures", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      { organizationId: "org-1" },
    );
    const reactionFailure = new RecordingSlackClient({ failAddReaction: "white_check_mark" });
    const reactionProvider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: reactionFailure,
    });
    const match = (await reactionProvider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(match)) throw new Error("expected accepted match");

    await assert.rejects(async () => {
      await reactionProvider.onAgentExecutionCompleted!(match.triggerContext, match.outputContext, {
        status: "succeeded",
      });
    }, /slack add reaction failed/u);
    assert.deepEqual(reactionFailure.reactions, [
      "org-1:T1:remove:hourglass_flowing_sand",
      "org-1:T1:add:white_check_mark",
    ]);

    const noticeFailure = new RecordingSlackClient({ failMessages: true });
    const noticeProvider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client: noticeFailure,
    });
    await assert.rejects(async () => {
      await noticeProvider.onAgentExecutionFailed!(
        match.triggerContext,
        match.outputContext,
        "boom",
      );
    }, /slack message failed/u);
    assert.deepEqual(noticeFailure.reactions, [
      "org-1:T1:remove:eyes",
      "org-1:T1:remove:hourglass_flowing_sand",
      "org-1:T1:add:x",
    ]);
  });

  it("hydrates only routed thread replies and leaves top-level mentions alone", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      {
        organizationId: "org-1",
      },
    );
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

    const threadMatch = (await provider.match(external(project.id, revision.id)))[0];
    if (!isAcceptedTriggerProviderMatch(threadMatch)) throw new Error("expected accepted match");
    assert.equal(threadMatch.triggerContext.event.slack.trigger_thread_context.messages.length, 50);
    assert.equal(
      threadMatch.triggerContext.event.slack.trigger_thread_context.messages[0]?.content,
      "reply-1",
    );
    assert.equal(
      threadMatch.triggerContext.event.slack.trigger_thread_context.messages.at(-1)?.author.id,
      "B1",
    );

    const rootMatch = (
      await provider.match(external(project.id, revision.id, { threadTs: null }))
    )[0];
    if (!isAcceptedTriggerProviderMatch(rootMatch)) throw new Error("expected accepted match");
    assert.equal(rootMatch.triggerContext.event.slack.trigger_thread_context.messages.length, 0);
    assert.deepEqual(client.threadReads, ["1700000000.000001"]);
  });

  it("does not hydrate an unrouted Slack thread", async () => {
    const database = createMemoryDatabase();
    const { project, revision, store } = await createActiveProjectConfiguration(
      database,
      configuration(),
      {
        organizationId: "org-1",
      },
    );
    const client = new RecordingSlackClient();
    const provider = createSlackTriggerProvider({
      configurationStoreForProject: () => store,
      botUserIdForWorkspace: () => Promise.resolve("UBOT"),
      client,
    });
    const matches = await provider.match(external(project.id, revision.id, { authorId: "U2" }));
    assert.deepEqual(matches, []);
    assert.deepEqual(client.threadReads, []);
  });
});

function configuration() {
  return {
    environments: [{ name: "slack-runner", kind: "daemon", daemon: "main", cwd: "/repo" }],
    triggers: [
      {
        name: "slack-run",
        on: "slack.mention",
        max_runtime: "2h",
        filters: { workspace: "T1", channels: ["C1"], from_users: ["U1"] },
        steps: [
          {
            id: "slack-step",
            environment: "slack-runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "test", mode: "full-access" },
            prompt: [{ text: "Handle the Slack mention." }],
            allow_outputs: [{ type: "slack.reply" }],
          },
        ],
      },
    ],
  };
}

function inputConfiguration() {
  const base = configuration();
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
            agent: { provider: "${{ paseo.inputs.agent }}", mode: "full-access" },
            prompt: [{ text: "Request: ${{ paseo.prompt }}" }],
          },
        ],
      },
    ],
  };
}

function inputFilterFanoutConfiguration() {
  const base = inputConfiguration();
  const first = base.triggers[0]!;
  return {
    ...base,
    triggers: [
      { ...first, name: "hub-only" },
      { ...first, name: "paseo-only", filters: { ...first.filters, inputs: { repo: "paseo" } } },
    ],
  };
}

function inputMarkerConfiguration() {
  const base = inputConfiguration();
  const trigger = base.triggers[0]!;
  return {
    ...base,
    triggers: [
      {
        ...trigger,
        filters: { ...trigger.filters, pattern: "run" },
      },
    ],
  };
}

function external(
  projectId: string,
  configurationRevisionId: string,
  overrides: { threadTs?: string | null; content?: string; authorId?: string } = {},
) {
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
    organizationId: "org-1",
    projectId,
    configurationRevisionId,
    source: "slack.mention",
    deliveryId: "slack-delivery-1",
    receivedAt: new Date(),
    payload: {
      type: "mention",
      id: "Ev1",
      teamId: "T1",
      appId: "A1",
      channelId: "C1",
      messageTs: "1700000000.000001",
      threadTs: overrides.threadTs === undefined ? "1700000000.000001" : overrides.threadTs,
      eventTs: "1700000000.000001",
      eventTime: 1_700_000_001,
      content: overrides.content ?? "<@UBOT> deploy now",
      author: { id: overrides.authorId ?? "U1" },
      createdAt: new Date(1_700_000_000_000).toISOString(),
      attachments: [],
      threadContextMessages: [],
    },
  };
}

class RecordingSlackClient implements SlackBotClient {
  reactions: string[] = [];
  messages: Array<{
    organizationId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    content: string;
  }> = [];
  threadReads: string[] = [];
  private readonly threadMessages: SlackThreadMessage[];

  constructor(
    private readonly options: {
      threadMessages?: SlackThreadMessage[];
      failAddReaction?: string;
      failMessages?: boolean;
    } = {},
  ) {
    this.threadMessages = options.threadMessages ?? [];
  }

  sendMessage(input: (typeof this.messages)[number]): Promise<void> {
    this.messages.push(input);
    if (this.options.failMessages === true)
      return Promise.reject(new Error("slack message failed"));
    return Promise.resolve();
  }

  addReaction(input: { organizationId: string; teamId: string; name: string }): Promise<void> {
    this.reactions.push(`${input.organizationId}:${input.teamId}:add:${input.name}`);
    if (this.options.failAddReaction === input.name)
      return Promise.reject(new Error("slack add reaction failed"));
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
