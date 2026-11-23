import { Readable } from "node:stream";
import {
  Client,
  DefaultRestOptions,
  DiscordAPIError,
  GatewayIntentBits,
  MessageFlags,
  RESTJSONErrorCodes,
  type ClientOptions,
  type GuildBasedChannel,
  type Message,
  type REST,
  type RESTOptions,
  type TextBasedChannel,
} from "discord.js";
import { Routes } from "discord-api-types/v10";
import { reportFailure } from "../../failures/index.js";
import { resolveDiscordMessageThread } from "../../discord/message-thread.js";
import { DiscordSnowflakeSchema } from "../../discord/snowflake.js";
import { NormalizedDiscordContextMessageSchema } from "./events.js";
import type { NormalizedDiscordContextMessage } from "./events.js";
import { createDiscordGatewayStrategy } from "./gateway-strategy.js";

type DiscordGatewayFailure =
  | "authenticationFailed"
  | "invalidShard"
  | "shardingRequired"
  | "invalidApiVersion"
  | "invalidIntents"
  | "disallowedIntents";

type DiscordGatewayFailureCode = "credentialsRejected" | "permissionMissing" | "internal";

const UNRECOVERABLE_GATEWAY_FAILURES = new Map<
  number,
  { failure: DiscordGatewayFailure; code: DiscordGatewayFailureCode }
>([
  [4004, { failure: "authenticationFailed", code: "credentialsRejected" }],
  [4010, { failure: "invalidShard", code: "internal" }],
  [4011, { failure: "shardingRequired", code: "internal" }],
  [4012, { failure: "invalidApiVersion", code: "internal" }],
  [4013, { failure: "invalidIntents", code: "internal" }],
  [4014, { failure: "disallowedIntents", code: "permissionMissing" }],
]);

class DiscordGatewayError extends Error {
  override readonly name = "DiscordGatewayError";

  constructor(
    readonly gatewayCloseCode: number,
    readonly gatewayFailure: DiscordGatewayFailure,
    readonly code: DiscordGatewayFailureCode,
    options?: ErrorOptions,
  ) {
    super("Discord gateway rejected the connection", options);
  }
}

function discordGatewayError(closeCode: number, cause: unknown): DiscordGatewayError | undefined {
  const classification = UNRECOVERABLE_GATEWAY_FAILURES.get(closeCode);
  if (classification === undefined) return undefined;
  return new DiscordGatewayError(closeCode, classification.failure, classification.code, {
    cause,
  });
}

export interface DiscordReactionInput {
  channelId: string;
  messageId: string;
  emoji: string;
}

export interface DiscordPostInput {
  channelId: string;
  threadId?: string | null;
  content: string;
}

export interface DiscordConversationReplyInput extends DiscordPostInput {
  messageId: string;
}

export interface DiscordBotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  getSelfUserId(): string;
  createReaction(input: DiscordReactionInput): Promise<void>;
  deleteOwnReaction(input: DiscordReactionInput): Promise<void>;
  sendChannelMessage(input: DiscordPostInput): Promise<void>;
  sendConversationReply(input: DiscordConversationReplyInput): Promise<void>;
  readMessage(input: {
    channelId: string;
    messageId: string;
  }): Promise<NormalizedDiscordContextMessage>;
  readThreadMessages(input: {
    channelId: string;
    beforeMessageId: string;
  }): Promise<NormalizedDiscordContextMessage[]>;
  onMessageCreate(handler: DiscordRawMessageHandler): () => void;
  onGuildDelete(handler: DiscordGuildDeleteHandler): () => void;
}

export type DiscordRawMessageHandler = (message: Message) => Promise<void>;
export type DiscordGuildDeleteHandler = (guild: {
  id: string;
  unavailable: boolean;
}) => Promise<void>;

type DiscordSendableChannel = TextBasedChannel & {
  send: (...args: unknown[]) => Promise<unknown>;
};

type DiscordReadableThread = TextBasedChannel & {
  fetchStarterMessage(): Promise<Message | null>;
};

const DISCORD_THREAD_CONTEXT_LIMIT = 50;
const DISCORD_STARTUP_TIMEOUT_MS = 15_000;
const DISCORD_CLEANUP_TIMEOUT_MS = 1_000;

class DiscordStartupTimeoutError extends Error {
  override readonly name = "DiscordStartupTimeoutError";
  readonly code = "timeout";

