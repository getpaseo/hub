import { z } from "zod";

const SlackIdSchema = z.string().min(1).max(255);
const SlackTimestampSchema = z.string().regex(/^\d+\.\d+$/u);

export const SlackUrlVerificationSchema = z
  .object({
    type: z.literal("url_verification"),
    challenge: z.string().min(1),
    api_app_id: SlackIdSchema.optional(),
  })
  .passthrough();

export const SlackEventCallbackSchema = z
  .object({
    type: z.literal("event_callback"),
    team_id: SlackIdSchema,
    api_app_id: SlackIdSchema,
    event_id: SlackIdSchema,
    event_time: z.number().int().nonnegative(),
    event: z.unknown(),
  })
  .passthrough();

const SlackAppMentionSchema = z
  .object({
    type: z.literal("app_mention"),
    user: SlackIdSchema,
    channel: SlackIdSchema,
    text: z.string(),
    ts: SlackTimestampSchema,
    event_ts: SlackTimestampSchema,
    thread_ts: SlackTimestampSchema.optional(),
    bot_id: SlackIdSchema.optional(),
    subtype: z.string().optional(),
  })
  .passthrough();

export const NormalizedSlackMentionEventSchema = z.object({
  type: z.literal("mention"),
  id: SlackIdSchema,
  teamId: SlackIdSchema,
  appId: SlackIdSchema,
  channelId: SlackIdSchema,
  messageTs: SlackTimestampSchema,
  threadTs: SlackTimestampSchema.nullable(),
  eventTs: SlackTimestampSchema,
  eventTime: z.number().int().nonnegative(),
  content: z.string(),
  author: z.object({ id: SlackIdSchema }),
  createdAt: z.string(),
});

export type NormalizedSlackMentionEvent = z.infer<typeof NormalizedSlackMentionEventSchema>;

export function normalizeSlackEvent(
  envelope: z.infer<typeof SlackEventCallbackSchema>,
): NormalizedSlackMentionEvent | undefined {
  const mention = SlackAppMentionSchema.safeParse(envelope.event);
  if (!mention.success) return undefined;
  if (mention.data.bot_id !== undefined || mention.data.subtype === "bot_message") return undefined;

  return NormalizedSlackMentionEventSchema.parse({
    type: "mention",
    id: envelope.event_id,
    teamId: envelope.team_id,
    appId: envelope.api_app_id,
    channelId: mention.data.channel,
    messageTs: mention.data.ts,
    threadTs: mention.data.thread_ts ?? null,
    eventTs: mention.data.event_ts,
    eventTime: envelope.event_time,
    content: mention.data.text,
    author: { id: mention.data.user },
    createdAt: new Date(Number(mention.data.ts) * 1_000).toISOString(),
  });
}
