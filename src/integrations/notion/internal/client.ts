import { z } from "zod";
import type { Database, IntegrationConnectionRecord } from "../../../db/types.js";
import { IntegrationToolError } from "../../../integration-tools/http.js";
import {
  NOTION_API_BASE,
  NOTION_API_VERSION,
  NotionCredentialsSchema,
  type NotionConfig,
  type NotionCredentials,
} from "./contracts.js";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_CONCURRENCY_PER_CONNECTION = 3;
const PROACTIVE_REFRESH_SKEW_MS = 5 * 60_000;
const MAX_RETRY_AFTER_MS = 15_000;

export class NotionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

export class NotionReauthorizationError extends IntegrationToolError {
  constructor(
    message = "The Notion connection requires reauthorization. Reauthorize it in organization Integrations.",
  ) {
    super(message);
    this.name = "NotionReauthorizationError";
  }
}

const NotionErrorPayloadSchema = z
  .object({
    code: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
    additional_data: z
      .object({
        retry_guidance: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const NotionBotUserSchema = z
  .object({
    object: z.literal("user"),
    id: z.string().min(1),
    type: z.literal("bot"),
    name: z.string().nullable().optional(),
    bot: z
      .object({
        owner: z
          .object({
            type: z.string().min(1),
          })
          .passthrough(),
        workspace_id: z.string().min(1).optional(),
        workspace_name: z.string().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type NotionBotUser = z.infer<typeof NotionBotUserSchema>;

export const NotionOAuthTokenSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).nullable().optional(),
    expires_in: z.number().finite().positive().optional(),
    bot_id: z.string().min(1),
    workspace_id: z.string().min(1),
    workspace_name: z.string().nullable().optional(),
    owner: z
      .object({
        type: z.string().min(1),
        user: z
          .object({ id: z.string().min(1) })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type NotionOAuthToken = z.infer<typeof NotionOAuthTokenSchema>;

interface ConcurrencySlot {
  active: number;
  readonly waiters: Array<() => void>;
}

class ConnectionLimiter {
  private readonly slots = new Map<string, ConcurrencySlot>();

  constructor(private readonly maxConcurrent: number) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(key);
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  private async acquire(key: string): Promise<void> {
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = { active: 0, waiters: [] };
      this.slots.set(key, slot);
    }
    if (slot.active < this.maxConcurrent) {
      slot.active += 1;
      return;
    }
    const activeSlot = slot;
    await new Promise<void>((resolve) => {
      activeSlot.waiters.push(resolve);
    });
  }

  private release(key: string): void {
    const slot = this.slots.get(key);
    if (slot === undefined) return;
    const next = slot.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    slot.active -= 1;
    if (slot.active <= 0) this.slots.delete(key);
  }
}

export interface NotionClient {
  request(input: {
    connectionKey: string;
    token: string;
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
  }): Promise<unknown>;
}

export function createNotionClient(
  options: {
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): NotionClient {
  const request = options.fetch ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limiter = new ConnectionLimiter(MAX_CONCURRENCY_PER_CONNECTION);

  return {
    async request(input): Promise<unknown> {
      return limiter.run(input.connectionKey, async (): Promise<unknown> => {
        const url = input.path.startsWith("http") ? input.path : `${NOTION_API_BASE}${input.path}`;
        let retries = 0;

        while (true) {
          const response = await request(url, {
            method: input.method,
            headers: {
              authorization: `Bearer ${input.token}`,
              "Notion-Version": NOTION_API_VERSION,
              accept: "application/json",
              ...(input.body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
            signal: AbortSignal.timeout(timeoutMs),
            redirect: "error",
          });

          if (response.ok) {
            return await response.json();
          }

          const rawBody = await safeJson(response);
          const parsedError = NotionErrorPayloadSchema.safeParse(rawBody);
          const errorCode = parsedError.success ? parsedError.data.code : undefined;
          const errorMessage =
            (parsedError.success ? parsedError.data.message : undefined) ??
            `Notion API request failed (HTTP ${response.status})`;

          if (response.status === 429 || response.status === 529) {
            if (retries < MAX_RATE_LIMIT_RETRIES) {
              const delayMs = parseRetryAfterMs(response.headers.get("retry-after"), retries);
              retries += 1;
              await sleep(delayMs);
              continue;
            }
            throw new NotionApiError(response.status, errorCode, errorMessage, true);
          }

          if (response.status === 503) {
            const retryGuidance = parsedError.success
              ? parsedError.data.additional_data?.retry_guidance
              : undefined;
            const retryPermitted = isRetryGuidancePermitted(retryGuidance);
            if (retryPermitted && retries < MAX_RATE_LIMIT_RETRIES) {
              const delayMs = parseRetryAfterMs(response.headers.get("retry-after"), retries);
              retries += 1;
              await sleep(delayMs);
              continue;
            }
            throw new NotionApiError(response.status, errorCode, errorMessage, retryPermitted);
          }

          throw new NotionApiError(response.status, errorCode, errorMessage, false);
        }
      });
    },
  };
}

function isRetryGuidancePermitted(guidance: unknown): boolean {
  if (guidance === true) return true;
  if (typeof guidance === "string") {
    const normalized = guidance.toLowerCase();
    return normalized === "safe_to_retry" || normalized === "retry";
  }
  if (typeof guidance === "object" && guidance !== null) {
    const safeToRetry: unknown = Reflect.get(guidance, "safe_to_retry");
    const retryable: unknown = Reflect.get(guidance, "retryable");
    const action: unknown = Reflect.get(guidance, "action");
    return (
      safeToRetry === true || retryable === true || action === "retry" || action === "safe_to_retry"
    );
  }
  return false;
}

function parseRetryAfterMs(header: string | null, attempt: number): number {
  if (header !== null) {
    const trimmed = header.trim();
    if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
      return Math.min(Math.max(0, Math.round(Number(trimmed) * 1000)), MAX_RETRY_AFTER_MS);
    }
    const timestamp = Date.parse(trimmed);
    if (!Number.isNaN(timestamp)) {
      return Math.min(Math.max(0, timestamp - Date.now()), MAX_RETRY_AFTER_MS);
    }
  }
  return Math.min(500 * 2 ** attempt, MAX_RETRY_AFTER_MS);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

export async function fetchNotionMe(
  fetchImpl: typeof fetch,
  token: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetchImpl(`${NOTION_API_BASE}/users/me`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_API_VERSION,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
}

export async function exchangeNotionOAuthToken(input: {
  fetch: typeof fetch;
  clientId: string;
  clientSecret: string;
  body: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ response: Response; json: unknown }> {
  const response = await input.fetch(`${NOTION_API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: basicAuthHeader(input.clientId, input.clientSecret),
      "Notion-Version": NOTION_API_VERSION,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(input.body),
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    redirect: "error",
  });
  const json = await safeJson(response);
  return { response, json };
}

export async function revokeNotionOAuthToken(input: {
  fetch: typeof fetch;
  clientId: string;
  clientSecret: string;
  token: string;
  timeoutMs?: number;
}): Promise<void> {
  const response = await input.fetch(`${NOTION_API_BASE}/oauth/revoke`, {
    method: "POST",
    headers: {
      authorization: basicAuthHeader(input.clientId, input.clientSecret),
      "Notion-Version": NOTION_API_VERSION,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ token: input.token }),
    signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Notion revoke HTTP ${response.status}`);
  }
}

export function notionOAuthTokenNeedsRefresh(
  credentials: Extract<NotionCredentials, { mode: "oauth" }>,
  now: Date,
): boolean {
  if (credentials.accessTokenExpiresAt === undefined || credentials.accessTokenExpiresAt === null) {
    return false;
  }
  const expiresAtMs = Date.parse(credentials.accessTokenExpiresAt);
  if (Number.isNaN(expiresAtMs)) return false;
  return expiresAtMs <= now.getTime() + PROACTIVE_REFRESH_SKEW_MS;
}

export function notionConnectionRequiresReauthorization(
  record: IntegrationConnectionRecord,
  now: Date,
): boolean {
  if (record.status === "requires_reauthorization") return true;
  const parsed = NotionCredentialsSchema.safeParse(record.credentials);
  if (!parsed.success) return true;
  if (parsed.data.mode !== "oauth") return false;
  return (
    (parsed.data.refreshToken === undefined || parsed.data.refreshToken === null) &&
    notionOAuthTokenNeedsRefresh(parsed.data, now)
  );
}

/**
 * Resolves an organization's Notion connection and executes Notion API calls with proactive and
 * reactive refresh-on-401 serialized through `database.integrations.withRefreshLock`.
 */
export function createNotionConnectionExecutor(options: {
  database: Database;
  config: NotionConfig;
  identityId: string;
  fetch: typeof fetch;
  now: () => Date;
  client?: NotionClient;
}) {
  const client = options.client ?? createNotionClient({ fetch: options.fetch });

  async function resolveConnection(
    organizationId: string,
    slug: string,
  ): Promise<{ record: IntegrationConnectionRecord; credentials: NotionCredentials }> {
    const record = await options.database.integrations.findBySlug(organizationId, "notion", slug);
    if (
      record === undefined ||
      record.organizationId !== organizationId ||
      record.providerApplicationId !== options.identityId
    ) {
      throw new IntegrationToolError(
        "The integration connection is unavailable in this organization.",
      );
    }
    if (record.status === "requires_reauthorization") {
      throw new NotionReauthorizationError();
    }
    if (record.status === "suspended") {
      throw new IntegrationToolError("The Notion connection is suspended.");
    }
    const parsed = NotionCredentialsSchema.safeParse(record.credentials);
    if (!parsed.success) {
      throw new IntegrationToolError("The Notion connection credentials are malformed.");
    }
    return { record, credentials: parsed.data };
  }

  type RefreshOutcome =
    | { readonly ok: true; readonly accessToken: string }
    | { readonly ok: false; readonly error: Error };

  async function performTokenRefresh(
    oauthConfig: Extract<NotionConfig, { mode: "oauth" }>,
    creds: Extract<NotionCredentials, { mode: "oauth" }>,
    refreshToken: string,
    update: (patch: {
      credentials?: Readonly<Record<string, unknown>>;
      status?: "active" | "suspended" | "requires_reauthorization";
    }) => Promise<void>,
  ): Promise<RefreshOutcome> {
    const { response, json } = await exchangeNotionOAuthToken({
      fetch: options.fetch,
      clientId: oauthConfig.clientId,
      clientSecret: oauthConfig.clientSecret,
      body: { grant_type: "refresh_token", refresh_token: refreshToken },
    });

    if (!response.ok) {
      const errorBody = NotionErrorPayloadSchema.safeParse(json);
      const oauthError = errorBody.success ? errorBody.data.error : undefined;
      if (oauthError === "invalid_grant" || response.status === 401) {
        await update({ status: "requires_reauthorization" });
        return { ok: false, error: new NotionReauthorizationError() };
      }
      return {
        ok: false,
        error: new NotionApiError(
          response.status,
          errorBody.success ? errorBody.data.code : undefined,
          `Notion OAuth token refresh failed (HTTP ${response.status})`,
        ),
      };
    }

    const token = NotionOAuthTokenSchema.parse(json);
    const expiresAt =
      token.expires_in === undefined
        ? null
        : new Date(options.now().getTime() + token.expires_in * 1000).toISOString();
    const rotated: Extract<NotionCredentials, { mode: "oauth" }> = {
      mode: "oauth",
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? refreshToken,
      accessTokenExpiresAt: expiresAt,
      botId: token.bot_id,
      workspaceId: token.workspace_id,
      ...(creds.ownerUserId === undefined ? {} : { ownerUserId: creds.ownerUserId }),
    };
    await update({ credentials: rotated, status: "active" });
    return { ok: true, accessToken: rotated.accessToken };
  }

  async function refreshConnection(
    connectionId: string,
    failedAccessToken?: string,
  ): Promise<string> {
    if (options.config.mode !== "oauth") {
      throw new NotionReauthorizationError(
        "The Notion internal integration token was rejected. Replace credentials in Apps.",
      );
    }
    const oauthConfig = options.config;
    const outcome = await options.database.integrations.withRefreshLock<RefreshOutcome>(
      connectionId,
      async (current, update) => {
        if (current === undefined) {
          return {
            ok: false,
            error: new IntegrationToolError("The Notion connection is no longer available."),
          };
        }
        if (current.status === "requires_reauthorization") {
          return { ok: false, error: new NotionReauthorizationError() };
        }
        const parsed = NotionCredentialsSchema.safeParse(current.credentials);
        if (!parsed.success || parsed.data.mode !== "oauth") {
          return {
            ok: false,
            error: new IntegrationToolError("The Notion connection credentials are malformed."),
          };
        }
        const creds = parsed.data;
        if (
          failedAccessToken !== undefined &&
          creds.accessToken !== failedAccessToken &&
          !notionOAuthTokenNeedsRefresh(creds, options.now())
        ) {
          return { ok: true, accessToken: creds.accessToken };
        }
        if (creds.refreshToken === undefined || creds.refreshToken === null) {
          await update({ status: "requires_reauthorization" });
          return { ok: false, error: new NotionReauthorizationError() };
        }
        return performTokenRefresh(oauthConfig, creds, creds.refreshToken, update);
      },
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.accessToken;
  }

  return {
    async request(input: {
      organizationId: string;
      connectionSlug: string;
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      path: string;
      body?: unknown;
    }): Promise<unknown> {
      const { record, credentials } = await resolveConnection(
        input.organizationId,
        input.connectionSlug,
      );
      let token = credentials.accessToken;
      if (
        credentials.mode === "oauth" &&
        notionOAuthTokenNeedsRefresh(credentials, options.now())
      ) {
        token = await refreshConnection(record.id);
      }
      try {
        return await client.request({
          connectionKey: record.id,
          token,
          method: input.method,
          path: input.path,
          body: input.body,
        });
      } catch (error) {
        if (
          error instanceof NotionApiError &&
          error.status === 401 &&
          credentials.mode === "oauth"
        ) {
          const freshToken = await refreshConnection(record.id, token);
          return client.request({
            connectionKey: record.id,
            token: freshToken,
            method: input.method,
            path: input.path,
            body: input.body,
          });
        }
        throw error;
      }
    },
  };
}
