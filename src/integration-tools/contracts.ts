import { z } from "zod";
import type { OutputToolSchema } from "../execution-capabilities/outputs.js";
import {
  discordId,
  slackChannelId,
  type IntegrationAction,
  type IntegrationProvider,
} from "./grants.js";

export const slackThreadTs = z.string().regex(/^[0-9]+\.[0-9]{6}$/u);
const limit = z.number().int().min(1).max(100).optional();
const target = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Discord channel or thread ID, or a discord.com/channels URL including an optional message ID.",
  );

export const slackRead = z.strictObject({
  channel: slackChannelId,
  thread_ts: slackThreadTs.optional(),
  limit,
  cursor: z.string().max(300).optional(),
});
export const slackPost = z.strictObject({
  channel: slackChannelId,
  thread_ts: slackThreadTs.optional(),
  content: z.string().min(1).max(40000),
});
export const discordRead = z.strictObject({
  target,
  message: discordId
    .optional()
    .describe("Message ID within target. Optional when the URL already identifies a message."),
  limit,
  before: discordId
    .optional()
    .describe("Use nextBefore from a previous page to read older messages."),
});
export const discordLatest = z.strictObject({
  channel: discordId.optional().describe("Restrict the scan to one granted channel or forum."),
  limit,
});
export const discordPost = z.strictObject({
  target,
  message: discordId
    .optional()
    .describe("Message ID within target. Optional when the URL already identifies a message."),
  content: z.string().min(1).max(2000),
  threadName: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Name for a contextual thread created on a text or announcement channel message."),
});

function tool(
  name: string,
  provider: IntegrationProvider,
  action: IntegrationAction,
  description: string,
  schema: z.ZodObject,
) {
  // Zod emits an object JSON Schema for every ZodObject, including its nested JSON schema nodes.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const inputSchema = z.toJSONSchema(schema) as OutputToolSchema;
  return { provider, action, schema, definition: { name, description, inputSchema } };
}

const empty = z.strictObject({});
export const integrationTools = [
  tool(
    "slack_list_channels",
    "slack",
    "read",
    "List the Slack channel IDs granted to this execution.",
    empty,
  ),
  tool(
    "slack_read",
    "slack",
    "read",
    "Read a Slack channel or thread. Use nextCursor to read the next page.",
    slackRead,
  ),
  tool(
    "slack_post",
    "slack",
    "post",
    "Send a Slack message to the channel, or reply to its thread_ts.",
    slackPost,
  ),
  tool(
    "discord_list_channels",
    "discord",
    "read",
    "List the granted Discord channels and forums.",
    empty,
  ),
  tool(
    "discord_read",
    "discord",
    "read",
    "Read a Discord channel, forum, thread or exact message with its thread. For more history, call again with nextBefore.",
    discordRead,
  ),
  tool(
    "discord_latest",
    "discord",
    "read",
    "Scan recent messages from granted Discord channels and forums, including active and recently archived threads. If timedOut is true, scannedChannels identifies the channels that were fully scanned.",
    discordLatest,
  ),
  tool(
    "discord_post",
    "discord",
    "post",
    "Send a Discord message, reply to a message in a thread, or open or reuse a contextual thread on a channel message.",
    discordPost,
  ),
];
