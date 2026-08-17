import { createHash } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { reportFailure } from "../../../../failures/index.js";
import { logger } from "../../../../logger.js";
import { admitTriggerHandler, type TriggerHandler, type TriggerSource } from "../../../index.js";
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
  type SlackSocketEnvelope,
} from "./socket-protocol.js";

const MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_READINESS_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_HELLO_TIMEOUT_MS = 3_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

interface SocketCloseResult {
  code: number;
  reason: string;
  error?: unknown;
  failureOwner: boolean;
}

class SlackSocketProtocolError extends Error {
  constructor(
    message: string,
    readonly reason: "invalidFrame" | "appIdentityMismatch",
    readonly frameBytes?: number,
  ) {
    super(message);
    this.name = "SlackSocketProtocolError";
  }
}

class SlackSocketReadinessError extends Error {
  constructor() {
    super("Slack Socket Mode did not become ready before the startup deadline");
    this.name = "SlackSocketReadinessError";
  }
}

type SlackSocketActionReason =
  | "appTokenRejected"
  | "appAccessDenied"
  | "appIdentityMismatch"
  | "socketModeOff"
  | "connectionLimit";

class SlackSocketOpenError extends Error {
  constructor(
    readonly slackError: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super("Slack rejected Socket Mode authentication");
    this.name = "SlackSocketOpenError";
  }
}