  constructor(timeoutMs: number) {
    super(`Discord gateway startup exceeded ${timeoutMs} ms`);
  }
}

function createDeadline(timeoutMs: number, createError: (budgetMs: number) => Error) {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire!: (error: Error) => void;
  const elapsed = new Promise<never>((_resolve, reject) => {
    expire = reject;
  });
  const clear = () => clearTimeout(timer);
  function allow(extraMs: number) {
    clear();
    const budgetMs = timeoutMs + extraMs;
    const remainingMs = budgetMs - (performance.now() - startedAt);
    timer = setTimeout(() => expire(createError(budgetMs)), remainingMs);
  }

  allow(0);
  return { elapsed, allow, clear };
}

function gatewayDiscoveryTransport(startup: AbortSignal): RESTOptions["makeRequest"] {
  return async (url, init) => {
    if (!new URL(url).pathname.endsWith(Routes.gatewayBot())) {
      return DefaultRestOptions.makeRequest(url, init);
    }

    startup.throwIfAborted();
    const signal = init.signal == null ? startup : AbortSignal.any([startup, init.signal]);
    try {
      const response = await DefaultRestOptions.makeRequest(url, { ...init, signal });
      // The REST SDK inspects these statuses without consuming the response body.
      if (response.status === 429 || response.status >= 500) {
        const body = response.body;
        if (body instanceof Readable) {
          body.once("error", () => {});
          body.destroy();
        } else if (body !== null) {
          await body.cancel();
        }
      }
      return response;
    } catch (error) {
      // The REST SDK retries AbortError. Propagate our startup deadline instead.
      startup.throwIfAborted();
      throw error;
    }
  };
}

