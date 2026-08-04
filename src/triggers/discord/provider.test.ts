import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { buildLaunchMachineIntent } from "../../dispatcher/launch-machine-intent.js";
import type { TriggerProviderMatch } from "../index.js";
import type { NormalizedDiscordMessageEvent } from "./events.js";
import { MemoryDiscordBotClient } from "./memory-bot.js";
import {
  createDiscordTriggerProvider,
  type DiscordOutputContext,
  type DiscordTriggerContext,
} from "./provider.js";

describe("Discord trigger provider", () => {
  it("matches without side effects and acknowledges only after dispatch acceptance", async () => {
    const {
      project,
      revision: version,
      store,
    } = await activeConfiguration(createConfig({ autoArchive: true }));
    const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot,
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-1",
      receivedAt: new Date(),
      payload: createEvent(),
    });
    assert.equal(bot.reactions.length, 0);
    const match = matches[0];
    assert.ok(match);
    await provider.onDispatchAccepted?.(match.triggerContext, match.outputContext);

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.configurationRevisionId, version.id);
    assert.equal(matches[0]?.environment.kind, "daemon");
    assert.equal(matches[0]?.environment.authoredSlug, "mob-hetzner");
    assert.equal(matches[0]?.autoArchive, true);
    assert.deepEqual(
      bot.reactions.map((reaction) => ({
        channelId: reaction.channelId,
        messageId: reaction.messageId,
        emoji: reaction.emoji,
      })),
      [{ channelId: "200", messageId: "300", emoji: "👀" }],
    );
  });

  it("dispatches only the trigger compiled for the durable incoming connection", async () => {
    const { project, store } = await activeConfiguration(createConfigWithConnectionFilters());
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match(
      Object.assign(
        {
          organizationId: "org_1",
          projectId: project.id,
          source: "discord.mention",
          deliveryId: "delivery-connection-filter",
          receivedAt: new Date(),
          payload: createEvent(),
        },
        { connectionId: "22222222-2222-4222-8222-222222222222" },
      ),
    );

    assert.deepEqual(
      matches.map((match) => match.triggerName),
      ["secondary-connection"],
    );
  });

  it("interpolates rich Discord trigger-message fields", async () => {
    const { project, store } = await activeConfiguration(createConfig());
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-2",
      receivedAt: new Date(),
      payload: createEvent({ content: "<@900> ping deploy please" }),
    });

    const match = matches[0];
    assert.ok(match);
    assert.equal(
      (await materialize(provider, match, project.id)).prompt,
      "respond from tester: ping deploy please",
    );
  });

  it("interpolates typed Discord thread context messages", async () => {
    const { project, store } = await activeConfiguration(
      createConfig({
        prompt:
          "context: ${{ paseo.event.discord.trigger_thread_context.messages.0.author.username }} said ${{ paseo.event.discord.trigger_thread_context.messages.0.content }}",
      }),
    );
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-thread-context",
      receivedAt: new Date(),
      payload: createEvent({
        channelId: "207",
        threadId: "207",
        parentChannelId: "200",
        threadContextMessages: [
          {
            id: "299",
            channelId: "207",
            content: "ship the release",
            author: { id: "401", username: "maintainer", bot: false },
            createdAt: "2026-05-18T23:59:00.000Z",
            attachments: [],
            referencedMessage: null,
          },
        ],
      }),
    });

    const match = matches[0];
    assert.ok(match);
    assert.equal(
      (await materialize(provider, match, project.id)).prompt,
      "context: maintainer said ship the release",
    );
  });

  it("preserves Discord attachments and referenced-message identity", async () => {
    const { project, store } = await activeConfiguration(
      createConfig({
        prompt:
          "trigger=${{ paseo.event.discord.trigger_message.attachments.0.filename }} reply=${{ paseo.event.discord.trigger_message.referenced_message.id }} context=${{ paseo.event.discord.trigger_thread_context.messages.0.attachments.0.url }}",
      }),
    );
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
    const [match] = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-discord-media",
      receivedAt: new Date(),
      payload: createEvent({
        attachments: [attachment],
        referencedMessage: { id: "298", channelId: "200", guildId: "100" },
        threadContextMessages: [
          {
            id: "299",
            channelId: "200",
            content: "see image",
            author: { id: "401", username: "maintainer", bot: false },
            createdAt: "2026-05-18T23:59:00.000Z",
            attachments: [attachment],
            referencedMessage: null,
          },
        ],
      }),
    });

    assert.ok(match);
    assert.equal(
      (await materialize(provider, match, project.id)).prompt,
      `trigger=design.png reply=298 context=${attachment.url}`,
    );
  });

  it("keeps integration secrets out of durable dispatch and resolves them at launch", async () => {
    const {
      project,
      revision: version,
      store,
    } = await activeConfiguration(createConfigWithIntegrationTemplates());
    const calls: Array<{ organizationId: string; value: string }> = [];
    let executionId: string | undefined;
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      connectionsForProject: (projectId) => (_slug, value, context) => {
        executionId = context?.executionId;
        calls.push({ organizationId: projectId, value });
        return Promise.resolve("ghs_org_token");
      },
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-github-identity",
      receivedAt: new Date(),
      payload: createEvent(),
    });

    const match = matches[0];
    assert.ok(match);
    const intent = buildLaunchMachineIntent({
      ...match,
      organizationId: "org_1",
      projectId: project.id,
      triggerId: "trigger-discord-secret",
      configurationRevisionId: version.id,
    });

    assert.deepEqual(
      {
        prompt: intent.prompt,
        env: intent.environment.env,
        worktree: intent.environment.worktree,
      },
      {
        prompt:
          "secret ${{ paseo.connections.getpaseo-github.token }} for ${{ paseo.event.discord.trigger_message.body }}",
        env: { GH_TOKEN: "${{ paseo.connections.getpaseo-github.token }}" },
        worktree: {
          mode: "branch-off",
          newBranch: "discord-${{ paseo.connections.getpaseo-github.token }}",
          base: "body-${{ paseo.event.discord.trigger_message.body }}",
        },
      },
    );
    assert.equal(JSON.stringify(intent).includes("ghs_org_token"), false);
    assert.deepEqual(calls, []);
    assert.deepEqual(await materialize(provider, match, project.id), {
      prompt: "secret ghs_org_token for ping",
      environmentEnv: { GH_TOKEN: "ghs_org_token" },
      environmentWorktree: {
        mode: "branch-off",
        newBranch: "discord-ghs_org_token",
        base: "body-ping",
      },
    });
    assert.deepEqual(calls, [{ organizationId: project.id, value: "token" }]);
    assert.equal(executionId, "execution-discord-materialize");
  });

  it("uses only the explicitly named organization GitHub connection", async () => {
    const database = createMemoryDatabase();
    const { project, store } = await createActiveProjectConfiguration(
      database,
      createConfigWithIntegrationTemplates("github-primary"),
      { organizationId: "org-1" },
    );
    const installations = [
      { slug: "github-primary", installationId: 142 },
      { slug: "github-secondary", installationId: 284 },
    ];
    const used: number[] = [];
    const resolveConnection = async (slug: string, value: string) => {
      assert.equal(value, "token");
      const connection = installations.find((candidate) => candidate.slug === slug);
      if (connection === undefined) throw new Error(`connection slug is unavailable: ${slug}`);
      used.push(connection.installationId);
      return `github-token-${connection.installationId}`;
    };
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      connectionsForProject: () => resolveConnection,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });
    const [match] = await provider.match({
      organizationId: "org-1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-explicit-github-connection",
      receivedAt: new Date(),
      payload: createEvent(),
    });
    assert.ok(match);

    assert.deepEqual((await materialize(provider, match, project.id)).environmentEnv, {
      GH_TOKEN: "github-token-142",
    });
    assert.deepEqual(used, [142]);
    await assert.rejects(
      () => resolveConnection("github-missing", "token"),
      /connection slug is unavailable/u,
    );
    await assert.rejects(
      () => resolveConnection("org-2-github", "token"),
      /connection slug is unavailable/u,
    );
  });

  it("exposes typed Discord message identity in the interpolation context", async () => {
    const {
      project,
      revision: _version,
      store,
    } = await activeConfiguration(
      createConfig({
        prompt:
          "respond to ${{ paseo.event.discord.trigger_message.id }} in ${{ paseo.event.discord.trigger_message.channel.id }}",
      }),
    );
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-id",
      receivedAt: new Date(),
      payload: createEvent({ messageId: "323" }),
    });

    const match = matches[0];
    assert.ok(match);
    assert.equal((await materialize(provider, match, project.id)).prompt, "respond to 323 in 200");
  });

  it("exposes the typed Discord trigger-message URL", async () => {
    const {
      project,
      revision: _version,
      store,
    } = await activeConfiguration(
      createConfig({
        prompt: "inspect ${{ paseo.event.discord.trigger_message.url }}",
      }),
    );
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-url",
      receivedAt: new Date(),
      payload: createEvent({ messageId: "323" }),
    });

    const match = matches[0];
    assert.ok(match);
    assert.equal(
      (await materialize(provider, match, project.id)).prompt,
      "inspect https://discord.com/channels/100/200/323",
    );
  });

  it("interpolates typed Discord fields in trigger env values", async () => {
    const {
      project,
      revision: _version,
      store,
    } = await activeConfiguration(
      createConfig({
        env: {
          DISCORD_EVENT_ID: "${{ paseo.event.discord.trigger_message.id }}",
        },
      }),
    );
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-env-id",
      receivedAt: new Date(),
      payload: createEvent({ messageId: "324" }),
    });

    const match = matches[0];
    assert.ok(match);
    assert.deepEqual(match.environment, {
      kind: "daemon",
      daemonId: "daemon-mob-hetzner",
      authoredSlug: "mob-hetzner",
      cwd: "/home/moboudra/dev/faro",
      env: {
        DISCORD_EVENT_ID: "${{ paseo.event.discord.trigger_message.id }}",
      },
    });
    assert.deepEqual((await materialize(provider, match, project.id)).environmentEnv, {
      DISCORD_EVENT_ID: "324",
    });
  });

  it("passes daemon worktree targets through matched trigger environments", async () => {
    const {
      project,
      revision: _version,
      store,
    } = await activeConfiguration(createConfigWithWorktree());
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
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
        newBranch: "trigger-${{ paseo.event.discord.trigger_message.id }}",
        base: "main",
      },
    });
    const match = matches[0];
    assert.ok(match);
    assert.deepEqual((await materialize(provider, match, project.id)).environmentWorktree, {
      mode: "branch-off",
      newBranch: "trigger-300",
      base: "main",
    });
  });

  it("emits a DiscordOutputContext with guild, channel, thread, and message IDs", async () => {
    const { project, store } = await activeConfiguration(createConfig());
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-3",
      receivedAt: new Date(),
      payload: createEvent({ threadId: "207", parentChannelId: "200" }),
    });

    assert.deepEqual(matches[0]?.outputContext, {
      provider: "discord",
      guildId: "100",
      channelId: "200",
      threadId: "207",
      messageId: "300",
    });
  });

  it("does not inject Discord provider context into daemon env", async () => {
    const { project, store } = await activeConfiguration(createConfig());
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-agent-env",
      receivedAt: new Date(),
      payload: createEvent({
        channelId: "207",
        threadId: "207",
        parentChannelId: "200",
        messageId: "323",
      }),
    });

    assert.equal("agentEnv" in Object(matches[0]), false);
  });

  it("returns no matches when no HubConfig indexes the message's guild", async () => {
    const { project, store } = await activeConfiguration(emptyConfiguration());
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-4",
      receivedAt: new Date(),
      payload: createEvent(),
    });

    assert.equal(matches.length, 0);
  });

  it("matches guildless discord triggers from any guild", async () => {
    const {
      project,
      revision: version,
      store,
    } = await activeConfiguration(createConfigWithoutGuild());
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot: new MemoryDiscordBotClient({ selfUserId: "900" }),
    });

    const matches = await provider.match({
      organizationId: "org_1",
      projectId: project.id,
      source: "discord.mention",
      deliveryId: "delivery-5",
      receivedAt: new Date(),
      payload: createEvent({ guildId: "101" }),
    });

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.configurationRevisionId, version.id);
  });

  it("posts spawn-status lifecycle reactions against the original message", async () => {
    const { store } = await activeConfiguration(emptyConfiguration());
    const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot,
    });
    const event = createEvent();
    const triggerContext = createTriggerContext(event);
    const outputContext: DiscordOutputContext = {
      provider: "discord",
      guildId: event.guildId,
      channelId: event.channelId,
      threadId: event.threadId,
      messageId: event.messageId,
    };

    await provider.onAgentExecutionStarted?.(triggerContext, outputContext);
    await provider.onAgentExecutionCompleted?.(triggerContext, outputContext, {
      status: "succeeded",
    });
    await provider.onAgentExecutionFailed?.(triggerContext, outputContext, "boom");

    assert.deepEqual(
      bot.deletedOwnReactions.map((reaction) => reaction.emoji),
      ["👀", "⏳", "👀", "⏳"],
    );
    assert.deepEqual(
      bot.reactions.map((reaction) => reaction.emoji),
      ["⏳", "✅", "❌"],
    );
    assert.deepEqual(
      bot.messages.map((message) => message.content),
      ["Paseo agent failed: boom"],
    );
  });

  it("posts an explanatory thread message when the machine terminates before completion", async () => {
    const { store } = await activeConfiguration(emptyConfiguration());
    const bot = new MemoryDiscordBotClient({ selfUserId: "900" });
    const provider = createDiscordTriggerProvider({
      configurationStoreForProject: () => store,
      bot,
    });
    const event = createEvent();
    const triggerContext = createTriggerContext(event);

    await provider.onMachineTerminated?.(triggerContext, "launch_failed");
    await provider.onMachineTerminated?.(triggerContext, "completed");

    assert.deepEqual(
      bot.deletedOwnReactions.map((reaction) => reaction.emoji),
      ["👀", "⏳"],
    );
    assert.deepEqual(
      bot.reactions.map((reaction) => reaction.emoji),
      ["❌"],
    );
    assert.equal(bot.messages.length, 1);
    assert.match(bot.messages[0]?.content ?? "", /launch_failed/u);
  });
});

