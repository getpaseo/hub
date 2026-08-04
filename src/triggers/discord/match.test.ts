import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { HubConfigSchema, type HubConfig } from "../../config/schema.js";
import type { NormalizedDiscordMessageEvent } from "./events.js";
import { matchDiscordTriggers } from "./match.js";

describe("Discord trigger matcher", () => {
  it("matches a discord.mention trigger when guild, channels, content, and from_users all line up", () => {
    const config = parseConfig({
      guild: "100",
      channels: ["200"],
      from_users: ["400"],
      contains: "ping",
    });

    const matches = matchDiscordTriggers(config, createEvent(), "123456789012345678");

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.trigger.name, "discord-mention");
  });

  it("matches pattern-less mentions by guild, channel, native mention, and from_users", () => {
    const config = parseConfig({
      guild: "100",
      channels: ["200"],
      from_users: ["400"],
    });

    const matches = matchDiscordTriggers(
      config,
      createEvent({ content: "<@123456789012345678> please summarize this" }),
      "123456789012345678",
    );

    assert.equal(matches.length, 1);
  });

  it("does not match when raw content contains a bot mention that Discord did not parse", () => {
    const config = parseConfig({
      guild: "100",
      channels: ["200"],
      from_users: ["400"],
      contains: "hello",
    });

    const matches = matchDiscordTriggers(
      config,
      createEvent({
        content: "<@1503563631571239062> hello",
        mentionedUserIds: [],
      }),
      "1503563631571239062",
    );

    assert.deepEqual(matches, []);
  });

  it("matches when Discord parsed the bot user mention", () => {
    const config = parseConfig({
      guild: "100",
      channels: ["200"],
      from_users: ["400"],
      contains: "hello",
    });

    const matches = matchDiscordTriggers(
      config,
      createEvent({
        content: "<@1503563631571239062> hello",
        mentionedUserIds: ["1503563631571239062"],
      }),
      "1503563631571239062",
    );

    assert.equal(matches.length, 1);
  });

  it("preserves native user mentions when Discord metadata has no content token", () => {
    const config = parseConfig({
      guild: "100",
      channels: ["200"],
      from_users: ["400"],
    });

    const matches = matchDiscordTriggers(
      config,
      createEvent({
        content: "say hello",
        mentionedUserIds: ["1503563631571239062"],
      }),
      "1503563631571239062",
    );

    assert.equal(matches.length, 1);
  });

  it("matches when Discord resolves the bot's managed role instead of its user", () => {
    const config = parseConfig({
      guild: "100",
      channels: ["200"],
      from_users: ["400"],
      contains: "say",
    });
    const event = {
      ...createEvent({
        content: "<@&1503564615181926523> say hello",
        mentionedUserIds: [],
      }),
      mentionedBotRoleIds: ["1503564615181926523"],
    };

    const matches = matchDiscordTriggers(config, event, "1503563631571239062");

    assert.equal(matches.length, 1);
  });

  it("prefers a direct bot mention when a managed role mention appears first", () => {
    const config = parseConfig({
      guild: "100",
      channels: ["200"],
      from_users: ["400"],
      contains: "ping",
    });
    const event = {
      ...createEvent({
        content: "<@&1503564615181926523> FYI <@1503563631571239062> ping",
        mentionedUserIds: ["1503563631571239062"],
      }),
      mentionedBotRoleIds: ["1503564615181926523"],
    };

    const matches = matchDiscordTriggers(config, event, "1503563631571239062");

    assert.equal(matches.length, 1);
  });

  it("does not match a bot reply without the native mention discriminator", () => {
    const config = parseConfig({
      guild: "100",
      channels: ["200"],
      from_users: ["900"],
    });

    assert.deepEqual(
      matchDiscordTriggers(
        config,
        createEvent({
          authorId: "900",
          authorBot: true,
          content: "Hello, here's the answer",
          mentionedUserIds: [],
        }),
        "123456789012345678",
      ),
      [],
    );
  });

  it("rejects pattern-less mentions from users outside from_users", () => {
    const config = parseConfig({
      guild: "100",
      from_users: ["someone-else"],
    });

    assert.deepEqual(
      matchDiscordTriggers(
        config,
        createEvent({ content: "<@123456789012345678> please summarize" }),
        "123456789012345678",
      ),
      [],
    );
  });

  it("matches when the message comes from the bot's own user id (no hardcoded bot-skip)", () => {
    const config = parseConfig({
      guild: "100",
      from_users: ["900"],
    });

    const matches = matchDiscordTriggers(
      config,
      createEvent({ authorId: "900", authorBot: true }),
      "123456789012345678",
    );

    assert.equal(matches.length, 1);
  });

  it("rejects when the guild filter does not match", () => {
    const config = parseConfig({ guild: "101", from_users: ["400"] });
    assert.deepEqual(matchDiscordTriggers(config, createEvent(), "123456789012345678"), []);
  });

  it("matches any guild when the guild filter is absent", () => {
    const config = parseConfig({ from_users: ["400"] });

    assert.equal(
      matchDiscordTriggers(config, createEvent({ guildId: "public-guild" }), "123456789012345678")
        .length,
      1,
    );
  });

  it("still requires from_users and native mention when the guild filter is absent", () => {
    const config = parseConfig({ from_users: ["400"] });

    assert.deepEqual(
      matchDiscordTriggers(
        config,
        createEvent({
          guildId: "public-guild",
          authorId: "someone-else",
        }),
        "123456789012345678",
      ),
      [],
    );
    assert.deepEqual(
      matchDiscordTriggers(
        config,
        createEvent({
          guildId: "public-guild",
          mentionedUserIds: [],
        }),
        "123456789012345678",
      ),
      [],
    );
  });

  it("rejects when the channel filter does not include the message's channel", () => {
    const config = parseConfig({
      guild: "100",
      channels: ["209"],
      from_users: ["400"],
    });
    assert.deepEqual(matchDiscordTriggers(config, createEvent(), "123456789012345678"), []);
  });

  it("matches when the channel filter includes the message's parent (thread case)", () => {
    const config = parseConfig({
      guild: "100",
      channels: ["200"],
      from_users: ["400"],
    });
    const event = createEvent({
      channelId: "207",
      threadId: "207",
      parentChannelId: "200",
    });

    assert.equal(matchDiscordTriggers(config, event, "123456789012345678").length, 1);
  });

  it("requires the native bot mention before the trigger pattern", () => {
    const config = parseConfig({
      guild: "100",
      contains: "ping",
      from_users: ["400"],
    });

    assert.equal(
      matchDiscordTriggers(
        config,
        createEvent({ content: "<@123456789012345678> ping" }),
        "123456789012345678",
      ).length,
      1,
    );
    assert.deepEqual(
      matchDiscordTriggers(config, createEvent({ content: "@paseo ping" }), "123456789012345678"),
      [],
    );
    assert.deepEqual(
      matchDiscordTriggers(
        config,
        createEvent({ content: "<@999999999999999999> ping" }),
        "123456789012345678",
      ),
      [],
    );
  });

  it("rejects when contains filter does not match after the bot mention", () => {
    const config = parseConfig({
      guild: "100",
      contains: "deploy",
      from_users: ["400"],
    });
    assert.deepEqual(matchDiscordTriggers(config, createEvent(), "123456789012345678"), []);
  });

  it("rejects when the author id is not in from_users", () => {
    const config = parseConfig({
      guild: "100",
      from_users: ["someone-else"],
    });
    assert.deepEqual(matchDiscordTriggers(config, createEvent(), "123456789012345678"), []);
  });

  it("denies when from_users is missing even if schema validation was bypassed", () => {
    const config: HubConfig = {
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
          name: "legacy-open-discord",
          on: "discord.mention",
          environment: "hetzner",
          filters: { guild: "100", channels: ["200"] },
          agent: { provider: "claude/opus", mode: "bypassPermissions" },
          prompt: { value: "respond", ast: [{ kind: "literal", value: "respond" }] },
          timeout: "30m",
          idle_timeout: "5m",
          auto_archive: false,
        },
      ],
    };

    assert.deepEqual(
      matchDiscordTriggers(
        config,
        createEvent({
          authorId: "anyone",
          content: "<@123456789012345678> ping",
        }),
        "123456789012345678",
      ),
      [],
    );
  });
});

interface FilterFixture {
  guild?: string;
  channels?: string[];
  from_users?: string[];
  contains?: string;
}

function parseConfig(filters: FilterFixture): HubConfig {
  return HubConfigSchema.parse({
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
        filters,
        agent: { provider: "claude/opus", mode: "bypassPermissions" },
        prompt: "respond to ${{ paseo.event.discord.trigger_message.content }}",
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
    authorBot?: boolean;
    content?: string;
    mentionedUserIds?: string[];
  } = {},
): NormalizedDiscordMessageEvent {
  const event = {
    type: "mention" as const,
    id: "300",
    guildId: overrides.guildId ?? "100",
    channelId: overrides.channelId ?? "200",
    threadId: overrides.threadId ?? null,
    parentChannelId: overrides.parentChannelId ?? null,
    messageId: "300",
    content: overrides.content ?? "<@123456789012345678> ping",
    author: {
      id: overrides.authorId ?? "400",
      username: "tester",
      bot: overrides.authorBot ?? false,
    },
    mentionedUserIds: overrides.mentionedUserIds ?? ["123456789012345678"],
    createdAt: "2026-05-19T00:00:00.000Z",
    attachments: [],
    referencedMessage: null,
    threadContextMessages: [],
  };
  return event;
}
