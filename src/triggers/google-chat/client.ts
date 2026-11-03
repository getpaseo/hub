import { z } from "zod";
import type { GoogleAccessTokenSource } from "../../providers/google-chat/auth.js";
import {
  NormalizedGoogleChatContextMessageSchema,
  normalizeSpaceName,
  type NormalizedGoogleChatContextMessage,
} from "./events.js";

export const GOOGLE_CHAT_API_BASE_URL = "https://chat.googleapis.com" as const;

const MAX_GOOGLE_CHAT_MESSAGE_LENGTH = 4_000;

const ListedMessageSchema = z
  .object({
    name: z.string().min(1),
    text: z.string().optional(),
    createTime: z.string().optional(),
    thread: z
      .object({
        name: z.string().min(1),
      })
      .passthrough()
      .optional(),
    sender: z
      .object({
        name: z.string().min(1),
        displayName: z.string().optional(),
        email: z.string().optional(),
        type: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ListMessagesResponseSchema = z
  .object({
    messages: z.array(ListedMessageSchema).optional(),
  })
  .passthrough();

export type GoogleChatThreadReadResult =
  | { status: "loaded"; messages: NormalizedGoogleChatContextMessage[] }
  | { status: "unavailable"; messages: [] };

export interface GoogleChatBotClient {
  sendMessage(input: { spaceName: string; threadName: string | null; text: string }): Promise<void>;
  readThreadMessages(input: {
    spaceName: string;
    threadName: string;
    beforeMessageName: string;
    beforeCreatedAt?: string;
  }): Promise<GoogleChatThreadReadResult>;
  verifySpacesAccess(): Promise<void>;
}

export class GoogleChatApiError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(
    message: string,
    options?: {
      code?: string;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GoogleChatApiError";
    this.code = options?.code ?? "upstreamUnavailable";
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}

export interface CreateGoogleChatBotClientOptions {
  tokenSource: GoogleAccessTokenSource;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

export function createGoogleChatBotClient(
  options: CreateGoogleChatBotClientOptions,
): GoogleChatBotClient {
  const fetchFn = options.fetch ?? fetch;
  const apiBaseUrl = trimTrailingSlashes(options.apiBaseUrl ?? GOOGLE_CHAT_API_BASE_URL);

  const authorizedFetch = async (path: string, init: RequestInit): Promise<Response> => {
    const token = await options.tokenSource.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    try {
      return await fetchFn(`${apiBaseUrl}${path}`, { ...init, headers });
    } catch (cause) {
      throw new GoogleChatApiError("Failed to reach Google Chat API.", {
        code: "network",
        cause,
      });
    }
  };

  return {
    async sendMessage(input) {
      const spaceName = normalizeSpaceName(input.spaceName);
      const chunks = splitGoogleChatMessage(input.text, MAX_GOOGLE_CHAT_MESSAGE_LENGTH);
      const query =
        input.threadName === null ? "" : "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
      const path = `/v1/${spaceName}/messages${query}`;

      for (const chunk of chunks) {
        const body =
          input.threadName === null
            ? { text: chunk }
            : { text: chunk, thread: { name: input.threadName } };
        const response = await authorizedFetch(path, {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw await buildGoogleChatHttpError(response, "Failed to post Google Chat message");
        }
      }
    },

    async readThreadMessages(input) {
      const spaceName = normalizeSpaceName(input.spaceName);
      const filter = `thread.name = "${input.threadName.replaceAll('"', '\\"')}"`;
      const params = new URLSearchParams({
        pageSize: "50",
        filter,
      });
      const response = await authorizedFetch(`/v1/${spaceName}/messages?${params.toString()}`, {
        method: "GET",
      });

      if (response.status === 403 || response.status === 404) {
        return { status: "unavailable", messages: [] };
      }
      if (!response.ok) {
        throw await buildGoogleChatHttpError(response, "Failed to read Google Chat thread");
      }

      const raw: unknown = await response.json();
      const parsed = ListMessagesResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new GoogleChatApiError("Google Chat messages.list returned an invalid payload.", {
          code: "invalidResponse",
        });
      }

      const cutoffMs =
        input.beforeCreatedAt === undefined ? undefined : Date.parse(input.beforeCreatedAt);
      const messages = (parsed.data.messages ?? [])
        .filter((item) => {
          if (item.name === input.beforeMessageName) return false;
          if (cutoffMs !== undefined && !Number.isNaN(cutoffMs) && item.createTime !== undefined) {
            const itemMs = Date.parse(item.createTime);
            if (!Number.isNaN(itemMs) && itemMs > cutoffMs) return false;
          }
          return true;
        })
        .map((item) => toContextMessage(item, spaceName));

      return { status: "loaded", messages };
    },

    async verifySpacesAccess() {
      const response = await authorizedFetch("/v1/spaces?pageSize=1", { method: "GET" });
      if (!response.ok) {
        throw await buildGoogleChatHttpError(
          response,
          "Google Chat API rejected service account credentials",
        );
      }
    },
  };
}

export function splitGoogleChatMessage(
  text: string,
  maxLength = MAX_GOOGLE_CHAT_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength);
    const newlineSplit = window.lastIndexOf("\n");
    const spaceSplit = window.lastIndexOf(" ");
    const minBreak = Math.floor(maxLength / 2);
    let breakAt = maxLength;
    if (newlineSplit >= minBreak) {
      breakAt = newlineSplit + 1;
    } else if (spaceSplit >= minBreak) {
      breakAt = spaceSplit + 1;
    }
    chunks.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks.length === 0 ? [text.slice(0, maxLength)] : chunks;
}

function toContextMessage(
  item: z.infer<typeof ListedMessageSchema>,
  spaceName: string,
): NormalizedGoogleChatContextMessage {
  const sender = item.sender;
  return NormalizedGoogleChatContextMessageSchema.parse({
    id: item.name,
    spaceName,
    threadName: item.thread?.name ?? null,
    text: item.text ?? "",
    author: {
      id: sender?.name ?? "users/unknown",
      displayName:
        sender?.displayName !== undefined && sender.displayName.length > 0
          ? sender.displayName
          : (sender?.name ?? "Unknown"),
      email: sender?.email !== undefined && sender.email.length > 0 ? sender.email : null,
      bot: sender?.type === "BOT",
    },
    createdAt:
      item.createTime !== undefined && !Number.isNaN(Date.parse(item.createTime))
        ? new Date(item.createTime).toISOString()
        : new Date(0).toISOString(),
  });
}

async function buildGoogleChatHttpError(
  response: Response,
  prefix: string,
): Promise<GoogleChatApiError> {
  let detail: string | undefined;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const errorField = Reflect.get(body, "error");
      if (typeof errorField === "object" && errorField !== null) {
        const message: unknown = Reflect.get(errorField, "message");
        if (typeof message === "string" && message.length > 0) {
          detail = message;
        }
      }
    }
  } catch {
    detail = undefined;
  }

  return new GoogleChatApiError(
    detail === undefined ? `${prefix} (HTTP ${String(response.status)}).` : `${prefix}: ${detail}`,
    {
      code: classifyChatHttpStatus(response.status),
      status: response.status,
    },
  );
}

function classifyChatHttpStatus(status: number): string {
  if (status === 401) return "credentialsRejected";
  if (status === 403) return "permissionMissing";
  if (status === 404) return "notFound";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "upstreamUnavailable";
  return "invalidInput";
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/u, "");
}
