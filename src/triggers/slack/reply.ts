import { z } from "zod";
import { withExecutionLink } from "../../agent-executions/link.js";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { SlackBotClient } from "./client.js";

const SLACK_MESSAGE_LIMIT = 40_000;

const SlackReplyArgsSchema = z.object({ content: z.string().min(1) });
const SlackReplyOutputContextSchema = z.object({
  organizationId: z.string().min(1),
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
});

export function createSlackReplyExecutor(options: { client: SlackBotClient }): OutputExecutor {
  return async function executeSlackReply(input) {
    const args = SlackReplyArgsSchema.parse(input.args);
    const context = SlackReplyOutputContextSchema.parse(input.outputContext);
    const linkedContent = withExecutionLink(args.content, input.openInPaseoUrl, "slack");
    await options.client.sendMessage({
      ...context,
      content: linkedContent.length <= SLACK_MESSAGE_LIMIT ? linkedContent : args.content,
    });
  };
}
