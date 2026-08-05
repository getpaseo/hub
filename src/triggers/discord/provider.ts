import type { ConnectionResolver } from "../../config/connections.js";
import type {
  CompiledProjectConfiguration,
  ProjectConfigurationStore,
} from "../../configuration/store.js";
import type { DaemonEnvironmentTarget } from "../../dispatcher/launch-machine-intent.js";
import { logger } from "../../logger.js";
import { cleanTriggerAgent, type TriggerProvider, type TriggerProviderMatch } from "../index.js";
import type { DiscordBotClient } from "./bot.js";
import { matchDiscordTriggers, readDiscordMentionToken, readDiscordPromptBody } from "./match.js";
import { interpolateInvocation, matchesInputFilters, parseInvocation } from "../invocation.js";
import { NormalizedDiscordMessageEventSchema } from "./events.js";
import type { NormalizedDiscordMessageEvent } from "./events.js";

export interface DiscordMergeMessage {
  id: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  channel: { id: string };
  created_at: string;
  attachments: Array<{
    id: string;
    filename: string;
    url: string;
    content_type: string | null;
    size: number;
  }>;
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
}): TriggerProvider<"discord", DiscordTriggerContext, DiscordOutputContext> {
  return {
    name: "discord",
    eventNames: ["discord.mention"],
    async match(externalTrigger) {
      const event = NormalizedDiscordMessageEventSchema.parse(externalTrigger.payload);
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getActive();
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
        const step = compiledTrigger.steps[0];
        const invocation = parseInvocation(
          event.content,
          compiledTrigger.inputs,
          readDiscordMentionToken(event, botClientId),
        );
        if (invocation.status === "accepted") {
          if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
        }
        const environmentName =
          invocation.status === "accepted"
            ? interpolateInvocation(step.environment, invocation)
            : step.environment;
        const baseEnvironment = readDaemonEnvironment(
          stored.configuration,
          environmentName,
          invocation.status === "rejected",
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
          event: buildDiscordMergeData(event, botClientId),
        };

        const environment: DaemonEnvironmentTarget = {
          ...baseEnvironment,
        };

        matches.push({
          triggerName: match.trigger.name,
          stepId: step.id,
          environmentName,
          environment,
          prompt: step.prompt.map((block) => block.value).join("\n"),
          agent: cleanTriggerAgent(step.agent),
          allowOutputs: cleanAllowedOutputs(step.allowOutputs),
          timeoutMs: step.maxRuntimeMs,
          runTimeoutMs: compiledTrigger.maxRuntimeMs,
          idleTimeoutMs: step.idleTimeoutMs,
          autoArchive: step.autoArchive,
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
      return {
        prompt: launch.prompt,
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

function buildDiscordMergeData(
  event: NormalizedDiscordMessageEvent,
  botClientId: string,
): DiscordMergeData {
  return {
    discord: {
      event_type: event.type,
      guild: { id: event.guildId },
      trigger_message: {
        ...buildDiscordMergeMessage(event),
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
        messages: event.threadContextMessages.map(buildDiscordMergeMessage),
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
): DiscordMergeMessage {
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
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      url: attachment.url,
      content_type: attachment.contentType,
      size: attachment.size,
    })),
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

function buildDiscordMessageUrl(event: NormalizedDiscordMessageEvent): string {
  return `https://discord.com/channels/${event.guildId}/${event.channelId}/${event.messageId}`;
}

function buildDiscordContextUrl(event: NormalizedDiscordMessageEvent): string {
  return `https://discord.com/channels/${event.guildId}/${event.threadId ?? event.channelId}`;
}

function readDaemonEnvironment(
  config: CompiledProjectConfiguration,
  environmentName: string,
  allowRejectedFallback = false,
): DaemonEnvironmentTarget {
  const environment =
    config.environments.find((item) => item.name === environmentName) ??
    (allowRejectedFallback
      ? config.environments.find((item) => item.kind === "daemon")
      : undefined);

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
