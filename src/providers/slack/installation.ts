import { WebSocket, type RawData } from "ws";
import { z } from "zod";
import { discardClientResponse } from "../../http/client-response.js";
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
      const transaction = new SlackVerificationTransaction(request, openSocket, timeoutMs);
      return transaction.run(async () => {
        // Keep the first provider failure authoritative if cleanup aborts the transaction.
        const appId = await verifyAppToken(appToken, transaction, `${api}/apps.connections.open`);
        const bot = await verifyBotToken(botToken, transaction, api);
        const info = await transaction.json(
          `${api}/bots.info?${new URLSearchParams({ bot: bot.botId })}`,
          { headers: { authorization: `Bearer ${botToken}` } },
          BotInfoSchema,
        );
        if (!info.body.ok || info.body.bot === undefined) {
          throw verificationError(info.body.error, "botToken");
        }
        if (
          info.body.bot.app_id !== appId ||
          info.body.bot.user_id !== bot.botUserId ||
          info.body.bot.id !== bot.botId
        ) {
          throw new ProviderVerificationError("credentialsRejected", undefined, {
            subject: "identityMismatch",
          });
        }
        return { appId, ...bot, botAccessToken: botToken };
      });
    },
  };
}

async function verifyAppToken(
  appToken: string,
  transaction: SlackVerificationTransaction,
  url: string,
): Promise<string> {
  const opened = await transaction.json(
    url,
    { method: "POST", headers: { authorization: `Bearer ${appToken}` } },
    SocketOpenSchema,
  );
  if (!opened.body.ok || opened.body.url === undefined)
    throw verificationError(opened.body.error, "appToken");
  return transaction.verifySocketIdentity(opened.body.url);
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

async function verifyBotToken(
  botToken: string,
  transaction: SlackVerificationTransaction,
  api: string,
): Promise<Omit<VerifiedSlackSocketInstallation, "appId" | "botAccessToken">> {
  const response = await transaction.json(
    `${api}/auth.test`,
    { headers: { authorization: `Bearer ${botToken}` } },
    AuthTestSchema,
  );
  const scopes = parseScopes(response.headers.get("x-oauth-scopes"));
  const body = response.body;
  if (!body.ok) throw verificationError(body.error, "botToken", response.status);
  if (
    body.team_id === undefined ||
    body.team === undefined ||
    body.user_id === undefined ||
    body.bot_id === undefined
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
    teamId: body.team_id,
    teamName: body.team,
    botUserId: body.user_id,
    botId: body.bot_id,
    scopes,
  };
}

class SlackVerificationTransaction {
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly sockets = new Map<WebSocket, Promise<void>>();
  private timedOut = false;

  constructor(
    private readonly request: typeof fetch,
    private readonly openSocket: (url: string) => WebSocket,
    private readonly timeoutMs: number,
  ) {
    this.deadline = Date.now() + timeoutMs;
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort(new ProviderVerificationError("timeout"));
    }, timeoutMs);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      await this.close();
    }
  }

  async json<T>(
    url: string,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): Promise<{ body: T; headers: Headers; status: number }> {
    let response: Response;
    try {
      response = await this.request(url, { ...init, signal: this.controller.signal });
    } catch (error) {
      throw this.requestFailure(error);
    }
    const statusFailure = responseStatusFailure(response.status);
    if (statusFailure !== undefined) {
      await discardClientResponse(response, this.controller, statusFailure);
      throw statusFailure;
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      if (this.controller.signal.aborted) throw this.requestFailure(error);
      throw new ProviderVerificationError("invalidResponse", response.status);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ProviderVerificationError("invalidResponse", response.status);
    return { body: parsed.data, headers: response.headers, status: response.status };
  }

  async verifySocketIdentity(url: string): Promise<string> {
    let socket: WebSocket;
    try {
      socket = this.openSocket(url);
    } catch {
      throw new ProviderVerificationError("network");
    }
    const ownSocketError = () => undefined;
    socket.on("error", ownSocketError);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    this.sockets.set(socket, closed);
    try {
      const appId = await this.waitForHello(socket);
      await this.closeSocket(socket);
      return appId;
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) await this.closeSocket(socket);
      socket.off("error", ownSocketError);
      this.sockets.delete(socket);
    }
  }

  private waitForHello(socket: WebSocket): Promise<string> {
    return new Promise((resolve, reject) => {
      const settle = (result: { appId: string } | { error: ProviderVerificationError }) => {
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
        this.controller.signal.removeEventListener("abort", onAbort);
        if ("error" in result) reject(result.error);
        else resolve(result.appId);
      };
      const onMessage = (data: RawData) => {
        const hello = SocketHelloSchema.safeParse(safeParseJson(rawDataText(data)));
        if (!hello.success) settle({ error: new ProviderVerificationError("invalidResponse") });
        else settle({ appId: hello.data.connection_info.app_id });
      };
      const onError = () => settle({ error: new ProviderVerificationError("network") });
      const onClose = () => settle({ error: new ProviderVerificationError("network") });
      const onAbort = () => settle({ error: this.requestFailure(this.controller.signal.reason) });
      socket.once("message", onMessage);
      socket.once("error", onError);
      socket.once("close", onClose);
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (this.controller.signal.aborted) onAbort();
    });
  }

  private async closeSocket(socket: WebSocket): Promise<void> {
    const closed = this.sockets.get(socket);
    if (closed === undefined || socketIsClosed(socket)) return;
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "verified");
    const cleanCloseMs = Math.min(this.remainingMs(), Math.max(10, this.timeoutMs / 4));
    if (cleanCloseMs > 0 && (await settlesWithin(closed, cleanCloseMs))) return;
    if (!socketIsClosed(socket)) socket.terminate();
    await closed;
  }

  private async close(): Promise<void> {
    try {
      if (!this.controller.signal.aborted) {
        this.controller.abort(new Error("Slack setup verification finished"));
      }
      await Promise.all(Array.from(this.sockets, ([socket]) => this.closeSocket(socket)));
    } finally {
      clearTimeout(this.timer);
    }
  }

  private remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  private requestFailure(error: unknown): ProviderVerificationError {
    if (error instanceof ProviderVerificationError) return error;
    if (this.timedOut) return new ProviderVerificationError("timeout");
    return new ProviderVerificationError("network");
  }
}

function responseStatusFailure(status: number): ProviderVerificationError | undefined {
  if (status === 429) return new ProviderVerificationError("rateLimited", status);
  if (status >= 500) return new ProviderVerificationError("upstreamUnavailable", status);
  if (status < 200 || status >= 300)
    return new ProviderVerificationError("credentialsRejected", status);
  return undefined;
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function socketIsClosed(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.CLOSED;
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
