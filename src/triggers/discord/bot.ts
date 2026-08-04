import {
  Client,
  GatewayIntentBits,
  type GuildBasedChannel,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { Routes } from "discord-api-types/v10";
import { logger } from "../../logger.js";
import { DiscordSnowflakeSchema } from "../../discord/snowflake.js";

export interface DiscordReactionInput {
  channelId: string;
  messageId: string;
  emoji: string;
}

export interface DiscordPostInput {
  channelId: string;
  threadId?: string | null;
  messageId?: string;
  content: string;
}

export interface DiscordBotClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  getSelfUserId(): string;
  createReaction(input: DiscordReactionInput): Promise<void>;
  deleteOwnReaction(input: DiscordReactionInput): Promise<void>;
  sendChannelMessage(input: DiscordPostInput): Promise<void>;
  onMessageCreate(handler: DiscordRawMessageHandler): () => void;
  onGuildDelete(handler: DiscordGuildDeleteHandler): () => void;
}

export type DiscordRawMessageHandler = (message: Message) => Promise<void>;
export type DiscordGuildDeleteHandler = (guild: {
  id: string;
  unavailable: boolean;
}) => Promise<void>;

export interface CreateDiscordBotClientOptions {
  token: string;
  clientId?: string;
  client?: Client;
}

export function createDiscordBotClient(options: CreateDiscordBotClientOptions): DiscordBotClient {
  const client =
    options.client ??
    new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  const handlers = new Set<DiscordRawMessageHandler>();
  const guildDeleteHandlers = new Set<DiscordGuildDeleteHandler>();
  let started = false;

  client.on("messageCreate", (message: Message) => {
    void Promise.all(Array.from(handlers, (handler) => handler(message))).catch(
      (error: unknown) => {
        logger.error({ err: error }, "discord messageCreate handler failed");
      },
    );
  });
  client.on("guildDelete", (guild) => {
    const guildId = DiscordSnowflakeSchema.parse(guild.id);
    void Promise.all(
      Array.from(guildDeleteHandlers, (handler) =>
        handler({ id: guildId, unavailable: !guild.available }),
      ),
    ).catch((error: unknown) => logger.error({ err: error }, "discord guildDelete handler failed"));
  });

  return {
    async start() {
      if (started) {
        return;
      }
      await client.login(options.token);
      started = true;
    },
    async stop() {
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
      const message = await fetchMessage(
        client,
        DiscordSnowflakeSchema.parse(input.channelId),
        DiscordSnowflakeSchema.parse(input.messageId),
      );
      await message.react(input.emoji);
    },
    async deleteOwnReaction(input) {
      const channelId = DiscordSnowflakeSchema.parse(input.channelId);
      const messageId = DiscordSnowflakeSchema.parse(input.messageId);
      await client.rest.delete(Routes.channelMessageOwnReaction(channelId, messageId, input.emoji));
    },
    async sendChannelMessage(input) {
      if (input.threadId !== undefined && input.threadId !== null) {
        const threadId = DiscordSnowflakeSchema.parse(input.threadId);
        const channel = await client.channels.fetch(threadId);
        if (channel === null || !isSendableChannel(channel)) {
          throw new Error(`discord channel not sendable: ${input.threadId}`);
        }
        await channel.send({ content: input.content, allowedMentions: { parse: [] } });
        return;
      }

      if (input.messageId !== undefined) {
        const message = await fetchMessage(
          client,
          DiscordSnowflakeSchema.parse(input.channelId),
          DiscordSnowflakeSchema.parse(input.messageId),
        );
        const thread = await message.startThread({ name: createThreadName(message.content) });
        await thread.send({ content: input.content, allowedMentions: { parse: [] } });
        return;
      }

      const channelId = DiscordSnowflakeSchema.parse(input.channelId);
      const channel = await client.channels.fetch(channelId);
      if (channel === null || !isSendableChannel(channel)) {
        throw new Error(`discord channel not sendable: ${input.channelId}`);
      }
      await channel.send({ content: input.content, allowedMentions: { parse: [] } });
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

function isSendableChannel(
  channel: GuildBasedChannel | TextBasedChannel,
): channel is TextBasedChannel & { send: (...args: unknown[]) => Promise<unknown> } {
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
