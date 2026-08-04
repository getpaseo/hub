import assert from "node:assert/strict";
import type { Client } from "discord.js";
import { describe, it } from "vitest";
import { createDiscordBotClient } from "./bot.js";

describe("Discord bot client", () => {
  it("disables all mention parsing when sending channel messages", async () => {
    const channel = new FakeSendableChannel();
    const bot = createDiscordBotClient({
      token: "token",
      clientId: "900",
      client: createFakeClient(channel),
    });

    await bot.sendChannelMessage({
      channelId: "200",
      threadId: null,
      content: "@everyone hello <@400>",
    });

    assert.deepEqual(channel.sentPayloads, [
      {
        content: "@everyone hello <@400>",
        allowedMentions: { parse: [] },
      },
    ]);
  });

  it("starts a thread on the trigger message when replying from a channel", async () => {
    const channel = new FakeSendableChannel({
      message: new FakeMessage("<@123456789012345678> summarize the release notes and next steps"),
    });
    const bot = createDiscordBotClient({
      token: "token",
      clientId: "900",
      client: createFakeClient(channel),
    });

    await bot.sendChannelMessage({
      channelId: "200",
      threadId: null,
      messageId: "300",
      content: "done",
    });

    assert.deepEqual(channel.sentPayloads, []);
    assert.deepEqual(channel.message?.startedThreads, [
      { name: "summarize the release notes and next steps" },
    ]);
    assert.deepEqual(channel.message?.thread.sentPayloads, [
      { content: "done", allowedMentions: { parse: [] } },
    ]);
  });

  it("sends directly to the existing thread when replying from a thread", async () => {
    const channel = new FakeSendableChannel();
    const thread = new FakeSendableChannel();
    const bot = createDiscordBotClient({
      token: "token",
      clientId: "900",
      client: createFakeClient(channel, thread),
    });

    await bot.sendChannelMessage({
      channelId: "200",
      threadId: "207",
      messageId: "300",
      content: "thread reply",
    });

    assert.deepEqual(channel.sentPayloads, []);
    assert.deepEqual(thread.sentPayloads, [
      { content: "thread reply", allowedMentions: { parse: [] } },
    ]);
  });

  it("rejects invalid snowflakes before calling Discord", async () => {
    const channel = new FakeSendableChannel();
    const bot = createDiscordBotClient({
      token: "token",
      clientId: "900",
      client: createFakeClient(channel),
    });

    await assert.rejects(
      () => bot.sendChannelMessage({ channelId: "0", content: "invalid" }),
      /Invalid string/u,
    );
    await assert.rejects(
      () => bot.createReaction({ channelId: "200", messageId: "message", emoji: "eyes" }),
      /Invalid string/u,
    );
    assert.deepEqual(channel.sentPayloads, []);
  });
});

class FakeSendableChannel {
  readonly sentPayloads: unknown[] = [];
  readonly messages: { fetch: (messageId: string) => Promise<FakeMessage> };

  constructor(readonly options: { message?: FakeMessage } = {}) {
    this.messages = {
      fetch: async (messageId: string) => {
        assert.equal(messageId, "300");
        if (this.options.message === undefined) {
          throw new Error("message unavailable");
        }
        return this.options.message;
      },
    };
  }

  get message(): FakeMessage | undefined {
    return this.options.message;
  }

  async send(payload: unknown): Promise<void> {
    this.sentPayloads.push(payload);
  }
}

class FakeMessage {
  readonly startedThreads: unknown[] = [];
  readonly thread = new FakeSendableChannel();

  constructor(readonly content: string) {}

  async startThread(input: unknown): Promise<FakeSendableChannel> {
    this.startedThreads.push(input);
    return this.thread;
  }
}

function createFakeClient(channel: FakeSendableChannel, thread?: FakeSendableChannel): Client {
  const fakeClient = {
    on() {
      return fakeClient;
    },
    channels: {
      async fetch(channelId: string): Promise<FakeSendableChannel> {
        if (channelId === "207" && thread !== undefined) {
          return thread;
        }
        assert.equal(channelId, "200");
        return channel;
      },
    },
    rest: {
      async delete(): Promise<void> {},
    },
    async login(): Promise<string> {
      return "logged-in";
    },
    destroy(): void {},
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return fakeClient as unknown as Client;
}
