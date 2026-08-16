import { WebSocket, type RawData } from "ws";
import { z } from "zod";
import { ProviderVerificationError } from "../../provider-applications/index.js";
import { SLACK_REQUIRED_BOT_SCOPES } from "./client.js";

const SocketOpenSchema = z
  .object({ ok: z.boolean(), error: z.string().optional(), url: z.string().url().optional() })
  .passthrough();
const SocketHelloSchema = z
  .object({
    type: z.literal("hello"),
    connection_info: z.object({ app_id: z.string().min(1) }),
  })
  .passthrough();

const AuthTestSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    team_id: z.string().min(1).optional(),
    team: z.string().min(1).optional(),
    user_id: z.string().min(1).optional(),
    bot_id: z.string().min(1).optional(),
  })
  .passthrough();
const BotInfoSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
    bot: z
      .object({ id: z.string().min(1), app_id: z.string().min(1), user_id: z.string().min(1) })
      .optional(),
  })
  .passthrough();

export interface VerifiedSlackSocketInstallation {
  appId: string;
  teamId: string;
  teamName: string;
  botId: string;
  botUserId: string;
  botAccessToken: string;
  scopes: string[];
}

export interface SlackSocketInstallationVerifier {
  verify(appToken: string, botToken: string): Promise<VerifiedSlackSocketInstallation>;
}

export function createSlackSocketInstallationVerifier(
  options: {
    fetch?: typeof fetch;
    webSocket?: (url: string) => WebSocket;
    apiBaseUrl?: string;
    timeoutMs?: number;
  } = {},
): SlackSocketInstallationVerifier {
  const request = options.fetch ?? fetch;
  const openSocket = options.webSocket ?? ((url: string) => new WebSocket(url));
  const api = options.apiBaseUrl ?? "https://slack.com/api";
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    async verify(appToken, botToken) {
      const [appId, bot] = await Promise.all([
        verifyAppToken(appToken, request, openSocket, `${api}/apps.connections.open`, timeoutMs),
        verifyBotToken(botToken, request, api, timeoutMs),
      ]);
      const info = await slackJson(
        request,
        `${api}/bots.info?${new URLSearchParams({ bot: bot.botId })}`,
        { headers: { authorization: `Bearer ${botToken}` } },
        BotInfoSchema,
        timeoutMs,
      );
      if (!info.ok || info.bot === undefined) {
        throw verificationError(info.error, "botToken");
      }
      if (
        info.bot.app_id !== appId ||
        info.bot.user_id !== bot.botUserId ||
        info.bot.id !== bot.botId
      ) {
        throw new ProviderVerificationError("credentialsRejected", undefined, {
          subject: "identityMismatch",
        });
      }
      return { appId, ...bot, botAccessToken: botToken };
    },
  };
}

async function verifyAppToken(
  appToken: string,
  request: typeof fetch,
  openSocket: (url: string) => WebSocket,
  url: string,
  timeoutMs: number,
): Promise<string> {
  const opened = await slackJson(
    request,
    url,
    { method: "POST", headers: { authorization: `Bearer ${appToken}` } },
    SocketOpenSchema,
    timeoutMs,
  );
  if (!opened.ok || opened.url === undefined) throw verificationError(opened.error, "appToken");
  const socket = openSocket(opened.url);
  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProviderVerificationError("timeout")), timeoutMs);
      socket.once("message", (data) => {
        clearTimeout(timer);
        const hello = SocketHelloSchema.safeParse(safeParseJson(rawDataText(data)));
        if (!hello.success) reject(new ProviderVerificationError("invalidResponse"));
        else resolve(hello.data.connection_info.app_id);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new ProviderVerificationError("network"));
      });
    });
  } finally {
    socket.close(1000, "verified");
  }
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

async function verifyBotToken(
  botToken: string,
  request: typeof fetch,
  api: string,
  timeoutMs: number,
): Promise<Omit<VerifiedSlackSocketInstallation, "appId" | "botAccessToken">> {
  const response = await fixedRequest(
    request,
    `${api}/auth.test`,
    { headers: { authorization: `Bearer ${botToken}` } },
    timeoutMs,
  );
  const scopes = parseScopes(response.headers.get("x-oauth-scopes"));
  const body = AuthTestSchema.safeParse(await response.json().catch(() => undefined));
  if (!body.success) throw new ProviderVerificationError("invalidResponse", response.status);
  if (!body.data.ok) throw verificationError(body.data.error, "botToken", response.status);
  if (
    body.data.team_id === undefined ||
    body.data.team === undefined ||
    body.data.user_id === undefined ||
    body.data.bot_id === undefined
  ) {
    throw new ProviderVerificationError("invalidResponse", response.status);
  }
  const missing = SLACK_REQUIRED_BOT_SCOPES.some((scope) => !scopes.includes(scope));
  if (missing) {
    throw new ProviderVerificationError("permissionMissing", response.status, {
      subject: "botToken",
    });
  }
  return {
    teamId: body.data.team_id,
    teamName: body.data.team,
    botUserId: body.data.user_id,
    botId: body.data.bot_id,
    scopes,
  };
}

async function slackJson<T>(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  timeoutMs: number,
): Promise<T> {
  const response = await fixedRequest(request, url, init, timeoutMs);
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new ProviderVerificationError("invalidResponse", response.status);
  return parsed.data;
}

async function fixedRequest(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await request(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ProviderVerificationError(
      error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network",
    );
  }
  if (response.status === 429) throw new ProviderVerificationError("rateLimited", 429);
  if (response.status >= 500)
    throw new ProviderVerificationError("upstreamUnavailable", response.status);
  if (!response.ok) throw new ProviderVerificationError("credentialsRejected", response.status);
  return response;
}

function verificationError(
  error: string | undefined,
  subject: "appToken" | "botToken",
  status?: number,
): ProviderVerificationError {
  const permission = error === "missing_scope";
  return new ProviderVerificationError(
    permission ? "permissionMissing" : "credentialsRejected",
    status,
    {
      subject,
    },
  );
}

function parseScopes(value: string | null): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