function createConfig(
  overrides: {
    prompt?: string;
    env?: Record<string, string>;
    autoArchive?: boolean;
  } = {},
): unknown {
  return {
    environments: [
      {
        name: "hetzner",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/home/moboudra/dev/faro",
      },
    ],
    triggers: [
      {
        name: "discord-mention",
        on: "discord.mention",
        environment: "hetzner",
        filters: {
          guild: "100",
          contains: "ping",
          from_users: ["400"],
        },
        env: overrides.env ?? {},
        agent: { provider: "claude/opus", mode: "bypassPermissions" },
        prompt:
          overrides.prompt ??
          "respond from ${{ paseo.event.discord.trigger_message.author.username }}: ${{ paseo.event.discord.trigger_message.body }}",
        auto_archive: overrides.autoArchive ?? false,
      },
    ],
  };
}

function createConfigWithConnectionFilters(): unknown {
  const environment = {
    name: "hetzner",
    kind: "daemon",
    daemon: "mob-hetzner",
    cwd: "/home/moboudra/dev/faro",
  };
  const agent = { provider: "claude/opus", mode: "bypassPermissions" };
  return {
    environments: [environment],
    triggers: [
      {
        name: "primary-connection",
        on: "discord.mention",
        environment: "hetzner",
        filters: {
          guild: "100",
          from_users: ["400"],
          connectionId: "11111111-1111-4111-8111-111111111111",
        },
        agent,
        prompt: "primary",
      },
      {
        name: "secondary-connection",
        on: "discord.mention",
        environment: "hetzner",
        filters: {
          guild: "100",
          from_users: ["400"],
          connectionId: "22222222-2222-4222-8222-222222222222",
        },
        agent,
        prompt: "secondary",
      },
    ],
  };
}

