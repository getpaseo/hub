import type { ConnectionResolver } from "../../config/index.js";
import type {
  AttachmentCapabilityRegistry,
  AttachmentDescriptor,
  AttachmentReference,
} from "../../attachments/capabilities.js";
import type {
  CompiledProjectConfiguration,
  ProjectConfigurationStore,
} from "../../configuration/store.js";
import {
  createInterpolationContext,
  interpolateRecord,
  interpolateTemplate,
  interpolateWorktree,
  parseTemplate,
  parseTriggerTimeoutMs,
} from "../../config/index.js";
import type { DaemonEnvironmentTarget } from "../../dispatcher/launch-machine-intent.js";
import { logger } from "../../logger.js";
import { cleanTriggerAgent, type TriggerProvider, type TriggerProviderMatch } from "../index.js";
import type { DiscordBotClient } from "./bot.js";
import { matchDiscordTriggers, readDiscordPromptBody } from "./match.js";
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
    async match(trigger) {
      const event = NormalizedDiscordMessageEventSchema.parse(trigger.payload);
      const stored = await options.configurationStoreForProject(trigger.projectId).getActive();
      if (stored === undefined) return [];
      const botClientId = options.bot.getSelfUserId();
      const matches: TriggerProviderMatch<DiscordTriggerContext, DiscordOutputContext>[] = [];

      for (const match of matchDiscordTriggers(
        stored.configuration,
        event,
        botClientId,
        trigger.connectionId,
      )) {
        const baseEnvironment = readDaemonEnvironment(
          stored.configuration,
          match.trigger.environment,
        );
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
            trigger.triggerId,
            trigger.organizationId,
            trigger.connectionId,
            options.attachments,
          ),
        };

        const environment: DaemonEnvironmentTarget = {
          ...baseEnvironment,
          ...(match.trigger.env === undefined
            ? {}
            : {
                env: Object.fromEntries(
                  Object.entries(match.trigger.env).map(([key, value]) => [key, value.value]),
                ),
              }),
        };

        matches.push({
          triggerName: match.trigger.name,
          environmentName: match.trigger.environment,
          environment,
          prompt: match.trigger.prompt.value,
          agent: cleanTriggerAgent(match.trigger.agent),
          allowOutputs: cleanAllowedOutputs(match.trigger.allow_outputs ?? []),
          timeoutMs: parseTriggerTimeoutMs(match.trigger.timeout),
          idleTimeoutMs: parseTriggerTimeoutMs(match.trigger.idle_timeout),
          autoArchive: match.trigger.auto_archive,
          triggerContext,
          outputContext,
          configurationRevisionId: stored.revision.id,
          hubConfig: stored.configuration,
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
      const context = createInterpolationContext(
        event,
        withExecutionContext(options.connectionsForProject?.(launch.projectId), launch.executionId),
      );
      const [prompt, environmentEnv, environmentWorktree] = await Promise.all([
        interpolateTemplate(parseTemplate(launch.prompt), context),
        interpolateRecord(
          launch.environmentEnv === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(launch.environmentEnv).map(([key, value]) => [
                  key,
                  parseTemplate(value),
                ]),
              ),
          context,
        ),
        launch.environmentWorktree === undefined
          ? undefined
          : interpolateWorktree(launch.environmentWorktree, context),
      ]);
      return {
        prompt,
        ...(Object.keys(environmentEnv).length === 0 ? {} : { environmentEnv }),
        ...(environmentWorktree === undefined ? {} : { environmentWorktree }),
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
      await reactSafely(options.bot, triggerContext.target, "white_check_mark");
    },
    async onAgentExecutionFailed(triggerContext, _outputContext, reason) {
      await deleteReactionSafely(options.bot, triggerContext.target, "eyes");
      await deleteReactionSafely(options.bot, triggerContext.target, "hourglass");
      await reactSafely(options.bot, triggerContext.target, "x");
      await postThreadNoticeSafely(
        options.bot,
        triggerContext.target,
        `Paseo agent failed: ${reason}`,
      );
    },
    async onMachineTerminated(triggerContext, reason) {
      if (reason === "launch_failed" || reason === "daemon_disconnected") {
        await deleteReactionSafely(options.bot, triggerContext.target, "eyes");
        await deleteReactionSafely(options.bot, triggerContext.target, "hourglass");
        await reactSafely(options.bot, triggerContext.target, "x");
        await postThreadNoticeSafely(
          options.bot,
          triggerContext.target,
          `Paseo machine terminated before the agent could complete: ${reason}`,
        );
      }
    },
  };
}

function withExecutionContext(
  connections: ConnectionResolver | undefined,
  executionId: string,
): ConnectionResolver | undefined {
  if (connections === undefined) return undefined;
  return (connectionSlug, value) => connections(connectionSlug, value, { executionId });
}

async function buildDiscordMergeData(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
  triggerId: string | undefined,
  organizationId: string,
  connectionId: string | null | undefined,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<DiscordMergeData> {
  const triggerAttachments = await registerAttachments(
    event.attachments,
    triggerId,
    organizationId,
    connectionId,
    attachments,
  );
  const contextMessages = await Promise.all(
    event.threadContextMessages.map(async (message) => ({
      ...buildDiscordMergeMessage(message),
      attachments: await registerAttachments(
        message.attachments,
        triggerId,
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
  triggerId: string | undefined,
  organizationId: string,
  connectionId: string | null | undefined,
  attachments: AttachmentCapabilityRegistry | undefined,
): Promise<AttachmentReference[]> {
  if (source.length === 0) return [];
  if (attachments === undefined) throw new Error("attachment capability unavailable");
  if (triggerId === undefined || connectionId === null || connectionId === undefined) {
    throw new Error("attachment ownership unavailable");
  }
  return Promise.all(
    source.map((file) =>
      attachments.register({
        triggerId,
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

function readDaemonEnvironment(
  config: CompiledProjectConfiguration,
  environmentName: string,
): DaemonEnvironmentTarget {
  const environment = config.environments.find((item) => item.name === environmentName);

  if (environment === undefined) {
    throw new Error(`environment not found: ${environmentName}`);
  }

  if (environment.kind !== "daemon") {
    throw new Error(`environment kind is not implemented: ${environment.kind}`);
  }

  return {
    kind: "daemon",
    daemonId: environment.daemonId,
    authoredSlug: environment.daemon,
    cwd: environment.cwd,
    ...(environment.worktree === undefined ? {} : { worktree: environment.worktree }),
  };
}

function cleanAllowedOutputs(outputs: readonly { type: string; max: number }[]) {
  return outputs.map((output) => ({ type: output.type, max: output.max }));
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

async function postThreadNoticeSafely(
  bot: DiscordBotClient,
  event: DiscordOutputContext,
  content: string,
): Promise<void> {
  try {
    await bot.sendChannelMessage({
      channelId: event.channelId,
      threadId: event.threadId,
      content,
    });
  } catch (error) {
    logger.warn(
      {
        err: error,
        channelId: event.channelId,
        threadId: event.threadId,
      },
      "discord thread notice failed",
    );
  }
}
