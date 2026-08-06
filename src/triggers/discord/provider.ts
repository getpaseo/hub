import type { ConnectionResolver } from "../../config/connections.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentDescriptor,
  AttachmentReference,
} from "../../attachments/capabilities.js";
import { logger } from "../../logger.js";
import { type TriggerProvider, type TriggerProviderMatch } from "../index.js";
import type { DiscordBotClient } from "./bot.js";
import {
  matchDiscordTriggers,
  readDiscordInvocationParserMessage,
  readDiscordPromptBody,
} from "./match.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import { NormalizedDiscordMessageEventSchema } from "./events.js";
import type { NormalizedDiscordMessageEvent } from "./events.js";

export interface DiscordMergeMessage {
  id: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  channel: { id: string };
  created_at: string;
  attachments: AttachmentReference[] | AttachmentDescriptor[];
  referenced_message: { id: string; channel_id: string; guild_id: string | null } | null;
}

export interface DiscordMergeData {
  discord: {
    event_type: "mention";
    guild: { id: string };
    trigger_message: DiscordMergeMessage & {
      body: string;
      url: string;
      thread: { id: string; parent_channel_id: string | null; context_url: string } | null;
    };
    trigger_thread_context: { messages: DiscordMergeMessage[] };
  };
}

export interface DiscordTriggerContext {
  provider: "discord";
  target: DiscordOutputContext;
  event: DiscordMergeData;
}

export interface DiscordOutputContext {
  provider: "discord";
  guildId: string;
  channelId: string;
  threadId: string | null;
  messageId: string;
}

export function createDiscordTriggerProvider(options: {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  connectionsForProject?: (projectId: string) => ConnectionResolver;
  bot: DiscordBotClient;
  attachments?: AttachmentCapabilityRegistry;
}): TriggerProvider<"discord", DiscordTriggerContext, DiscordOutputContext> {
  return {
    name: "discord",
    eventNames: ["discord.mention"],
    async match(externalTrigger) {
      const event = NormalizedDiscordMessageEventSchema.parse(externalTrigger.payload);
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return [];
      const botClientId = options.bot.getSelfUserId();
      const matches: TriggerProviderMatch<DiscordTriggerContext, DiscordOutputContext>[] = [];

      for (const match of matchDiscordTriggers(
        stored.configuration,
        event,
        botClientId,
        externalTrigger.connectionId,
      )) {
        const compiledTrigger = stored.configuration.triggers.find(
          (candidate) => candidate.name === match.trigger.name,
        );
        if (compiledTrigger === undefined)
          throw new Error(`compiled trigger not found: ${match.trigger.name}`);
        const outputContext: DiscordOutputContext = {
          provider: "discord",
          guildId: event.guildId,
          channelId: event.channelId,
          threadId: event.threadId,
          messageId: event.messageId,
        };
        const triggerContext: DiscordTriggerContext = {
          provider: "discord",
          target: outputContext,
          event: await buildDiscordMergeData(
            event,
            botClientId,
            externalTrigger.providerEventReceiptId,
            externalTrigger.organizationId,
            externalTrigger.connectionId,
            options.attachments,
          ),
        };
        const invocation = parseInvocation(
          event.content,
          compiledTrigger.inputs,
          undefined,
          readDiscordInvocationParserMessage(event, botClientId, compiledTrigger.filters),
        );
        if (invocation.status === "accepted") {
          if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
        }
        if (invocation.status === "rejected") {
          matches.push({
            triggerName: match.trigger.name,
            triggerContext,
            outputContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          });
          continue;
        }
        matches.push({
          triggerName: match.trigger.name,
          triggerContext,
          outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
          invocation,
        });
      }

      return matches;
    },
    async materializeLaunch(launch) {
      const event = await materializeDiscordMergeData(
        launch.triggerContext.event,
        launch.executionId,
        options.attachments,
      );
      return {
        prompt: appendDiscordAttachmentContext(launch.prompt, event),
        ...(launch.environmentEnv === undefined ? {} : { environmentEnv: launch.environmentEnv }),
        ...(launch.environmentWorktree === undefined
          ? {}
          : { environmentWorktree: launch.environmentWorktree }),
      };
    },
    async onDispatchAccepted(triggerContext) {
      await reactSafely(options.bot, triggerContext.target, "eyes");
    },
    async onAgentExecutionStarted(triggerContext) {
      await deleteReactionSafely(options.bot, triggerContext.target, "eyes");
      await reactSafely(options.bot, triggerContext.target, "hourglass");
    },
    async onAgentExecutionCompleted(triggerContext) {
      await deleteReactionSafely(options.bot, triggerContext.target, "hourglass");
      await react(options.bot, triggerContext.target, "white_check_mark");
    },
    async onAgentExecutionFailed(triggerContext, _outputContext, reason) {
      await deleteReactionSafely(options.bot, triggerContext.target, "eyes");
      await deleteReactionSafely(options.bot, triggerContext.target, "hourglass");
      await react(options.bot, triggerContext.target, "x");
      await postThreadNotice(options.bot, triggerContext.target, `Paseo agent failed: ${reason}`);
    },
    async onMachineTerminated(triggerContext, reason) {
      if (reason === "launch_failed" || reason === "daemon_disconnected") {
        await deleteReactionSafely(options.bot, triggerContext.target, "eyes");
        await deleteReactionSafely(options.bot, triggerContext.target, "hourglass");
        await react(options.bot, triggerContext.target, "x");
        await postThreadNotice(
          options.bot,
          triggerContext.target,
          `Paseo machine terminated before the agent could complete: ${reason}`,
        );
      }
    },
  };
}