function createConfigWithoutGuild(): unknown {
  return {
    environments: [
      {
        name: "hetzner",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/home/moboudra/dev/faro",
      },
    ],
    triggers: [
      {
        name: "discord-mention",
        on: "discord.mention",
        environment: "hetzner",
        filters: {
          contains: "ping",
          from_users: ["400"],
        },
        agent: { provider: "claude/opus", mode: "bypassPermissions" },
        prompt:
          "respond from ${{ paseo.event.discord.trigger_message.author.username }}: ${{ paseo.event.discord.trigger_message.body }}",
      },
    ],
  };
}

function createConfigWithIntegrationTemplates(connectionSlug = "getpaseo-github"): unknown {
  const token = `\${{ paseo.connections.${connectionSlug}.token }}`;
  return {
    environments: [
      {
        name: "hetzner",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/home/moboudra/dev/faro",
        worktree: {
          mode: "branch-off",
          newBranch: `discord-${token}`,
          base: "body-${{ paseo.event.discord.trigger_message.body }}",
        },
      },
    ],
    triggers: [
      {
        name: "discord-mention",
        on: "discord.mention",
        environment: "hetzner",
        filters: { guild: "100", contains: "ping", from_users: ["400"] },
        env: { GH_TOKEN: token },
        agent: { provider: "claude/opus", mode: "bypassPermissions" },
        prompt: `secret ${token} for \${{ paseo.event.discord.trigger_message.body }}`,
      },
    ],
  };
}

