import { createHash } from "node:crypto";
import { z } from "zod";
import { reportFailure } from "../../failures/index.js";
import type { GoogleAccessTokenSource } from "../../providers/google-chat/auth.js";
import type { TriggerHandler, TriggerSource } from "../index.js";
import {
  GoogleChatEventIntakeValidationError,
  intakeGoogleChatEvent,
  type GoogleChatEventIntakeOptions,
} from "./intake.js";

export const GOOGLE_PUBSUB_API_BASE_URL = "https://pubsub.googleapis.com" as const;
export const PUBSUB_SUBSCRIPTION_PATTERN = /^projects\/[^/\s]+\/subscriptions\/[^/\s]+$/u;

const BARE_SUBSCRIPTION_ID_PATTERN = /^[^/\s]+$/u;
const PUBSUB_CONSUME_PERMISSION = "pubsub.subscriptions.consume";
const DEFAULT_MAX_MESSAGES = 10;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

const PubSubTestIamPermissionsResponseSchema = z
  .object({
    permissions: z.array(z.string()).optional(),
  })
  .passthrough();

const PubSubPullResponseSchema = z
  .object({
    receivedMessages: z
      .array(
        z
          .object({
            ackId: z.string().min(1),
            message: z
              .object({
                data: z.string().optional(),
                messageId: z.string().optional(),
                publishTime: z.string().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export class GoogleChatPubSubError extends Error {
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
    this.name = "GoogleChatPubSubError";
    this.code = options?.code ?? "upstreamUnavailable";
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }
}

export interface CreateGoogleChatPubSubSourceOptions extends GoogleChatEventIntakeOptions {
  subscription: string;
  tokenSource: GoogleAccessTokenSource;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  maxMessages?: number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function normalizePubSubSubscriptionName(projectId: string, subscription: string): string {
  const trimmedSubscription = subscription.trim();
  const trimmedProjectId = projectId.trim();
  if (trimmedProjectId.length > 0 && BARE_SUBSCRIPTION_ID_PATTERN.test(trimmedSubscription)) {
    return `projects/${trimmedProjectId}/subscriptions/${trimmedSubscription}`;
  }
  return trimmedSubscription;
}

export function isValidPubSubSubscriptionName(subscription: string): boolean {
  return PUBSUB_SUBSCRIPTION_PATTERN.test(subscription.trim());
}

export async function verifyGoogleChatPubSubSubscription(options: {
  subscription: string;
  tokenSource: GoogleAccessTokenSource;
  projectId?: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}): Promise<void> {
  const subscription = normalizePubSubSubscriptionName(
    options.projectId ?? options.tokenSource.projectId,
    options.subscription,
  );
  if (!isValidPubSubSubscriptionName(subscription)) {
    throw new GoogleChatPubSubError(
      "Pub/Sub subscription must match projects/<project>/subscriptions/<subscription>.",
      { code: "invalidInput" },
    );
  }
  const fetchFn = options.fetch ?? fetch;
  const apiBaseUrl = trimTrailingSlashes(options.apiBaseUrl ?? GOOGLE_PUBSUB_API_BASE_URL);
  const token = await options.tokenSource.getAccessToken();
  let response: Response;
  try {
    response = await fetchFn(`${apiBaseUrl}/v1/${subscription}:testIamPermissions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ permissions: [PUBSUB_CONSUME_PERMISSION] }),
    });
  } catch (cause) {
    throw new GoogleChatPubSubError("Failed to reach Google Cloud Pub/Sub API.", {
      code: "network",
      cause,
    });
  }
  if (!response.ok) {
    throw await buildPubSubHttpError(response, "Google Cloud Pub/Sub subscription check failed");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new GoogleChatPubSubError(
      "Google Cloud Pub/Sub subscription check returned invalid JSON.",
      {
        code: "invalidResponse",
        cause,
      },
    );
  }
  const parsed = PubSubTestIamPermissionsResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new GoogleChatPubSubError(
      "Google Cloud Pub/Sub subscription check returned an invalid payload.",
      {
        code: "invalidResponse",
      },
    );
  }
  if (!(parsed.data.permissions ?? []).includes(PUBSUB_CONSUME_PERMISSION)) {
    throw new GoogleChatPubSubError(
      `Service account is missing ${PUBSUB_CONSUME_PERMISSION} on ${subscription}.`,
      {
        code: "permissionMissing",
        status: 403,
      },
    );
  }
}

export function createGoogleChatPubSubSource(
  options: CreateGoogleChatPubSubSourceOptions,
): TriggerSource {
  const handlers = new Set<TriggerHandler>();
  const fetchFn = options.fetch ?? fetch;
  const apiBaseUrl = trimTrailingSlashes(options.apiBaseUrl ?? GOOGLE_PUBSUB_API_BASE_URL);
  const subscription = normalizePubSubSubscriptionName(options.projectId, options.subscription);
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;

  let stopController: AbortController | undefined;
  let loopPromise: Promise<void> | undefined;

  const pullOnce = async (signal: AbortSignal): Promise<void> => {
    const token = await options.tokenSource.getAccessToken();
    const response = await fetchFn(`${apiBaseUrl}/v1/${subscription}:pull`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ maxMessages }),
      signal,
    });
    if (!response.ok) {
      throw await buildPubSubHttpError(response, "Google Cloud Pub/Sub pull failed");
    }

    const raw: unknown = await response.json();
    const parsed = PubSubPullResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GoogleChatPubSubError("Google Cloud Pub/Sub pull returned an invalid payload.", {
        code: "invalidResponse",
      });
    }

    const received = parsed.data.receivedMessages ?? [];
    if (received.length === 0) {
      return;
    }

    const ackIds: string[] = [];
    for (const entry of received) {
      const shouldAck = await processPubSubMessage(
        entry.message?.data,
        entry.message?.messageId,
        handlers,
        options,
      );
      if (shouldAck) {
        ackIds.push(entry.ackId);
      }
    }

    if (ackIds.length > 0 && !signal.aborted) {
      await acknowledgeMessages(
        fetchFn,
        apiBaseUrl,
        subscription,
        options.tokenSource,
        ackIds,
        signal,
      );
    }
  };

  const runLoop = async (signal: AbortSignal): Promise<void> => {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        await pullOnce(signal);
        attempt = 0;
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          return;
        }
        reportFailure(
          error,
          {
            operation: "google-chat.pubsub.pull",
            component: "triggers",
            provider: "google-chat",
          },
          { diagnostic: { subscription, projectId: options.projectId } },
        );
        const delayMs = computeBackoffMs(attempt, random());
        attempt += 1;
        await sleep(delayMs, signal);
      }
    }
  };

  return {
    async start(handler) {
      handlers.add(handler);
      if (stopController !== undefined) {
        return;
      }
      stopController = new AbortController();
      loopPromise = runLoop(stopController.signal);
    },
    async stop() {
      handlers.clear();
      const controller = stopController;
      const activeLoop = loopPromise;
      stopController = undefined;
      loopPromise = undefined;
      controller?.abort();
      if (activeLoop !== undefined) {
        await activeLoop;
      }
    },
  };
}

async function processPubSubMessage(
  encodedData: string | undefined,
  messageId: string | undefined,
  handlers: ReadonlySet<TriggerHandler>,
  options: GoogleChatEventIntakeOptions,
): Promise<boolean> {
  if (encodedData === undefined || encodedData.length === 0) {
    return true;
  }

  let payload: unknown;
  try {
    const jsonText = Buffer.from(encodedData, "base64").toString("utf8");
    payload = JSON.parse(jsonText);
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "google-chat.pubsub.decode",
        component: "triggers",
        provider: "google-chat",
      },
      { kind: "validation", diagnostic: { projectId: options.projectId } },
    );
    return true;
  }

  const signatureHash = createHash("sha256")
    .update(`pubsub:${messageId ?? encodedData}`)
    .digest("hex");

  try {
    await intakeGoogleChatEvent(payload, signatureHash, handlers, options);
    return true;
  } catch (error) {
    if (error instanceof GoogleChatEventIntakeValidationError) {
      reportFailure(
        error,
        {
          operation: "google-chat.pubsub.intake",
          component: "triggers",
          provider: "google-chat",
        },
        { kind: "validation", diagnostic: { projectId: options.projectId } },
      );
      return true;
    }
    reportFailure(
      error,
      {
        operation: "google-chat.pubsub.handoff",
        component: "triggers",
        provider: "google-chat",
      },
      { diagnostic: { projectId: options.projectId } },
    );
    return false;
  }
}

async function acknowledgeMessages(
  fetchFn: typeof fetch,
  apiBaseUrl: string,
  subscription: string,
  tokenSource: GoogleAccessTokenSource,
  ackIds: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const token = await tokenSource.getAccessToken();
  const response = await fetchFn(`${apiBaseUrl}/v1/${subscription}:acknowledge`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ackIds }),
    signal,
  });
  if (!response.ok) {
    throw await buildPubSubHttpError(response, "Google Cloud Pub/Sub acknowledge failed");
  }
}

async function buildPubSubHttpError(
  response: Response,
  prefix: string,
): Promise<GoogleChatPubSubError> {
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

  return new GoogleChatPubSubError(
    detail === undefined ? `${prefix} (HTTP ${String(response.status)}).` : `${prefix}: ${detail}`,
    {
      code: classifyPubSubHttpStatus(response.status),
      status: response.status,
    },
  );
}

function classifyPubSubHttpStatus(status: number): string {
  if (status === 401) return "credentialsRejected";
  if (status === 403) return "permissionMissing";
  if (status === 404) return "notFound";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "upstreamUnavailable";
  return "invalidInput";
}

function computeBackoffMs(attempt: number, randomValue: number): number {
  const exponent = Math.min(attempt, 5);
  const base = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** exponent);
  const jitter = Math.floor(base * 0.25 * Math.max(0, Math.min(1, randomValue)));
  return Math.min(MAX_BACKOFF_MS, base + jitter);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      finish();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/u, "");
}
