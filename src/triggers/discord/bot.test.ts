import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DiscordAPIError, MessageFlags, RESTJSONErrorCodes, Client } from "discord.js";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "vitest";
import { createDiscordBotClient } from "./bot.js";

describe("Discord bot client", () => {
  it("abandons a silent login, bounds destruction, and cleans up a late login", async () => {
    const client = new ControlledLoginClient({ hangOnDestroy: true });
    const bot = createDiscordBotClient({
      token: "token",
      client,
      startupTimeoutMs: 10,
      cleanupTimeoutMs: 10,
    });
    const stopping = bot.start();

    await assert.rejects(
      Promise.race([
        stopping,
        delay(500, undefined, { ref: false }).then(() => {
          throw new Error("startup remained pending");
        }),
      ]),
      { name: "DiscordStartupTimeoutError", code: "timeout" },
    );
    assert.equal(client.destructions, 1);
    await bot.stop();

    client.finishLogin("token");
    await delay(0);
    assert.equal(client.destructions, 2);
    await assert.rejects(bot.start(), { name: "DiscordStartupTimeoutError" });
    assert.equal(client.logins, 1);
  });

  it("shares a responsive login and stops the client normally", async () => {
    const client = new ControlledLoginClient();
    const bot = createDiscordBotClient({ token: "token", client, startupTimeoutMs: 100 });
    const first = bot.start();
    const second = bot.start();
    client.finishLogin("token");
    await Promise.all([first, second]);
    assert.equal(client.logins, 1);
    assert.equal(client.destructions, 0);
    await bot.stop();
    assert.equal(client.destructions, 1);
  });

  it("preserves the SDK invalid-token error", async () => {
    const bot = createDiscordBotClient({ token: "", client: new Client({ intents: [] }) });
    await assert.rejects(bot.start(), { code: "TokenInvalid" });
  });

  it("classifies a disallowed-intents gateway close from its structured code", async () => {
    const canary = "gateway-login-secret-3f72";
    const client = new FakeGatewayClient(4014, new Error(canary));
    const bot = createDiscordBotClient({
      token: canary,
      clientId: "900",
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- focused event-compatible client double
      client: client as unknown as Client,
    });

    await assert.rejects(bot.start(), (error: unknown) => {
      if (!(error instanceof Error)) return false;
      return (
        error.name === "DiscordGatewayError" &&
        Reflect.get(error, "code") === "permissionMissing" &&
        Reflect.get(error, "gatewayCloseCode") === 4014 &&
        Reflect.get(error, "gatewayFailure") === "disallowedIntents"
      );
    });
  });

  it.each([
    [4004, "credentialsRejected"],
    [4013, "internal"],
    [4014, "permissionMissing"],
  ] as const)("maps unrecoverable gateway close %i to %s", async (closeCode, expectedCode) => {
    const client = new FakeGatewayClient(closeCode, new Error("ignored"));
    const bot = createDiscordBotClient({
      token: "token",
      clientId: "900",
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- focused event-compatible client double
      client: client as unknown as Client,
    });

    await assert.rejects(
      bot.start(),
      (error: unknown) => error instanceof Error && Reflect.get(error, "code") === expectedCode,
    );
  });

  it.each([4008, 4009])("does not misclassify recoverable gateway close %i", async (closeCode) => {
    const original = new Error("recoverable close");
    const client = new FakeGatewayClient(closeCode, original);
    const bot = createDiscordBotClient({
      token: "token",
      clientId: "900",
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- focused event-compatible client double
      client: client as unknown as Client,
    });

    // Discord.js reconnects or resumes these; presenting them as a durable setup fault would lie.
    await assert.rejects(bot.start(), (error: unknown) => error === original);
  });

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

  it("creates one thread and sends repeated conversation replies into it", async () => {
    const channel = new FakeSendableChannel({
      message: new FakeMessage("<@123456789012345678> summarize the release notes and next steps"),
    });
    const bot = createDiscordBotClient({
      token: "token",
      clientId: "900",
      client: createFakeClient(channel),
    });

    await Promise.all([
      bot.sendConversationReply({
        channelId: "200",
        threadId: null,
        messageId: "300",
        content: "done",
      }),
      bot.sendConversationReply({
        channelId: "200",
        threadId: null,
        messageId: "300",
        content: "more detail",
      }),
    ]);
    await bot.sendConversationReply({
      channelId: "200",
      threadId: null,
      messageId: "300",
      content: "final detail",
    });

    assert.deepEqual(channel.sentPayloads, []);
    assert.deepEqual(channel.message?.startedThreads, [
      { name: "summarize the release notes and next steps" },
    ]);
    const createdThread = channel.message?.thread;
    assert.ok(createdThread);
    assert.deepEqual(createdThread.sentPayloads, [
      { content: "done", allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds },
      {
        content: "more detail",
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      },
      {
        content: "final detail",
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      },
    ]);
  });

  it("reuses a thread already attached to the triggering channel message", async () => {
    const existingThread = new FakeSendableChannel();
    const message = new FakeMessage("question", existingThread);
    const channel = new FakeSendableChannel({ message });
    const bot = createDiscordBotClient({
      token: "token",
      clientId: "900",
      client: createFakeClient(channel),
    });

    await bot.sendConversationReply({
      channelId: "200",
      threadId: null,
      messageId: "300",
      content: "existing thread reply",
    });

    assert.deepEqual(message.startedThreads, []);
    assert.deepEqual(existingThread.sentPayloads, [
      {
        content: "existing thread reply",
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      },
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

    await bot.sendConversationReply({
      channelId: "200",
      threadId: "207",
      messageId: "300",
      content: "thread reply",
    });
    await bot.sendConversationReply({
      channelId: "200",
      threadId: "207",
      messageId: "300",
      content: "second thread reply",
    });

    assert.deepEqual(channel.sentPayloads, []);
    assert.deepEqual(thread.sentPayloads, [
      {
        content: "thread reply",
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      },
      {
        content: "second thread reply",
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      },
    ]);
  });

  it("keeps the thread starter ahead of the latest replies in context", async () => {
    const starter = contextMessage("200", "100", "root request", 0);
    const replies = Array.from({ length: 50 }, (_, index) =>
      contextMessage(String(250 + index), "207", `reply-${index + 1}`, index + 1),
    );
    const thread = new FakeReadableThread(starter, replies);
    const bot = createDiscordBotClient({
      token: "token",
      clientId: "900",
      client: createFakeClient(new FakeSendableChannel(), thread),
    });

    const messages = await bot.readThreadMessages({
      channelId: "207",
      beforeMessageId: "300",
    });

    assert.equal(messages.length, 50);
    assert.deepEqual(
      messages.map((message) => message.content),
      ["root request", ...replies.slice(1).map((message) => message.content)],
    );
    assert.deepEqual(thread.historyRequests, [{ before: "300", limit: 50 }]);
    assert.equal(thread.starterReads, 1);
  });

  it("rejects thread context when Discord cannot provide its starter", async () => {
    const bot = createDiscordBotClient({
      token: "token",
      clientId: "900",
      client: createFakeClient(new FakeSendableChannel(), new FakeReadableThread(null, [])),
    });

    await assert.rejects(
      () => bot.readThreadMessages({ channelId: "207", beforeMessageId: "300" }),
      /thread starter unavailable/u,
    );
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

  it("treats reactions to a deleted message as already converged", async () => {
    const missingMessage = new DiscordAPIError(
      { code: RESTJSONErrorCodes.UnknownMessage, message: "Unknown Message" },
      RESTJSONErrorCodes.UnknownMessage,
      404,
      "PUT",
      "https://discord.test/channels/200/messages/300/reactions/%E2%9C%85/@me",
      { body: null, files: [] },
    );
    const channel = new FakeSendableChannel({ messageFetchError: missingMessage });
    const bot = createDiscordBotClient({
      token: "token",
      clientId: "900",
      client: createFakeClient(channel, undefined, { deleteReactionError: missingMessage }),
    });

    await bot.createReaction({ channelId: "200", messageId: "300", emoji: "✅" });
    await bot.deleteOwnReaction({ channelId: "200", messageId: "300", emoji: "⏳" });
  });

  it("preserves other reaction failures for retry", async () => {
    const unavailable = new Error("Discord unavailable");
    const channel = new FakeSendableChannel({ messageFetchError: unavailable });
    const bot = createDiscordBotClient({
      token: "token",
      clientId: "900",
      client: createFakeClient(channel, undefined, { deleteReactionError: unavailable }),
    });

    await assert.rejects(
      bot.createReaction({ channelId: "200", messageId: "300", emoji: "✅" }),
      (error: unknown) => error === unavailable,
    );
    await assert.rejects(
      bot.deleteOwnReaction({ channelId: "200", messageId: "300", emoji: "⏳" }),
      (error: unknown) => error === unavailable,
    );
  });
});

class FakeSendableChannel {
  readonly sentPayloads: unknown[] = [];
  readonly messages: { fetch: (messageId: string) => Promise<FakeMessage> };

  constructor(readonly options: { message?: FakeMessage; messageFetchError?: Error } = {}) {
    this.messages = {
      fetch: async (messageId: string) => {
        assert.equal(messageId, "300");
        if (this.options.messageFetchError !== undefined) {
          throw this.options.messageFetchError;
        }
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

class FakeReadableThread {
  readonly historyRequests: unknown[] = [];
  starterReads = 0;
  readonly messages = {
    fetch: (request: unknown) => {
      this.historyRequests.push(request);
      return Promise.resolve(new Map(this.replies.map((message) => [message.id, message])));
    },
  };

  constructor(
    private readonly starter: FakeContextMessage | null,
    private readonly replies: FakeContextMessage[],
  ) {}

  isThread(): boolean {
    return true;
  }

  fetchStarterMessage(): Promise<FakeContextMessage | null> {
    this.starterReads += 1;
    return Promise.resolve(this.starter);
  }
}

interface FakeContextMessage {
  id: string;
  channelId: string;
  content: string;
  author: { id: string; username: string; bot: boolean };
  createdAt: Date;
  attachments: Map<string, never>;
  reference: null;
}

function contextMessage(
  id: string,
  channelId: string,
  content: string,
  seconds: number,
): FakeContextMessage {
  return {
    id,
    channelId,
    content,
    author: { id: "400", username: "maintainer", bot: false },
    createdAt: new Date(1_700_000_000_000 + seconds * 1_000),
    attachments: new Map<string, never>(),
    reference: null,
  };
}

class ControlledLoginClient extends Client {
  finishLogin!: (token: string) => void;
  private readonly pendingLogin = new Promise<string>((resolve) => {
    this.finishLogin = resolve;
  });
  logins = 0;
  destructions = 0;

  constructor(private readonly behavior: { hangOnDestroy?: boolean } = {}) {
    super({ intents: [] });
  }

  override login(): Promise<string> {
    this.logins += 1;
    return this.pendingLogin;
  }

  override async destroy(): Promise<void> {
    this.destructions += 1;
    if (this.behavior.hangOnDestroy && this.destructions === 1) {
      await new Promise<void>(() => {});
    }
    await super.destroy();
  }
}

class FakeGatewayClient extends EventEmitter {
  constructor(
    private readonly closeCode: number,
    private readonly loginError: Error,
  ) {
    super();
  }

  async login(): Promise<never> {
    this.emit("shardDisconnect", { code: this.closeCode, reason: this.loginError.message }, 0);
    throw this.loginError;
  }

  destroy(): void {}
}

class FakeMessage {
  readonly startedThreads: unknown[] = [];

  constructor(
    readonly content: string,
    public thread: FakeSendableChannel | null = null,
  ) {}

  get hasThread(): boolean {
    return this.thread !== null;
  }

  async startThread(input: unknown): Promise<FakeSendableChannel> {
    this.startedThreads.push(input);
    this.thread = new FakeSendableChannel();
    return this.thread;
  }
}

function createFakeClient(
  channel: FakeSendableChannel,
  thread?: FakeSendableChannel | FakeReadableThread,
  options: { deleteReactionError?: Error } = {},
): Client {
  const fakeClient = {
    on() {
      return fakeClient;
    },
    channels: {
      async fetch(channelId: string): Promise<FakeSendableChannel | FakeReadableThread> {
        if (channelId === "207" && thread !== undefined) {
          return thread;
        }
        const attachedThread = channel.message?.thread;
        if (channelId === "300" && attachedThread !== undefined && attachedThread !== null)
          return attachedThread;
        assert.equal(channelId, "200");
        return channel;
      },
    },
    rest: {
      async delete(): Promise<void> {
        if (options.deleteReactionError !== undefined) throw options.deleteReactionError;
      },
    },
    async login(): Promise<string> {
      return "logged-in";
    },
    destroy(): void {},
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return fakeClient as unknown as Client;
}