function createConfigWithWorktree(): unknown {
  return {
    environments: [
      {
        name: "hetzner",
        kind: "daemon",
        daemon: "mob-hetzner",
        cwd: "/home/moboudra/dev/faro",
        worktree: {
          mode: "branch-off",
          newBranch: "trigger-${{ paseo.event.discord.trigger_message.id }}",
          base: "main",
        },
      },
    ],
    triggers: [
      {
        name: "discord-mention",
        on: "discord.mention",
        environment: "hetzner",
        filters: {
          guild: "100",
          contains: "ping",
          from_users: ["400"],
        },
        agent: { provider: "claude/opus", mode: "bypassPermissions" },
        prompt:
          "respond from ${{ paseo.event.discord.trigger_message.author.username }}: ${{ paseo.event.discord.trigger_message.body }}",
      },
    ],
  };
}

function createEvent(
  overrides: {
    content?: string;
    guildId?: string;
    channelId?: string;
    messageId?: string;
    threadId?: string | null;
    parentChannelId?: string | null;
    attachments?: NormalizedDiscordMessageEvent["attachments"];
    referencedMessage?: NormalizedDiscordMessageEvent["referencedMessage"];
    threadContextMessages?: NormalizedDiscordMessageEvent["threadContextMessages"];
  } = {},
): NormalizedDiscordMessageEvent {
  return {
    type: "mention",
    id: overrides.messageId ?? "300",
    guildId: overrides.guildId ?? "100",
    channelId: overrides.channelId ?? "200",
    threadId: overrides.threadId ?? null,
    parentChannelId: overrides.parentChannelId ?? null,
    messageId: overrides.messageId ?? "300",
    content: overrides.content ?? "<@900> ping",
    mentionedUserIds: ["900"],
    author: { id: "400", username: "tester", bot: false },
    createdAt: "2026-05-19T00:00:00.000Z",
    attachments: overrides.attachments ?? [],
    referencedMessage: overrides.referencedMessage ?? null,
    threadContextMessages: overrides.threadContextMessages ?? [],
  };
}

