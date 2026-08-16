import { createHash } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { reportFailure } from "../../../../failures/index.js";
import { logger } from "../../../../logger.js";
import type { TriggerHandler, TriggerSource } from "../../../index.js";
import {
  intakeSlackEvent,
  SlackEventIntakeValidationError,
  type SlackEventIntakeOptions,
} from "./intake.js";
import {
  slackSocketAck,
  SlackSocketDisconnectSchema,
  SlackSocketEnvelopeSchema,
  SlackSocketHelloSchema,
  SlackSocketOpenResponseSchema,
} from "./socket-protocol.js";

const MAX_FRAME_BYTES = 1_048_576;
const HELLO_TIMEOUT_MS = 10_000;

export type SlackDeliveryStatus =
  | { state: "connecting" | "reconnecting"; since: Date }
  | { state: "connected"; since: Date; connectionCount: number; connectionLimitReached?: boolean }
  | {
      state: "actionNeeded";
      reason: "appTokenRejected" | "socketModeOff" | "connectionLimit";
      since: Date;
    }
  | { state: "rateLimited"; teamId: string; since: Date }
  | { state: "stopped" };

export interface SlackSocketSource extends TriggerSource {
  ready(): Promise<void>;
  status(): SlackDeliveryStatus;
  retry(): Promise<void>;
}

export interface SlackSocketSourceOptions extends SlackEventIntakeOptions {
  appToken: string;
  configurationVersion: number;
  apiUrl?: string;
  fetch?: typeof fetch;
  webSocket?: (url: string) => WebSocket;
  now?: () => Date;
  random?: () => number;
}

