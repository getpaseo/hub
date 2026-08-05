import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { MemoryDiscordBotClient } from "./memory-bot.js";
import { createDiscordTriggerProvider } from "./provider.js";
import type { NormalizedDiscordMessageEvent } from "./events.js";

describe("Discord Phase 1 trigger provider", () => {
  it("normalizes typed inputs identically at the provider boundary", async () => {
    const { project, store } = await activeConfiguration(inputConfiguration());
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const match = (
      await provider.match(
        external(project.id, event({ content: "<@900> repo=hub agent=opus investigate" })),
      )
    )[0];

    assert.ok(match);
    assert.deepEqual(match.invocation, {
      status: "accepted",
      rawMessage: "<@900> repo=hub agent=opus investigate",
      prompt: "investigate",
      inputs: { repo: "hub", agent: "opus" },
    });
  });

  it("matches a literal one-step prompt and keeps the mention allowlist fail-closed", async () => {
    const { project, revision, store } = await activeConfiguration();
    const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot,
    });
    const match = (await provider.match(external(project.id, event())))[0];

    assert.ok(match);
    assert.equal(match.stepId, "discord-step");
    assert.equal(match.prompt, "Respond to the Discord mention.");
    assert.equal(match.configurationRevisionId, revision.id);
    assert.deepEqual(match.allowOutputs, [{ type: "discord.reply", max: 1 }]);
    assert.deepEqual(await provider.match(external(project.id, event({ authorId: "401" }))), []);
  });

  it("preserves reply lifecycle actions and auto-archive in the provider match", async () => {
    const { project, store } = await activeConfiguration();
    const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot,
    });
    const match = (await provider.match(external(project.id, event())))[0];
    assert.ok(match);
    assert.equal(match.autoArchive, true);

    await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionStarted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionCompleted?.(match.triggerContext, match.outputContext, {
      status: "succeeded",
    });
    assert.deepEqual(
      bot.reactions.map((reaction) => reaction.emoji),
      ["👀", "⏳", "✅"],
    );
  });

  it("routes a durable Discord receipt to the configured connection", async () => {
    const database = createMemoryDatabase();
    const connection = {
      id: "22222222-2222-4222-8222-222222222222",
      organizationId: "org_1",
      slug: "secondary",
      guildId: "100",
      guildName: "Secondary",
    };
    database.organizationConnectionUsage = () =>
      Promise.resolve({ github: [], slack: [], discord: [connection] });
    database.findDiscordConnectionForOrganization = () => Promise.resolve(connection);
    const { project, store } = await createActiveProjectConfiguration(
      database,
      discordConnectionConfiguration(),
    );
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match({
      ...external(project.id, event()),
      connectionId: "22222222-2222-4222-8222-222222222222",
    });
    assert.deepEqual(
      matches.map((match) => match.triggerName),
      ["secondary-connection"],
    );
  });

  it("preserves Discord attachments, references, and thread context as durable evidence", async () => {
    const { project, store } = await activeConfiguration();
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });
    const attachment = {
      id: "701",
      filename: "design.png",
      url: "https://cdn.discordapp.com/attachments/200/701/design.png",
      contentType: "image/png",
      size: 42,
    };
    const match = (
      await provider.match(
        external(
          project.id,
          event({
            channelId: "207",
            threadId: "207",
            parentChannelId: "200",
            attachments: [attachment],
            referencedMessage: { id: "298", channelId: "200", guildId: "100" },
            threadContextMessages: [
              {
                id: "299",
                channelId: "207",
                content: "see image",
                author: { id: "401", username: "maintainer", bot: false },
                createdAt: "2026-05-18T23:59:00.000Z",
                attachments: [attachment],
                referencedMessage: null,
              },
            ],
          }),
        ),
      )
    )[0];

    assert.ok(match);
    assert.deepEqual(match.triggerContext.event.discord.trigger_message.attachments[0], {
      id: "701",
      filename: "design.png",
      url: attachment.url,
      content_type: "image/png",
      size: 42,
    });
    assert.deepEqual(match.triggerContext.event.discord.trigger_message.referenced_message, {
      id: "298",
      channel_id: "200",
      guild_id: "100",
    });
    assert.equal(
      match.triggerContext.event.discord.trigger_thread_context.messages[0]?.content,
      "see image",
    );
    assert.equal(
      match.triggerContext.event.discord.trigger_thread_context.messages[0]?.attachments[0]?.url,
      attachment.url,
    );
    assert.deepEqual(match.outputContext, {
      provider: "discord",
      guildId: "100",
      channelId: "207",
      threadId: "207",
      messageId: "300",
    });
  });

  it("persists a static Discord worktree target across launch recovery", async () => {
    const { project, store } = await activeConfiguration(discordWorktreeConfiguration());
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });
    const match = (await provider.match(external(project.id, event())))[0];
    assert.ok(match);
    assert.deepEqual(match.environment.worktree, {
      mode: "branch-off",
      newBranch: "discord-recovery",
      base: "main",
    });
    const materialized = await provider.materializeLaunch?.({
      executionId: "discord-worktree-recovery",
      organizationId: "org_1",
      projectId: project.id,
      prompt: match.prompt,
      environmentWorktree: match.environment.worktree,
      triggerContext: match.triggerContext,
    });
    assert.deepEqual(materialized?.environmentWorktree, match.environment.worktree);
  });

  it("targets lifecycle reactions and termination notices at the original Discord message", async () => {
    const { project, store } = await activeConfiguration();
    const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot,
    });
    const match = (await provider.match(external(project.id, event({ threadId: "207" }))))[0];
    assert.ok(match);

    await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionStarted?.(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionFailed?.(match.triggerContext, match.outputContext, "boom");
    await provider.onMachineTerminated?.(match.triggerContext, "launch_failed");
    await provider.onMachineTerminated?.(match.triggerContext, "completed");

    assert.deepEqual(
      bot.reactions.map((reaction) => reaction.emoji),
      ["👀", "⏳", "❌", "❌"],
    );
    assert.deepEqual(
      bot.deletedOwnReactions.map((reaction) => reaction.emoji),
      ["👀", "👀", "⏳", "👀", "⏳"],
    );
    assert.deepEqual(
      bot.messages.map((message) => ({
        channelId: message.channelId,
        threadId: message.threadId,
        content: message.content,
      })),
      [
        {
          channelId: "200",
          threadId: "207",
          content: "Paseo agent failed: boom",
        },
        {
          channelId: "200",
          threadId: "207",
          content: "Paseo machine terminated before the agent could complete: launch_failed",
        },
      ],
    );
  });
});