function createTriggerContext(source: NormalizedDiscordMessageEvent): DiscordTriggerContext {
  return {
    provider: "discord",
    target: {
      provider: "discord",
      guildId: source.guildId,
      channelId: source.channelId,
      threadId: source.threadId,
      messageId: source.messageId,
    },
    event: {
      discord: {
        event_type: "mention",
        guild: { id: source.guildId },
        trigger_message: {
          id: source.id,
          content: source.content,
          body: source.content,
          url: `https://discord.com/channels/${source.guildId}/${source.channelId}/${source.id}`,
          author: {
            id: source.author.id,
            username: source.author.username,
            ...(source.author.bot === undefined ? {} : { bot: source.author.bot }),
          },
          channel: { id: source.channelId },
          thread: null,
          created_at: source.createdAt,
          attachments: [],
          referenced_message: null,
        },
        trigger_thread_context: { messages: [] },
      },
    },
  };
}

async function materialize(
  provider: ReturnType<typeof createDiscordTriggerProvider>,
  match: TriggerProviderMatch<DiscordTriggerContext, DiscordOutputContext>,
  projectId: string,
) {
  const materialized = await provider.materializeLaunch?.({
    executionId: "execution-discord-materialize",
    organizationId: "org_1",
    projectId,
    prompt: match.prompt,
    ...(match.environment.env === undefined ? {} : { environmentEnv: match.environment.env }),
    ...(match.environment.worktree === undefined
      ? {}
      : { environmentWorktree: match.environment.worktree }),
    triggerContext: structuredClone(match.triggerContext),
  });
  assert.ok(materialized);
  return materialized;
}

async function activeConfiguration(rawConfiguration: unknown) {
  return createActiveProjectConfiguration(createMemoryDatabase(), rawConfiguration);
}

function emptyConfiguration() {
  return {
    environments: [{ name: "unused", kind: "docker", image: "paseo/runner" }],
    triggers: [],
  };
}
