import { z } from "zod";

const GoogleChatUserSchema = z
  .object({
    name: z.string().min(1),
    displayName: z.string().optional(),
    email: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

const GoogleChatAnnotationSchema = z
  .object({
    type: z.string().optional(),
    startIndex: z.number().int().nonnegative().optional(),
    length: z.number().int().positive().optional(),
    userMention: z
      .object({
        user: z
          .object({
            name: z.string().optional(),
            displayName: z.string().optional(),
            type: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const GoogleChatSpaceSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().optional(),
    spaceType: z.string().optional(),
    singleUserBotDm: z.boolean().optional(),
    displayName: z.string().optional(),
  })
  .passthrough();

const GoogleChatMessageSchema = z
  .object({
    name: z.string().min(1),
    sender: GoogleChatUserSchema.optional(),
    createTime: z.string().optional(),
    text: z.string().optional(),
    argumentText: z.string().optional(),
    thread: z
      .object({
        name: z.string().min(1),
      })
      .passthrough()
      .optional(),
    annotations: z.array(GoogleChatAnnotationSchema).optional(),
  })
  .passthrough();

const ClassicGoogleChatEventSchema = z
  .object({
    type: z.string().min(1),
    eventTime: z.string().optional(),
    space: GoogleChatSpaceSchema.optional(),
    message: GoogleChatMessageSchema.optional(),
    user: GoogleChatUserSchema.optional(),
  })
  .passthrough();

const AddonGoogleChatEventSchema = z
  .object({
    chat: z
      .object({
        user: GoogleChatUserSchema.optional(),
        eventTime: z.string().optional(),
        messagePayload: z
          .object({
            space: GoogleChatSpaceSchema,
            message: GoogleChatMessageSchema,
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const NormalizedGoogleChatContextMessageSchema = z.object({
  id: z.string().min(1),
  spaceName: z.string().min(1),
  threadName: z.string().nullable(),
  text: z.string(),
  author: z.object({
    id: z.string().min(1),
    displayName: z.string(),
    email: z.string().nullable(),
    bot: z.boolean().optional(),
  }),
  createdAt: z.string().min(1),
});

export type NormalizedGoogleChatContextMessage = z.infer<
  typeof NormalizedGoogleChatContextMessageSchema
>;

export const NormalizedGoogleChatMentionEventSchema = z.object({
  type: z.literal("mention"),
  id: z.string().min(1),
  projectId: z.string().min(1),
  spaceName: z.string().min(1),
  spaceDisplayName: z.string().nullable(),
  spaceType: z.enum(["dm", "space"]),
  threadName: z.string().nullable(),
  messageName: z.string().min(1),
  text: z.string(),
  argumentText: z.string(),
  author: z.object({
    id: z.string().min(1),
    displayName: z.string(),
    email: z.string().nullable(),
    bot: z.boolean().optional(),
  }),
  createdAt: z.string().min(1),
});

export type NormalizedGoogleChatMentionEvent = z.infer<
  typeof NormalizedGoogleChatMentionEventSchema
>;

export type ParsedGoogleChatEvent =
  | { kind: "mention"; event: NormalizedGoogleChatMentionEvent }
  | { kind: "ignored" }
  | { kind: "invalid" };

interface ExtractedMessageEnvelope {
  space: z.infer<typeof GoogleChatSpaceSchema>;
  message: z.infer<typeof GoogleChatMessageSchema>;
  fallbackUser: z.infer<typeof GoogleChatUserSchema> | undefined;
  eventTime: string | undefined;
}

export function parseGoogleChatMentionEvent(
  payload: unknown,
  projectId: string,
): ParsedGoogleChatEvent {
  const extracted = extractMessageEnvelope(payload);
  if (extracted === "ignored" || extracted === "invalid") {
    return { kind: extracted };
  }

  const sender = extracted.message.sender ?? extracted.fallbackUser;
  if (sender === undefined) {
    return { kind: "invalid" };
  }
  if (sender.type === "BOT") {
    return { kind: "ignored" };
  }

  const isDirectMessage = isDirectMessageSpace(extracted.space);
  const hasBotMention =
    extracted.message.argumentText !== undefined || hasBotMentionAnnotation(extracted.message);
  if (!isDirectMessage && !hasBotMention) {
    return { kind: "ignored" };
  }

  const text = extracted.message.text ?? "";
  const argumentText = resolveArgumentText(extracted.message, text);
  const createdAt = normalizeTimestamp(extracted.message.createTime ?? extracted.eventTime);
  if (createdAt === undefined) {
    return { kind: "invalid" };
  }

  const event = NormalizedGoogleChatMentionEventSchema.parse({
    type: "mention",
    id: extracted.message.name,
    projectId,
    spaceName: normalizeSpaceName(extracted.space.name),
    spaceDisplayName: optionalNonEmpty(extracted.space.displayName),
    spaceType: isDirectMessage ? "dm" : "space",
    threadName: extracted.message.thread?.name ?? null,
    messageName: extracted.message.name,
    text,
    argumentText,
    author: buildMentionAuthor(sender),
    createdAt,
  });

  return { kind: "mention", event };
}

function optionalNonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

function buildMentionAuthor(sender: z.infer<typeof GoogleChatUserSchema>) {
  return {
    id: sender.name,
    displayName: optionalNonEmpty(sender.displayName) ?? sender.name,
    email: optionalNonEmpty(sender.email),
    bot: sender.type === "BOT",
  };
}

export function normalizeSpaceName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("spaces/")) {
    return trimmed;
  }
  return `spaces/${trimmed}`;
}

function extractMessageEnvelope(
  payload: unknown,
): ExtractedMessageEnvelope | "ignored" | "invalid" {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "invalid";
  }

  if ("chat" in payload) {
    const addon = AddonGoogleChatEventSchema.safeParse(payload);
    if (!addon.success) {
      return "invalid";
    }
    const messagePayload = addon.data.chat.messagePayload;
    if (messagePayload === undefined) {
      return "ignored";
    }
    return {
      space: messagePayload.space,
      message: messagePayload.message,
      fallbackUser: addon.data.chat.user,
      eventTime: addon.data.chat.eventTime,
    };
  }

  const classic = ClassicGoogleChatEventSchema.safeParse(payload);
  if (!classic.success) {
    return "invalid";
  }
  if (classic.data.type !== "MESSAGE") {
    return "ignored";
  }
  if (classic.data.space === undefined || classic.data.message === undefined) {
    return "invalid";
  }
  return {
    space: classic.data.space,
    message: classic.data.message,
    fallbackUser: classic.data.user,
    eventTime: classic.data.eventTime,
  };
}

function isDirectMessageSpace(space: z.infer<typeof GoogleChatSpaceSchema>): boolean {
  return (
    space.singleUserBotDm === true || space.type === "DM" || space.spaceType === "DIRECT_MESSAGE"
  );
}

function hasBotMentionAnnotation(message: z.infer<typeof GoogleChatMessageSchema>): boolean {
  if (message.annotations === undefined) return false;
  return message.annotations.some(
    (annotation) =>
      annotation.type === "USER_MENTION" && annotation.userMention?.user?.type === "BOT",
  );
}

function resolveArgumentText(
  message: z.infer<typeof GoogleChatMessageSchema>,
  text: string,
): string {
  if (message.argumentText !== undefined) {
    return message.argumentText.trim();
  }
  const botAnnotation = message.annotations?.find(
    (annotation) =>
      annotation.type === "USER_MENTION" &&
      annotation.userMention?.user?.type === "BOT" &&
      annotation.startIndex === 0 &&
      annotation.length !== undefined,
  );
  if (botAnnotation?.length !== undefined) {
    return text.slice(botAnnotation.length).trim();
  }
  return text.trim();
}

function normalizeTimestamp(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) {
    return new Date().toISOString();
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}
