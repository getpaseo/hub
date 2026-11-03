import { z } from "zod";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { GoogleChatBotClient } from "./client.js";

const GoogleChatReplyArgsSchema = z.object({
  content: z.string().min(1),
});

const GoogleChatReplyOutputContextSchema = z.object({
  spaceName: z.string().min(1),
  threadName: z.string().min(1).nullable().optional(),
  messageName: z.string().min(1),
});

export interface CreateGoogleChatReplyExecutorOptions {
  client: GoogleChatBotClient;
}

export function createGoogleChatReplyExecutor(
  options: CreateGoogleChatReplyExecutorOptions,
): OutputExecutor {
  return async function executeGoogleChatReply(input) {
    const args = GoogleChatReplyArgsSchema.parse(input.args);
    const context = GoogleChatReplyOutputContextSchema.parse(input.outputContext);

    await options.client.sendMessage({
      spaceName: context.spaceName,
      threadName: context.threadName ?? null,
      text: args.content,
    });
  };
}