export type SlackDeliveryStatus =
  | { state: "connecting" | "reconnecting"; since: Date }
  | {
      state: "connected";
      since: Date;
      connectionCount: number;
      connectionLimitReached?: boolean;
      delayedWorkspaces?: readonly { teamId: string; name?: string; since: Date }[];
    }
  | {
      state: "actionNeeded";
      reason: SlackSocketActionReason;
      since: Date;
    }
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
  readinessTimeoutMs?: number;
  connectTimeoutMs?: number;
  helloTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export function createSlackSocketSource(options: SlackSocketSourceOptions): SlackSocketSource {
  const handlers = new Set<TriggerHandler>();
  const request = options.fetch ?? fetch;
  const connectWebSocket = options.webSocket ?? ((url: string) => new WebSocket(url));
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let deliveryStatus: SlackDeliveryStatus = { state: "stopped" };
  let stopped = true;
  let admitting = false;
  let transportClosed = true;
  const sockets = new Set<WebSocket>();
  const connectionAttempts = new Set<AbortController>();
  const admissions = new Set<Promise<void>>();
  let supervisor: Promise<void> | undefined;
  let retryWake: (() => void) | undefined;
  let refreshPromise: Promise<void> | undefined;
  let replacementClose: Promise<SocketCloseResult> | undefined;
  let readyPromise: Promise<void> = Promise.resolve();
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: unknown) => void) | undefined;
  let readinessTimer: NodeJS.Timeout | undefined;
  let readinessSettled = true;
  let connectionFailureEpisode: string | undefined;
  let connectedStatus: Extract<SlackDeliveryStatus, { state: "connected" }> | undefined;
  const delayedWorkspaces = new Map<string, Date>();
  let activeSocketUrl: string | undefined;
  const ownedSocketFailures = new WeakSet<WebSocket>();
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
      deliveryStatus = {
        state: attempt === 0 ? "connecting" : "reconnecting",
        since: now(),
      };
      try {
        const connection = await connectOnce();
        attempt = 0;
        let close = await connection.closed;
        while (close.reason === "replaced" && replacementClose !== undefined) {
          const next = replacementClose;
          replacementClose = undefined;
          close = await next;
        }
        if (stopped) return;
        if (close.reason === "link_disabled") {
          deliveryStatus = {
            state: "actionNeeded",
            reason: "socketModeOff",
            since: now(),
          };
          reportFailure(
            Object.assign(new Error("Slack disabled Socket Mode for this app"), {
              code: "socket_mode_off",
            }),
            {
              operation: "slack.socket.disconnect",
              component: "triggers",
              provider: "slack",
            },
            { kind: "validation", scrubValues: sensitiveValues() },
          );
          return;
        }
        if (close.failureOwner) reportAbnormalClose(close);
      } catch (error) {
        if (stopped) return;
        const action = connectionAction(error);
        reportConnectionFailure(error, action);
        if (action !== undefined) {
          deliveryStatus = {
            state: "actionNeeded",
            reason: action,
            since: now(),
          };
          settleReadiness(error);
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

  const connectOnce = async (): Promise<{ closed: Promise<SocketCloseResult> }> => {
    const controller = new AbortController();
    connectionAttempts.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new Error("Slack Socket Mode connection request timed out")),
      connectTimeoutMs,
    );
    try {
      const response = await request(
        options.apiUrl ?? "https://slack.com/api/apps.connections.open",
        {
          method: "POST",
          headers: { authorization: `Bearer ${options.appToken}` },
          signal: controller.signal,
        },
      );
      const retryAfter = Number(response.headers.get("retry-after"));
      if (response.status === 429) {
        throw new SlackSocketOpenError(
          "ratelimited",
          response.status,
          Number.isFinite(retryAfter) ? retryAfter : undefined,
        );
      }
      const body: unknown = await response.json().catch((error: unknown) => {
        if (controller.signal.aborted) throw error;
        return undefined;
      });
      const opened = SlackSocketOpenResponseSchema.safeParse(body);
      if (!response.ok || !opened.success || !opened.data.ok || opened.data.url === undefined) {
        throw new SlackSocketOpenError(
          opened.success ? (opened.data.error ?? "invalid_response") : "invalid_response",
          response.status,
        );
      }
      const wsUrl = new URL(opened.data.url);
      if (wsUrl.protocol !== "wss:" && wsUrl.protocol !== "ws:") {
        throw new Error("Slack returned an invalid Socket Mode URL");
      }
      activeSocketUrl = wsUrl.toString();
      if (stopped) throw new Error("Slack Socket Mode stopped during connection");
      const openedSocket = connectWebSocket(wsUrl.toString());
      sockets.add(openedSocket);
      openedSocket.once("close", () => sockets.delete(openedSocket));
      return awaitSocket(openedSocket);
    } catch (error) {
      if (controller.signal.aborted && !stopped) {
        throw controller.signal.reason instanceof Error ? controller.signal.reason : error;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      connectionAttempts.delete(controller);
    }
  };

  const supervise = () =>
    run().catch((error: unknown) => {
      reportFailure(
        error,
        {
          operation: "slack.socket.loop",
          component: "triggers",
          provider: "slack",
        },
        { scrubValues: sensitiveValues() },
      );
      rejectReady?.(error);
    });

  const awaitSocket = (openedSocket: WebSocket): Promise<{ closed: Promise<SocketCloseResult> }> =>
    new Promise((resolve, reject) => {
      let hello = false;
      let queue = Promise.resolve();
      let settled = false;
      const closed = closeResult(openedSocket, claimSocketFailure);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        openedSocket.terminate();
        reject(new Error("Slack Socket Mode hello timed out"));
      }, helloTimeoutMs);

      const rejectBeforeHello = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        openedSocket.close();
        reject(error);
      };

      openedSocket.on("message", (data, binary) => {
        if (!admitting) return;
        const admittedHandlers = new Set(Array.from(handlers, admitTriggerHandler));
        const admitted = queue
          .then(() => {
            const byteLength = rawDataByteLength(data);
            if (binary || byteLength > MAX_FRAME_BYTES) {
              if (!hello) {
                throw new SlackSocketProtocolError(
                  "Slack Socket Mode sent an invalid frame before hello",
                  "invalidFrame",
                  byteLength,
                );
              }
              reportParseFailure(byteLength, options.appToken);
              return undefined;
            }
            return handleFrame(rawDataText(data), openedSocket, hello, admittedHandlers);
          })
          .then((result) => {
            if (result?.hello === true && !hello) {
              hello = true;
              settled = true;
              clearTimeout(timer);
              connectionFailureEpisode = undefined;
              delayedWorkspaces.clear();
              connectedStatus = {
                state: "connected",
                since: now(),
                connectionCount: result.connectionCount,
                ...(result.connectionCount >= 10 ? { connectionLimitReached: true } : {}),
              };
              publishConnectedStatus();
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
              settleReadiness();
              resolve({ closed });
            }
            return undefined;
          })
          .catch((error: unknown) => {
            if (!hello) {
              rejectBeforeHello(error);
              return;
            }
            if (claimSocketFailure(openedSocket)) {
              reportFailure(
                error,
                {
                  operation: "slack.socket.handoff",
                  component: "triggers",
                  provider: "slack",
                },
                { scrubValues: sensitiveValues() },
              );
            }
            openedSocket.close(1000, "handoff_failed");
          });
        queue = admitted;
        trackAdmission(admitted);
      });
      void closed.then((result) => {
        if (!hello) rejectBeforeHello(preHelloCloseError(result));
        return undefined;
      });
    });

  const handleFrame = async (
    frame: string,
    target: WebSocket,
    helloReceived: boolean,
    admittedHandlers: ReadonlySet<TriggerHandler>,
  ): Promise<{ hello: true; connectionCount: number } | undefined> => {
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      if (!helloReceived) {
        throw new SlackSocketProtocolError(
          "Slack Socket Mode sent malformed JSON before hello",
          "invalidFrame",
          Buffer.byteLength(frame),
        );
      }
      reportParseFailure(Buffer.byteLength(frame), options.appToken);
      return undefined;
    }
    if (!helloReceived) {
      const parsed = SlackSocketHelloSchema.safeParse(value);
      if (!parsed.success) {
        throw new SlackSocketProtocolError(
          "Slack Socket Mode sent an invalid hello",
          "invalidFrame",
          Buffer.byteLength(frame),
        );
      }
      if (parsed.data.connection_info.app_id !== options.appId) {
        throw new SlackSocketProtocolError(
          "Slack Socket Mode connected to a different app than configured",
          "appIdentityMismatch",
          Buffer.byteLength(frame),
        );
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
      if (envelopeId !== undefined) {
        await sendAck(target, envelopeId, options.appToken, claimSocketFailure);
      }
      return undefined;
    }
    await handleEnvelope(envelope.data, target, admittedHandlers, Buffer.byteLength(frame));
    return undefined;
  };

  const handleEnvelope = async (
    envelope: SlackSocketEnvelope,
    target: WebSocket,
    admittedHandlers: ReadonlySet<TriggerHandler>,
    frameBytes: number,
  ): Promise<void> => {
    let deliveredTeamId: string | undefined;
    if (envelope.type === "events_api") {
      const payloadType = objectString(envelope.payload, "type");
      if (payloadType === "app_rate_limited") {
        const teamId = objectString(envelope.payload, "team_id") ?? "workspace";
        if (!delayedWorkspaces.has(teamId)) {
          delayedWorkspaces.set(teamId, now());
          publishConnectedStatus();
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
        }
        if (!transportClosed)
          await sendAck(target, envelope.envelope_id, options.appToken, claimSocketFailure);
        return;
      }
      const signatureHash = createHash("sha256").update(envelope.envelope_id).digest("hex");
      try {
        const intake = await intakeSlackEvent(
          envelope.payload,
          signatureHash,
          admittedHandlers,
          options,
        );
        if (intake.status === "accepted") deliveredTeamId = intake.teamId;
      } catch (error) {
        if (!(error instanceof SlackEventIntakeValidationError)) throw error;
        reportParseFailure(frameBytes, options.appToken);
      }
    }
    if (!transportClosed) {
      const acknowledged = await sendAck(
        target,
        envelope.envelope_id,
        options.appToken,
        claimSocketFailure,
      );
      if (
        acknowledged &&
        deliveredTeamId !== undefined &&
        delayedWorkspaces.delete(deliveredTeamId) &&
        connectedStatus !== undefined
      ) {
        connectedStatus = { ...connectedStatus, since: now() };
        publishConnectedStatus();
      }
    }
  };

  return {
    async start(handler) {
      handlers.add(handler);
      if (!stopped) return readyPromise;
      stopped = false;
      admitting = true;
      transportClosed = false;
      readinessSettled = false;
      readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      readinessTimer = setTimeout(
        () => settleReadiness(new SlackSocketReadinessError()),
        readinessTimeoutMs,
      );
      supervisor = supervise();
      return readyPromise;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      admitting = false;
      if (readinessTimer !== undefined) clearTimeout(readinessTimer);
      for (const controller of connectionAttempts) controller.abort();
      retryWake?.();
      await drainAdmissions();
      handlers.clear();
      transportClosed = true;
      const closing = [...sockets];
      for (const openSocket of closing) openSocket.close(1000, "shutdown");
      await Promise.race([
        Promise.all(closing.map((openSocket) => closeResult(openSocket))),
        delay(shutdownTimeoutMs),
      ]);
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
    async drain() {
      await Promise.allSettled(admissions);
    },
    ready: () => readyPromise,
    status: () => deliveryStatus,
    async retry() {
      if (stopped) return;
      retryWake?.();
      if (
        supervisor === undefined ||
        (deliveryStatus.state === "actionNeeded" &&
          (deliveryStatus.reason === "socketModeOff" ||
            deliveryStatus.reason === "connectionLimit"))
      ) {
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

  function settleReadiness(error?: unknown): void {
    if (readinessSettled) return;
    readinessSettled = true;
    if (readinessTimer !== undefined) clearTimeout(readinessTimer);
    if (error === undefined) resolveReady?.();
    else rejectReady?.(error);
  }

  function reportConnectionFailure(
    error: unknown,
    action: SlackSocketActionReason | undefined,
  ): void {
    const episode = connectionEpisode(error, action);
    if (connectionFailureEpisode === episode) return;
    connectionFailureEpisode = episode;
    reportFailure(
      error,
      {
        operation: connectionOperation(action),
        component: "triggers",
        provider: "slack",
      },
      {
        kind: connectionFailureKind(error, action),
        scrubValues: sensitiveValues(),
      },
    );
  }

  function reportAbnormalClose(close: SocketCloseResult): void {
    reportFailure(
      Object.assign(new Error("Slack Socket Mode connection ended unexpectedly"), {
        code: "socket_closed",
      }),
      {
        operation: "slack.socket.disconnect",
        component: "triggers",
        provider: "slack",
      },
      {
        kind: "network",
        scrubValues: sensitiveValues(),
        diagnostic: { closeCode: close.code, phase: "connected" },
      },
    );
  }

  function publishConnectedStatus(): void {
    if (connectedStatus === undefined) return;
    const delayed = [...delayedWorkspaces].map(([teamId, since]) => ({ teamId, since }));
    deliveryStatus = {
      ...connectedStatus,
      ...(delayed.length === 0 ? {} : { delayedWorkspaces: delayed }),
    };
  }

  function claimSocketFailure(socket: WebSocket): boolean {
    if (ownedSocketFailures.has(socket)) return false;
    ownedSocketFailures.add(socket);
    return true;
  }

  function trackAdmission(admission: Promise<void>): void {
    admissions.add(admission);
    void admission.finally(() => admissions.delete(admission));
  }

  async function drainAdmissions(): Promise<void> {
    if (admissions.size === 0) return;
    await Promise.race([
      Promise.allSettled(admissions).then(() => undefined),
      delay(shutdownTimeoutMs),
    ]);
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
          {
            operation: "slack.socket.connect",
            component: "triggers",
            provider: "slack",
          },
          { kind: "network", scrubValues: sensitiveValues() },
        );
      })
      .finally(() => {
        refreshPromise = undefined;
      });
  }
}