async function buildDiscordMergeData(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
  providerEventReceiptId: string,
  organizationId: string,
  connectionId: string | null | undefined,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<DiscordMergeData> {
  const triggerAttachments = await registerAttachments(
    event.attachments,
    providerEventReceiptId,
    organizationId,
    connectionId,
    attachments,
  );
  const contextMessages = await Promise.all(
    event.threadContextMessages.map(async (message) => ({
      ...buildDiscordMergeMessage(message),
      attachments: await registerAttachments(
        message.attachments,
        providerEventReceiptId,
        organizationId,
        connectionId,
        attachments,
      ),
    })),
  );
  return {
    discord: {
      event_type: event.type,
      guild: { id: event.guildId },
      trigger_message: {
        ...buildDiscordMergeMessage(event),
        attachments: triggerAttachments,
        body: readDiscordPromptBody(event, botClientId),
        url: buildDiscordMessageUrl(event),
        thread:
          event.threadId === null
            ? null
            : {
                id: event.threadId,
                parent_channel_id: event.parentChannelId,
                context_url: buildDiscordContextUrl(event),
              },
      },
      trigger_thread_context: {
        messages: contextMessages,
      },
    },
  };
}

function buildDiscordMergeMessage(
  message: Pick<
    NormalizedDiscordMessageEvent,
    "id" | "content" | "author" | "createdAt" | "attachments" | "referencedMessage"
  > & {
    channelId: string;
  },
): Omit<DiscordMergeMessage, "attachments"> {
  return {
    id: message.id,
    content: message.content,
    author: {
      id: message.author.id,
      username: message.author.username,
      ...(message.author.bot === undefined ? {} : { bot: message.author.bot }),
    },
    channel: { id: message.channelId },
    created_at: message.createdAt,
    referenced_message:
      message.referencedMessage === null
        ? null
        : {
            id: message.referencedMessage.id,
            channel_id: message.referencedMessage.channelId,
            guild_id: message.referencedMessage.guildId,
          },
  };
}

async function registerAttachments(
  source: NormalizedDiscordMessageEvent["attachments"],
  providerEventReceiptId: string,
  organizationId: string,
  connectionId: string | null | undefined,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<AttachmentReference[]> {
  if (source.length === 0) return [];
  if (attachments === undefined) throw new Error("attachment capability unavailable");
  if (connectionId === null || connectionId === undefined) {
    throw new Error("attachment ownership unavailable");
  }
  return Promise.all(
    source.map((file) =>
      attachments.register({
        providerEventReceiptId,
        organizationId,
        connectionId,
        provider: "discord",
        sourceId: file.id,
        locator: { url: file.url },
        filename: file.filename,
        contentType: file.contentType,
        byteSize: file.size,
      }),
    ),
  );
}

function appendDiscordAttachmentContext(prompt: string, event: DiscordMergeData): string {
  const attachments = [
    ...event.discord.trigger_message.attachments,
    ...event.discord.trigger_thread_context.messages.flatMap((message) => message.attachments),
  ];
  if (attachments.length === 0) return prompt;
  return `${prompt}\n\nDiscord attachments:\n${attachments
    .map(
      (attachment) =>
        `- ${attachment.filename} (${attachment.content_type ?? "unknown type"}, ${attachment.size ?? "unknown size"} bytes): ${"url" in attachment && typeof attachment.url === "string" ? attachment.url : "unavailable"}`,
    )
    .join("\n")}`;
}

async function materializeDiscordMergeData(
  event: DiscordMergeData,
  executionId: string,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<DiscordMergeData> {
  const materialize = (attachment: AttachmentReference | AttachmentDescriptor) => {
    if ("url" in attachment) return attachment;
    if (attachments === undefined) throw new Error("attachment capability unavailable");
    return attachments.materialize(attachment, executionId);
  };
  return {
    discord: {
      ...event.discord,
      trigger_message: {
        ...event.discord.trigger_message,
        attachments: event.discord.trigger_message.attachments.map(materialize),
      },
      trigger_thread_context: {
        messages: event.discord.trigger_thread_context.messages.map((message) => ({
          ...message,
          attachments: message.attachments.map(materialize),
        })),
      },
    },
  };
}

function buildDiscordMessageUrl(event: NormalizedDiscordMessageEvent): string {
  return `https://discord.com/channels/${event.guildId}/${event.channelId}/${event.messageId}`;
}

function buildDiscordContextUrl(event: NormalizedDiscordMessageEvent): string {
  return `https://discord.com/channels/${event.guildId}/${event.threadId ?? event.channelId}`;
}

async function reactSafely(
  bot: DiscordBotClient,
  event: DiscordOutputContext,
  emoji: string,
): Promise<void> {
  const discordEmoji = toDiscordReactionEmoji(emoji);
  try {
    await bot.createReaction({
      channelId: event.channelId,
      messageId: event.messageId,
      emoji: discordEmoji,
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        channelId: event.channelId,
        messageId: event.messageId,
        emoji: discordEmoji,
      },
      "discord reaction failed",
    );
  }
}

async function react(
  bot: DiscordBotClient,
  event: DiscordOutputContext,
  emoji: string,
): Promise<void> {
  await bot.createReaction({
    channelId: event.channelId,
    messageId: event.messageId,
    emoji: toDiscordReactionEmoji(emoji),
  });
}

async function deleteReactionSafely(
  bot: DiscordBotClient,
  event: DiscordOutputContext,
  emoji: string,
): Promise<void> {
  const discordEmoji = toDiscordReactionEmoji(emoji);

  try {
    await bot.deleteOwnReaction({
      channelId: event.channelId,
      messageId: event.messageId,
      emoji: discordEmoji,
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        channelId: event.channelId,
        messageId: event.messageId,
        emoji: discordEmoji,
      },
      "discord reaction cleanup failed",
    );
  }
}

function toDiscordReactionEmoji(emoji: string): string {
  switch (emoji) {
    case "eyes":
      return "👀";
    case "hourglass":
      return "⏳";
    case "check":
    case "white_check_mark":
      return "✅";
    case "cross":
    case "x":
      return "❌";
    default:
      return emoji;
  }
}

async function postThreadNotice(
  bot: DiscordBotClient,
  event: DiscordOutputContext,
  content: string,
): Promise<void> {
  await bot.sendChannelMessage({
    channelId: event.channelId,
    threadId: event.threadId,
    content,
  });
}