export function createSlackSocketSource(options: SlackSocketSourceOptions): SlackSocketSource {
  const handlers = new Set<TriggerHandler>();
  const request = options.fetch ?? fetch;
  const connectWebSocket = options.webSocket ?? ((url: string) => new WebSocket(url));
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  let deliveryStatus: SlackDeliveryStatus = { state: "stopped" };
  let stopped = true;
  const sockets = new Set<WebSocket>();
  let supervisor: Promise<void> | undefined;
  let abort: AbortController | undefined;
  let retryWake: (() => void) | undefined;
  let refreshPromise: Promise<void> | undefined;
  let replacementClose: Promise<string> | undefined;
  let readyPromise: Promise<void> = Promise.resolve();
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: unknown) => void) | undefined;
  let activeSocketUrl: string | undefined;
  const sensitiveValues = () => [
    options.appToken,
    ...(options.apiUrl === undefined ? [] : [options.apiUrl]),
    ...(activeSocketUrl === undefined ? [] : [activeSocketUrl]),
  ];

  const run = async (): Promise<void> => {
    let attempt = 0;
    let minimumDelay = 0;
    for (;;) {
      if (stopped) return;
      deliveryStatus = { state: attempt === 0 ? "connecting" : "reconnecting", since: now() };
      try {
        const connection = await connectOnce();
        attempt = 0;
        let reason = await connection.closed;
        while (reason === "replaced" && replacementClose !== undefined) {
          const next = replacementClose;
          replacementClose = undefined;
          reason = await next;
        }
        if (stopped) return;
        if (reason === "link_disabled") {
          deliveryStatus = { state: "actionNeeded", reason: "socketModeOff", since: now() };
          reportFailure(
            Object.assign(new Error("Slack disabled Socket Mode for this app"), {
              code: "socket_mode_off",
            }),
            { operation: "slack.socket.disconnect", component: "triggers", provider: "slack" },
            { kind: "validation", scrubValues: sensitiveValues() },
          );
          return;
        }
      } catch (error) {
        if (stopped || abort?.signal.aborted === true) return;
        const terminal = classifyAuthentication(error);
        reportFailure(
          error,
          {
            operation: terminal ? "slack.socket.authenticate" : "slack.socket.connect",
            component: "triggers",
            provider: "slack",
          },
          {
            kind: terminal ? "authentication" : "network",
            scrubValues: sensitiveValues(),
          },
        );
        if (terminal) {
          deliveryStatus = { state: "actionNeeded", reason: "appTokenRejected", since: now() };
          rejectReady?.(error);
          return;
        }
        const retryAfter = Number(
          error !== null && typeof error === "object" ? Reflect.get(error, "retryAfter") : 0,
        );
        minimumDelay = Number.isFinite(retryAfter) ? retryAfter * 1_000 : 0;
      }
      attempt += 1;
      const reconnectDelay = Math.max(
        minimumDelay,
        Math.floor(random() * Math.min(30_000, 1_000 * 2 ** (attempt - 1))),
      );
      minimumDelay = 0;
      logger.info(
        {
          provider: "slack",
          operation: "slack.socket.reconnect",
          attempt,
          delayMs: reconnectDelay,
        },
        "Slack Socket Mode reconnect scheduled",
      );
      await waitForRetry(reconnectDelay);
    }
  };

  const connectOnce = async (): Promise<{ closed: Promise<string> }> => {
    abort = new AbortController();
    const response = await request(
      options.apiUrl ?? "https://slack.com/api/apps.connections.open",
      {
        method: "POST",
        headers: { authorization: `Bearer ${options.appToken}` },
        signal: abort.signal,
      },
    );
    const retryAfter = Number(response.headers.get("retry-after"));
    if (response.status === 429) {
      const error = Object.assign(new Error("Slack rate limited Socket Mode authentication"), {
        slackError: "ratelimited",
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
      });
      throw error;
    }
    const body: unknown = await response.json().catch(() => undefined);
    const opened = SlackSocketOpenResponseSchema.safeParse(body);
    if (!response.ok || !opened.success || !opened.data.ok || opened.data.url === undefined) {
      throw Object.assign(new Error("Slack rejected Socket Mode authentication"), {
        slackError: opened.success ? opened.data.error : "invalid_response",
        status: response.status,
      });
    }
    const wsUrl = new URL(opened.data.url);
    if (wsUrl.protocol !== "wss:" && wsUrl.protocol !== "ws:") {
      throw new Error("Slack returned an invalid Socket Mode URL");
    }
    activeSocketUrl = wsUrl.toString();
    const openedSocket = connectWebSocket(wsUrl.toString());
    sockets.add(openedSocket);
    openedSocket.once("close", () => sockets.delete(openedSocket));
    return awaitSocket(openedSocket);
  };

  const supervise = () =>
    run().catch((error: unknown) => {
      reportFailure(
        error,
        { operation: "slack.socket.loop", component: "triggers", provider: "slack" },
        { scrubValues: sensitiveValues() },
      );
      rejectReady?.(error);
    });

  const awaitSocket = (openedSocket: WebSocket): Promise<{ closed: Promise<string> }> =>
    new Promise((resolve, reject) => {
      let hello = false;
      let queue = Promise.resolve();
      const timer = setTimeout(() => {
        openedSocket.terminate();
        reject(new Error("Slack Socket Mode hello timed out"));
      }, HELLO_TIMEOUT_MS);

      openedSocket.on("message", (data, binary) => {
        const byteLength = rawDataByteLength(data);
        if (binary || byteLength > MAX_FRAME_BYTES) {
          reportParseFailure(byteLength, options.appToken);
          return;
        }
        queue = queue
          .then(() => handleFrame(rawDataText(data), openedSocket, hello))
          .then((result) => {
            if (result?.hello === true && !hello) {
              hello = true;
              clearTimeout(timer);
              deliveryStatus = {
                state: "connected",
                since: now(),
                connectionCount: result.connectionCount,
                ...(result.connectionCount >= 10 ? { connectionLimitReached: true } : {}),
              };
              logger.info(
                {
                  provider: "slack",
                  operation: "slack.socket.connect",
                  appId: options.appId,
                  configurationVersion: options.configurationVersion,
                  connectionCount: result.connectionCount,
                },
                "Slack Socket Mode connected",
              );
              resolveReady?.();
              resolve({ closed: closeResult(openedSocket) });
            }
            return undefined;
          })
          .catch((error: unknown) => {
            reportFailure(
              error,
              { operation: "slack.socket.handoff", component: "triggers", provider: "slack" },
              { scrubValues: sensitiveValues() },
            );
            openedSocket.close();
          });
      });
      openedSocket.once("error", (error) => {
        if (!hello) {
          clearTimeout(timer);
          reject(error);
        }
      });
      openedSocket.once("close", () => {
        if (!hello) {
          clearTimeout(timer);
          reject(new Error("Slack Socket Mode closed before hello"));
        }
      });
    });

  const handleFrame = async (
    frame: string,
    target: WebSocket,
    helloReceived: boolean,
  ): Promise<{ hello: true; connectionCount: number } | undefined> => {
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      reportParseFailure(Buffer.byteLength(frame), options.appToken);
      return undefined;
    }
    if (!helloReceived) {
      const parsed = SlackSocketHelloSchema.safeParse(value);
      if (!parsed.success || parsed.data.connection_info.app_id !== options.appId) {
        throw new Error("Slack Socket Mode hello identified a different app");
      }
      return { hello: true, connectionCount: parsed.data.num_connections ?? 1 };
    }
    const disconnect = SlackSocketDisconnectSchema.safeParse(value);
    if (disconnect.success) {
      if (disconnect.data.reason === "link_disabled") target.close(1000, "link_disabled");
      else refreshConnection(target, disconnect.data.reason);
      return undefined;
    }
    const envelope = SlackSocketEnvelopeSchema.safeParse(value);
    if (!envelope.success) {
      reportParseFailure(Buffer.byteLength(frame), options.appToken);
      const envelopeId = boundedEnvelopeId(value);
      if (envelopeId !== undefined) await sendAck(target, envelopeId, options.appToken);
      return undefined;
    }
    if (envelope.data.type === "events_api") {
      const payloadType = objectString(envelope.data.payload, "type");
      if (payloadType === "app_rate_limited") {
        const teamId = objectString(envelope.data.payload, "team_id") ?? "workspace";
        deliveryStatus = { state: "rateLimited", teamId, since: now() };
        reportFailure(
          Object.assign(new Error("Slack is rate limiting Events API delivery"), {
            code: "app_rate_limited",
          }),
          {
            operation: "slack.socket.event.rate_limited",
            component: "triggers",
            provider: "slack",
          },
          { kind: "rateLimited", scrubValues: sensitiveValues() },
        );
        await sendAck(target, envelope.data.envelope_id, options.appToken);
        return undefined;
      }
      const signatureHash = createHash("sha256").update(envelope.data.envelope_id).digest("hex");
      try {
        await intakeSlackEvent(envelope.data.payload, signatureHash, handlers, options);
      } catch (error) {
        if (!(error instanceof SlackEventIntakeValidationError)) throw error;
        reportParseFailure(Buffer.byteLength(frame), options.appToken);
      }
    }
    await sendAck(target, envelope.data.envelope_id, options.appToken);
    return undefined;
  };

  return {
    async start(handler) {
      handlers.add(handler);
      if (!stopped) return readyPromise;
      stopped = false;
      readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      supervisor = supervise();
      return readyPromise;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      handlers.clear();
      abort?.abort();
      retryWake?.();
      const closing = [...sockets];
      for (const openSocket of closing) openSocket.close(1000, "shutdown");
      await Promise.race([Promise.all(closing.map(closeResult)), delay(1_000)]);
      for (const openSocket of closing) {
        if (openSocket.readyState !== WebSocket.CLOSED) openSocket.terminate();
      }
      await refreshPromise;
      await supervisor;
      deliveryStatus = { state: "stopped" };
      logger.info(
        { provider: "slack", operation: "slack.socket.shutdown" },
        "Slack Socket Mode stopped",
      );
    },
    ready: () => readyPromise,
    status: () => deliveryStatus,
    async retry() {
      if (stopped) return;
      retryWake?.();
      if (supervisor === undefined || deliveryStatus.state === "actionNeeded") {
        supervisor = supervise();
      }
      await Promise.resolve();
    },
  };

  function waitForRetry(milliseconds: number): Promise<void> {
    const scheduled = scheduledReconnect(milliseconds);
    const manual = new Promise<void>((resolve) => {
      retryWake = resolve;
    });
    return Promise.race([scheduled, manual]).finally(() => {
      retryWake = undefined;
    });
  }

  function refreshConnection(previous: WebSocket, reason: "warning" | "refresh_requested"): void {
    if (stopped || refreshPromise !== undefined) return;
    logger.info(
      { provider: "slack", operation: "slack.socket.disconnect", reason },
      "Slack Socket Mode connection refresh requested",
    );
    refreshPromise = connectOnce()
      .then((connection) => {
        replacementClose = connection.closed;
        previous.close(1000, "replaced");
        return undefined;
      })
      .catch((error: unknown) => {
        if (stopped) return;
        reportFailure(
          error,
          { operation: "slack.socket.connect", component: "triggers", provider: "slack" },
          { kind: "network", scrubValues: sensitiveValues() },
        );
      })
      .finally(() => {
        refreshPromise = undefined;
      });
  }
}