async function activeConfiguration(rawConfiguration = discordConfiguration()) {
  return createActiveProjectConfiguration(createMemoryDatabase(), rawConfiguration);
}

function discordConfiguration() {
  return {
    environments: [
      {
        name: "discord-runner",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/repo",
      },
    ],
    triggers: [
      {
        name: "discord-mention",
        on: "discord.mention",
        max_runtime: "2h",
        filters: { guild: "100", contains: "ping", from_users: ["400"] },
        steps: [
          {
            id: "discord-step",
            environment: "discord-runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "claude/opus", mode: "bypassPermissions" },
            prompt: [{ text: "Respond to the Discord mention." }],
            allow_outputs: [{ type: "discord.reply" }],
            auto_archive: true,
          },
        ],
      },
    ],
  };
}

function inputConfiguration() {
  const base = discordConfiguration();
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
        filters: {
          guild: "100",
          contains: "repo=hub",
          from_users: ["400"],
          inputs: { repo: "hub" },
        },
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

function discordWorktreeConfiguration() {
  const configuration = discordConfiguration();
  return {
    ...configuration,
    environments: [
      {
        ...configuration.environments[0]!,
        worktree: { mode: "branch-off" as const, newBranch: "discord-recovery", base: "main" },
      },
    ],
  };
}

function discordConnectionConfiguration() {
  const base = discordConfiguration();
  return {
    ...base,
    triggers: [
      {
        ...base.triggers[0]!,
        name: "secondary-connection",
        filters: {
          guild: "100",
          from_users: ["400"],
          connection: "secondary",
        },
      },
    ],
  };
}

function external(projectId: string, payload: NormalizedDiscordMessageEvent) {
  return {
    organizationId: "org_1",
    projectId,
    source: "discord.mention",
    deliveryId: payload.id,
    receivedAt: new Date(),
    payload,
  };
}

function event(
  overrides: {
    authorId?: string;
    content?: string;
    channelId?: string;
    threadId?: string | null;
    parentChannelId?: string | null;
    messageId?: string;
    attachments?: NormalizedDiscordMessageEvent["attachments"];
    referencedMessage?: NormalizedDiscordMessageEvent["referencedMessage"];
    threadContextMessages?: NormalizedDiscordMessageEvent["threadContextMessages"];
  } = {},
): NormalizedDiscordMessageEvent {
  return {
    type: "mention",
    id: "300",
    guildId: "100",
    channelId: overrides.channelId ?? "200",
    threadId: overrides.threadId ?? null,
    parentChannelId: overrides.parentChannelId ?? null,
    messageId: overrides.messageId ?? "300",
    content: overrides.content ?? "<@900> ping",
    mentionedUserIds: ["900"],
    author: { id: overrides.authorId ?? "400", username: "tester", bot: false },
    createdAt: "2026-05-19T00:00:00.000Z",
    attachments: overrides.attachments ?? [],
    referencedMessage: overrides.referencedMessage ?? null,
    threadContextMessages: overrides.threadContextMessages ?? [],
  };
}