function connectionFailureKind(
  error: unknown,
  action: SlackSocketActionReason | undefined,
): "authentication" | "validation" | "network" {
  if (action === "appTokenRejected") return "authentication";
  if (action === "appIdentityMismatch" || action === "appAccessDenied") return "validation";
  if (error instanceof SlackSocketProtocolError) return "validation";
  return "network";
}

function connectionOperation(
  action: SlackSocketActionReason | undefined,
): "slack.socket.authenticate" | "slack.socket.configure" | "slack.socket.connect" {
  if (action === "appIdentityMismatch" || action === "appAccessDenied") {
    return "slack.socket.configure";
  }
  if (action === "appTokenRejected") return "slack.socket.authenticate";
  return "slack.socket.connect";
}

function closeResult(
  socket: WebSocket,
  claimFailure?: (socket: WebSocket) => boolean,
): Promise<SocketCloseResult> {
  return new Promise((resolve) => {
    let socketError: unknown;
    socket.once("error", (error) => {
      socketError ??= error;
    });
    socket.once("close", (code, reason) => {
      const abnormal = socketError !== undefined || code !== 1000;
      resolve({
        code,
        reason: reason.toString(),
        ...(socketError === undefined ? {} : { error: socketError }),
        failureOwner: abnormal && claimFailure !== undefined && claimFailure(socket),
      });
    });
  });
}

