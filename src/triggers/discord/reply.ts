import { z } from "zod";
import { withExecutionLink } from "../../agent-executions/link.js";
import { DiscordSnowflakeSchema } from "../../discord/snowflake.js";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { DiscordBotClient } from "./bot.js";

const DISCORD_MESSAGE_LIMIT = 2000;

const DiscordReplyArgsSchema = z.object({
  content: z.string().min(1),
});

const DiscordReplyOutputContextSchema = z.object({
  channelId: DiscordSnowflakeSchema,
  threadId: DiscordSnowflakeSchema.nullable().optional(),
  messageId: DiscordSnowflakeSchema,
});

export interface CreateDiscordReplyExecutorOptions {
  bot: DiscordBotClient;
}

export function createDiscordReplyExecutor(
  options: CreateDiscordReplyExecutorOptions,
): OutputExecutor {
  return async function executeDiscordReply(input) {
    const args = DiscordReplyArgsSchema.parse(input.args);
    const context = DiscordReplyOutputContextSchema.parse(input.outputContext);

    const linkedContent = withExecutionLink(args.content, input.openInPaseoUrl);
    await options.bot.sendConversationReply({
      channelId: context.channelId,
      threadId: context.threadId ?? null,
      messageId: context.messageId,
      content: linkedContent.length <= DISCORD_MESSAGE_LIMIT ? linkedContent : args.content,
    });
  };
}
