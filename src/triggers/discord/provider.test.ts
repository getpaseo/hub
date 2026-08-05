import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { MemoryDiscordBotClient } from "./memory-bot.js";
import { createDiscordTriggerProvider } from "./provider.js";
import type { NormalizedDiscordMessageEvent } from "./events.js";

describe("Discord Phase 1 trigger provider", () => {
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
});

async function activeConfiguration() {
  return createActiveProjectConfiguration(createMemoryDatabase(), {
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
  });
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

function event(overrides: { authorId?: string } = {}): NormalizedDiscordMessageEvent {
  return {
    type: "mention",
    id: "300",
    guildId: "100",
    channelId: "200",
    threadId: null,
    parentChannelId: null,
    messageId: "300",
    content: "<@900> ping",
    mentionedUserIds: ["900"],
    author: { id: overrides.authorId ?? "400", username: "tester", bot: false },
    createdAt: "2026-05-19T00:00:00.000Z",
    attachments: [],
    referencedMessage: null,
    threadContextMessages: [],
  };
}
