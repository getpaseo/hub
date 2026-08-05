import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubConfig } from "../../config/index.js";
import type { NormalizedDiscordMessageEvent } from "./events.js";
import { matchDiscordTriggers } from "./match.js";

const BOT_ID = "123456789012345678";

describe("Discord trigger matching", () => {
  it("matches a compiled mention by guild, channel, content, and user", () => {
    const config = configFor({
      guild: "100",
      channels: ["200"],
      from_users: ["400"],
      contains: "ping",
    });
    assert.equal(matchDiscordTriggers(config, createEvent(), BOT_ID).length, 1);
  });

  it("requires Discord mention metadata and the configured user", () => {
    const config = configFor({ from_users: ["400"] });
    assert.deepEqual(
      matchDiscordTriggers(config, createEvent({ mentionedUserIds: [] }), BOT_ID),
      [],
    );
    assert.deepEqual(
      matchDiscordTriggers(config, createEvent({ authorId: "stranger" }), BOT_ID),
      [],
    );
  });

  it("supports parent-channel matching for threads and rejects other guilds", () => {
    const config = configFor({ guild: "100", channels: ["200"], from_users: ["400"] });
    assert.equal(
      matchDiscordTriggers(
        config,
        createEvent({ channelId: "207", threadId: "207", parentChannelId: "200" }),
        BOT_ID,
      ).length,
      1,
    );
    assert.deepEqual(matchDiscordTriggers(config, createEvent({ guildId: "101" }), BOT_ID), []);
  });
});

function configFor(filters: Record<string, unknown>) {
  return compileHubConfig({
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "discord-mention",
        on: "discord.mention",
        max_runtime: "2h",
        filters,
        steps: [
          {
            id: "reply",
            environment: "runner",
            max_runtime: "1h",
            idle_timeout: "5m",
            agent: { provider: "opencode", mode: "default" },
            prompt: [{ text: "Respond" }],
          },
        ],
      },
    ],
  });
}

function createEvent(
  overrides: {
    channelId?: string;
    guildId?: string;
    threadId?: string | null;
    parentChannelId?: string | null;
    authorId?: string;
    content?: string;
    mentionedUserIds?: string[];
  } = {},
): NormalizedDiscordMessageEvent {
  return {
    type: "mention",
    id: "300",
    guildId: overrides.guildId ?? "100",
    channelId: overrides.channelId ?? "200",
    threadId: overrides.threadId ?? null,
    parentChannelId: overrides.parentChannelId ?? null,
    messageId: "300",
    content: overrides.content ?? `<@${BOT_ID}> ping`,
    author: { id: overrides.authorId ?? "400", username: "author", bot: false },
    mentionedUserIds: overrides.mentionedUserIds ?? [BOT_ID],
    mentionedBotRoleIds: [],
    attachments: [],
    referencedMessage: null,
    threadContextMessages: [],
    createdAt: "2026-05-19T00:00:00.000Z",
  };
}