export interface CreateDiscordBotClientOptions {
  token: string;
  clientId?: string;
  client?: Client;
  restOptions?: Pick<NonNullable<ClientOptions["rest"]>, "api" | "timeout">;
  startupTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

export function createDiscordBotClient(
  options: CreateDiscordBotClientOptions,
): DiscordBotClient & { readonly rest: REST } {
  const startupCancellation = new AbortController();
  let startupDeadline: ReturnType<typeof createDeadline> | undefined;
  const client =
    options.client ??
    new Client({
      rest: {
        ...options.restOptions,
        makeRequest: gatewayDiscoveryTransport(startupCancellation.signal),
        // The SDK's rate-limit sleep does not observe the startup signal.
        rejectOnRateLimit: [Routes.gatewayBot()],
      },
      ws: {
        buildStrategy: (manager) =>
          createDiscordGatewayStrategy(manager, startupCancellation.signal, (delayMs) => {
            startupDeadline?.allow(delayMs);
          }),
      },
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  if (options.client === undefined) client.rest.setToken(options.token);
  const handlers = new Set<DiscordRawMessageHandler>();
  const guildDeleteHandlers = new Set<DiscordGuildDeleteHandler>();
  const pendingReplyDestinations = new Map<string, Promise<DiscordSendableChannel>>();
  let started = false;
  let startup: Promise<void> | undefined;
  let abandoned: DiscordStartupTimeoutError | undefined;

  async function destroyAfterTimeout() {
    const deadline = createDeadline(
      options.cleanupTimeoutMs ?? DISCORD_CLEANUP_TIMEOUT_MS,
      () => new Error("Discord client destruction exceeded its deadline"),
    );
    try {
      await Promise.race([client.destroy(), deadline.elapsed]);
    } catch (error) {
      reportFailure(
        error,
        { operation: "discord.startup.cleanup", component: "triggers", provider: "discord" },
        { scrubValues: [options.token] },
      );
    } finally {
      deadline.clear();
    }
  }

  async function startClient() {
    let gatewayCloseCode: number | undefined;
    const observeGatewayClose = (event: { code: number }) => {
      gatewayCloseCode = event.code;
    };
    client.on("shardDisconnect", observeGatewayClose);
    const deadline = createDeadline(
      options.startupTimeoutMs ?? DISCORD_STARTUP_TIMEOUT_MS,
      (budgetMs) => new DiscordStartupTimeoutError(budgetMs),
    );
    startupDeadline = deadline;
    try {
      await Promise.race([
        client
          .login(options.token)
          .then(() => (abandoned === undefined ? undefined : destroyAfterTimeout())),
        deadline.elapsed,
      ]);
      started = true;
    } catch (error) {
      if (error instanceof DiscordStartupTimeoutError) {
        abandoned = error;
        startupCancellation.abort(error);
        await destroyAfterTimeout();
      }
      const classified =
        gatewayCloseCode === undefined ? undefined : discordGatewayError(gatewayCloseCode, error);
      throw classified ?? error;
    } finally {
      deadline.clear();
      startupDeadline = undefined;
      client.off("shardDisconnect", observeGatewayClose);
    }
  }

  client.on("messageCreate", (message: Message) => {
    if (abandoned !== undefined) return;
    void Promise.all(Array.from(handlers, (handler) => handler(message))).catch(
      (error: unknown) => {
        reportFailure(
          error,
          { operation: "discord.event.handoff", component: "triggers", provider: "discord" },
          {
            scrubValues: [options.token],
            diagnostic: {
              deliveryId: `discord-${message.id}`,
              guildId: message.guildId,
              channelId: message.channelId,
            },
          },
        );
      },
    );
  });
  client.on("guildDelete", (guild) => {
    if (abandoned !== undefined) return;
    const guildId = DiscordSnowflakeSchema.parse(guild.id);
    void Promise.all(
      Array.from(guildDeleteHandlers, (handler) =>
        handler({ id: guildId, unavailable: !guild.available }),
      ),
    ).catch((error: unknown) =>
      reportFailure(
        error,
        { operation: "discord.guild-delete.handoff", component: "triggers", provider: "discord" },
        { scrubValues: [options.token], diagnostic: { guildId } },
      ),
    );
  });

  return {
    rest: client.rest,
    async start() {
      if (started) return;
      if (abandoned !== undefined) throw abandoned;
      startup ??= startClient().finally(() => {
        startup = undefined;
      });
      await startup;
    },
    async stop() {
      await startup?.catch(() => {});
      if (!started) {
        return;
      }
      await client.destroy();
      started = false;
    },
    getSelfUserId() {
      const id = options.clientId ?? client.user?.id;
      if (id === undefined) {
        throw new Error("discord bot client has not received a self user yet");
      }
      return DiscordSnowflakeSchema.parse(id);
    },
    async createReaction(input) {
      await ignoreDeletedMessage(async () => {
        const message = await fetchMessage(
          client,
          DiscordSnowflakeSchema.parse(input.channelId),
          DiscordSnowflakeSchema.parse(input.messageId),
        );
        await message.react(input.emoji);
      });
    },
    async deleteOwnReaction(input) {
      const channelId = DiscordSnowflakeSchema.parse(input.channelId);
      const messageId = DiscordSnowflakeSchema.parse(input.messageId);
      await ignoreDeletedMessage(async () => {
        await client.rest.delete(
          Routes.channelMessageOwnReaction(channelId, messageId, input.emoji),
        );
      });
    },
    async sendChannelMessage(input) {
      const channelId = DiscordSnowflakeSchema.parse(input.threadId ?? input.channelId);
      const channel = await client.channels.fetch(channelId);
      if (channel === null || !isSendableChannel(channel)) {
        throw new Error(`discord channel not sendable: ${channelId}`);
      }
      await channel.send({ content: input.content, allowedMentions: { parse: [] } });
    },
    async sendConversationReply(input) {
      const channel =
        input.threadId === undefined || input.threadId === null
          ? await resolveReplyDestination(client, input, pendingReplyDestinations)
          : await fetchSendableChannel(client, input.threadId);
      await channel.send({
        content: input.content,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      });
    },
    async readMessage(input) {
      const message = await fetchMessage(
        client,
        DiscordSnowflakeSchema.parse(input.channelId),
        DiscordSnowflakeSchema.parse(input.messageId),
      );
      return normalizeContextMessage(message);
    },
    async readThreadMessages(input) {
      const channelId = DiscordSnowflakeSchema.parse(input.channelId);
      const beforeMessageId = DiscordSnowflakeSchema.parse(input.beforeMessageId);
      const channel = await client.channels.fetch(channelId);
      if (channel === null || !isThreadChannel(channel)) {
        throw new Error(`discord channel is not a readable thread: ${input.channelId}`);
      }
      const [starter, page] = await Promise.all([
        channel.fetchStarterMessage(),
        channel.messages.fetch({ before: beforeMessageId, limit: DISCORD_THREAD_CONTEXT_LIMIT }),
      ]);
      if (starter === null) throw new Error("Discord thread starter unavailable");
      const replies = Array.from(page.values())
        .filter((message) => message.id !== beforeMessageId && message.id !== starter.id)
        .map(normalizeContextMessage)
        .sort(compareThreadMessages)
        .slice(-(DISCORD_THREAD_CONTEXT_LIMIT - 1));
      return [normalizeContextMessage(starter), ...replies];
    },
    onMessageCreate(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onGuildDelete(handler) {
      guildDeleteHandlers.add(handler);
      return () => guildDeleteHandlers.delete(handler);
    },
  };
}

async function ignoreDeletedMessage(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage) {
      return;
    }
    throw error;
  }
}

async function resolveReplyDestination(
  client: Client,
  input: DiscordConversationReplyInput,
  pending: Map<string, Promise<DiscordSendableChannel>>,
): Promise<DiscordSendableChannel> {
  const channelId = DiscordSnowflakeSchema.parse(input.channelId);
  const messageId = DiscordSnowflakeSchema.parse(input.messageId);
  const key = `${channelId}:${messageId}`;
  const existing = pending.get(key);
  if (existing !== undefined) return existing;

  const resolution = (async () => {
    const message = await fetchMessage(client, channelId, messageId);
    const thread = await resolveDiscordMessageThread({
      hasThread: message.hasThread,
      readThread: () => fetchSendableChannel(client, messageId),
      createThread: () => message.startThread({ name: createThreadName(message.content) }),
    });
    if (!isSendableChannel(thread)) throw new Error(`discord channel not sendable: ${thread.id}`);
    return thread;
  })();
  pending.set(key, resolution);
  try {
    return await resolution;
  } finally {
    pending.delete(key);
  }
}

async function fetchSendableChannel(
  client: Client,
  channelId: string,
): Promise<DiscordSendableChannel> {
  const parsedChannelId = DiscordSnowflakeSchema.parse(channelId);
  const channel = await client.channels.fetch(parsedChannelId);
  if (channel === null || !isSendableChannel(channel)) {
    throw new Error(`discord channel not sendable: ${parsedChannelId}`);
  }
  return channel;
}

async function fetchMessage(
  client: Client,
  channelId: string,
  messageId: string,
): Promise<Message> {
  const channel = await client.channels.fetch(channelId);
  if (channel === null || !isTextChannel(channel)) {
    throw new Error(`discord channel not readable: ${channelId}`);
  }
  return channel.messages.fetch(messageId);
}

function isTextChannel(channel: GuildBasedChannel | TextBasedChannel): channel is TextBasedChannel {
  return "messages" in channel;
}

function isThreadChannel(
  channel: GuildBasedChannel | TextBasedChannel,
): channel is DiscordReadableThread {
  return (
    isTextChannel(channel) &&
    typeof channel.isThread === "function" &&
    channel.isThread() &&
    typeof Reflect.get(channel, "fetchStarterMessage") === "function"
  );
}

function isSendableChannel(
  channel: GuildBasedChannel | TextBasedChannel,
): channel is DiscordSendableChannel {
  return "send" in channel && typeof Reflect.get(channel, "send") === "function";
}

function createThreadName(content: string): string {
  const name = content
    .replaceAll(/<@!?\d+>/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 50)
    .trim();

  return name.length === 0 ? "paseo response" : name;
}

function normalizeContextMessage(message: Message): NormalizedDiscordContextMessage {
  return NormalizedDiscordContextMessageSchema.parse({
    id: message.id,
    channelId: message.channelId,
    content: message.content,
    author: {
      id: message.author.id,
      username: message.author.username,
      bot: message.author.bot,
    },
    createdAt: message.createdAt.toISOString(),
    attachments: Array.from(message.attachments.values(), (attachment) => ({
      id: attachment.id,
      filename: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType,
      size: attachment.size,
    })),
    embeds: message.embeds.map((embed) => ({
      title: embed.title,
      description: embed.description,
      url: embed.url,
      author: embed.author?.name ?? null,
      fields: embed.fields.map((field) => ({ name: field.name, value: field.value })),
      footer: embed.footer?.text ?? null,
    })),
    referencedMessage:
      message.reference === null || message.reference.messageId === undefined
        ? null
        : {
            id: message.reference.messageId,
            channelId: message.reference.channelId,
            guildId: message.reference.guildId ?? null,
          },
  });
}

function compareThreadMessages(
  left: NormalizedDiscordContextMessage,
  right: NormalizedDiscordContextMessage,
): number {
  const createdAtDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return createdAtDifference === 0
    ? left.id.localeCompare(right.id, undefined, { numeric: true })
    : createdAtDifference;
}