function preHelloCloseError(close: SocketCloseResult): Error {
  return Object.assign(new Error("Slack Socket Mode connection ended before it was ready"), {
    code: "socket_closed_before_hello",
    closeCode: close.code,
    cause: close.error,
  });
}

async function sendAck(
  socket: WebSocket,
  envelopeId: string,
  appToken: string,
  claimFailure: (socket: WebSocket) => boolean,
): Promise<boolean> {
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
    return true;
  } catch (error) {
    if (claimFailure(socket)) {
      reportFailure(
        error,
        {
          operation: "slack.socket.ack",
          component: "triggers",
          provider: "slack",
        },
        { scrubValues: [appToken] },
      );
    }
    socket.close(1000, "ack_failed");
    return false;
  }
}

function connectionAction(error: unknown): SlackSocketActionReason | undefined {
  if (error instanceof SlackSocketProtocolError && error.reason === "appIdentityMismatch") {
    return "appIdentityMismatch";
  }
  if (!(error instanceof SlackSocketOpenError)) return undefined;
  return classifyOpenFailure(error.slackError);
}

/** Slack's documented apps.connections.open errors, classified once at the response boundary.
 * Unknown errors stay retryable because Slack explicitly reserves them for outages and other
 * unexpected processing failures. */
function classifyOpenFailure(slackError: string): SlackSocketActionReason | undefined {
  if (OPEN_CREDENTIAL_ERRORS.has(slackError)) return "appTokenRejected";
  if (OPEN_ACCESS_ERRORS.has(slackError)) return "appAccessDenied";
  return undefined;
}