function closeResult(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once("close", (_code, reason) => resolve(reason.toString()));
  });
}

async function sendAck(socket: WebSocket, envelopeId: string, appToken: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      socket.send(slackSocketAck(envelopeId), (error) => {
        if (error == null) {
          resolve();
          return;
        }
        reject(error);
      });
    });
  } catch (error) {
    reportFailure(
      error,
      { operation: "slack.socket.ack", component: "triggers", provider: "slack" },
      { scrubValues: [appToken] },
    );
    socket.close();
  }
}

function classifyAuthentication(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const slackError: unknown = Reflect.get(error, "slackError");
  return [
    "invalid_auth",
    "not_authed",
    "not_allowed_token_type",
    "missing_scope",
    "token_expired",
    "token_revoked",
  ].includes(String(slackError));
}

function reportParseFailure(byteCount: number, appToken: string): void {
  reportFailure(
    Object.assign(new Error("Slack Socket Mode envelope was invalid"), { frameBytes: byteCount }),
    {
      operation: "slack.socket.envelope.parse",
      component: "triggers",
      provider: "slack",
    },
    { kind: "validation", scrubValues: [appToken] },
  );
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0);
  return data.byteLength;
}

function boundedEnvelopeId(value: unknown): string | undefined {
  const id = objectString(value, "envelope_id");
  return id !== undefined && id.length <= 255 ? id : undefined;
}

function objectString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate: unknown = Reflect.get(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function scheduledReconnect(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds).unref();
  });
}