const OPEN_CREDENTIAL_ERRORS: ReadonlySet<string> = new Set([
  "account_inactive",
  "invalid_auth",
  "missing_args",
  "missing_scope",
  "not_allowed_token_type",
  "not_authed",
  "token_expired",
  "token_revoked",
]);

const OPEN_ACCESS_ERRORS: ReadonlySet<string> = new Set([
  "access_denied",
  "accesslimited",
  "deprecated_endpoint",
  "ekm_access_denied",
  "enterprise_is_restricted",
  "forbidden_team",
  "insecure_request",
  "invalid_arg_name",
  "invalid_arguments",
  "invalid_array_arg",
  "invalid_charset",
  "invalid_form_data",
  "invalid_post_type",
  "method_deprecated",
  "missing_post_type",
  "no_permission",
  "request_timeout",
  "team_access_not_granted",
  "two_factor_setup_required",
]);

function connectionEpisode(error: unknown, action: SlackSocketActionReason | undefined): string {
  if (error instanceof SlackSocketOpenError) {
    return `open:${error.status}:${error.slackError}:${action ?? "transient"}`;
  }
  if (error instanceof SlackSocketProtocolError) return `protocol:${error.reason}`;
  if (error instanceof Error)
    return `error:${error.name}:${error.message}:${action ?? "transient"}`;
  return `unknown:${typeof error}:${action ?? "transient"}`;
}

function reportParseFailure(byteCount: number, appToken: string): void {
  reportFailure(
    Object.assign(new Error("Slack Socket Mode envelope was invalid"), {
      frameBytes: byteCount,
    }),
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
