import { createHash } from "node:crypto";
import type { RawData } from "ws";
import { reportFailure } from "../../../../failures/index.js";
import { logger } from "../../../../logger.js";
import type { TriggerHandler, TriggerSource } from "../../../index.js";
import {
  acceptSlackEvent,
  SlackEventIntakeValidationError,
  startSlackDispatch,
  type AcceptedSlackEvents,
  type SlackEventIntakeOptions,
} from "./intake.js";
import {
  openSlackSocket,
  SlackSocketConnectionError,
  type OpenSlackSocketResult,
} from "./connection.js";
import {
  parseSlackSocketFrame,
  slackSocketFrame,
  slackSocketAck,
  SlackSocketDisconnectSchema,
  SlackSocketEnvelopeSchema,
} from "./socket-protocol.js";

const MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_ACCEPT_TIMEOUT_MS = 30_000;
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
/** How often a connected socket pings Slack. */
export const SLACK_SOCKET_PING_INTERVAL_MS = 30_000;
/** How long a ping may go unanswered before the socket is dropped and reopened. */
export const SLACK_SOCKET_PONG_TIMEOUT_MS = 10_000;
const TIMED_OUT = Symbol("timed out");

export type SlackDeliveryStatus =
  | { state: "connecting" | "reconnecting" | "connected" }
  | {
      state: "actionNeeded";
      reason: "appTokenRejected" | "socketModeOff" | "appIdentityMismatch";
    }
  | { state: "stopped" };

export type SlackIntakePhase = "accept" | "ack" | "dispatch";

/**
 * Slack intake as one Socket Mode source sees it. Queue and active-frame fields describe the
 * current connection; the rest cover the source since it was created. Times, not ages, so the
 * caller decides what is too old.
 */
export interface SlackSocketIntakeHealth {
  transport: "socket";
  state: SlackDeliveryStatus["state"];
  stateChangedAt: Date;
  queuedFrames: number;
  activePhase: SlackIntakePhase | null;
  activePhaseStartedAt: Date | null;
  lastCompletedAt: Date | null;
  acceptTimeouts: number;
  ackTimeouts: number;
  dispatchTimeouts: number;
  lastAcceptOkAt: Date | null;
  lastAcceptTimeoutAt: Date | null;
  abandonedHandlers: number;
  oldestAbandonedStartedAt: Date | null;
  closedConnectionFrames: number;
  oldestClosedFrameStartedAt: Date | null;
  lastPongAt: Date | null;
}

export type SlackIntakeHealth = SlackSocketIntakeHealth | { transport: "webhook" };

export interface SlackSocketSource extends TriggerSource {
  status(): SlackDeliveryStatus;
  retry(): Promise<void>;
  intake(): SlackSocketIntakeHealth;
}

export interface SlackSocketSourceOptions extends SlackEventIntakeOptions {
  appToken: string;
  apiUrl?: string;
  random?: () => number;
  timeoutMs?: number;
  /** Longest wait for one event's durable accept; a late accept is never acknowledged. */
  acceptTimeoutMs?: number;
  /** Longest wait for an acknowledgement to be written before the socket is dropped. */
  ackTimeoutMs?: number;
  /** Longest the next frame waits for one event's trigger handlers. */
  dispatchTimeoutMs?: number;
  /** Longest `stop()` waits for the frame in progress. */
  stopGraceMs?: number;
  /** How often to ping Slack on a connected socket. */
  pingIntervalMs?: number;
  /** How long a ping may go unanswered before the socket is dropped. */
  pongTimeoutMs?: number;
}

export type SlackSocketTuning = Pick<
  SlackSocketSourceOptions,
  | "apiUrl"
  | "random"
  | "timeoutMs"
  | "acceptTimeoutMs"
  | "ackTimeoutMs"
  | "dispatchTimeoutMs"
  | "stopGraceMs"
  | "pingIntervalMs"
  | "pongTimeoutMs"
>;

/** State owned by one Socket Mode connection, so a closed one cannot affect the next. */
interface SlackSocketLink {
  readonly connection: OpenSlackSocketResult;
  frames: Promise<void>;
  /** Set once the socket has closed; its late frames neither acknowledge nor dispatch. */
  closed: boolean;
  /** Frames received but not yet started. */
  queued: number;
  active: { phase: SlackIntakePhase; startedAt: Date } | undefined;
  failureOwned: boolean;
  expectedClose: boolean;
  terminalDisconnect: "socketModeOff" | undefined;
}

export function createSlackSocketSource(options: SlackSocketSourceOptions): SlackSocketSource {
  const handlers = new Set<TriggerHandler>();
  const random = options.random ?? Math.random;
  const acceptTimeoutMs = options.acceptTimeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS;
  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const dispatchTimeoutMs = options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const pingIntervalMs = options.pingIntervalMs ?? SLACK_SOCKET_PING_INTERVAL_MS;
  const pongTimeoutMs = options.pongTimeoutMs ?? SLACK_SOCKET_PONG_TIMEOUT_MS;
  let status: SlackDeliveryStatus = { state: "stopped" };
  let stateChangedAt = new Date();
  let stopped = true;
  let attempt = 0;
  let controller: AbortController | undefined;
  let current: SlackSocketLink | undefined;
  let supervisor: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let transientReported = false;
  let minimumDelay = 0;
  /** Connections that are current or still have frames to finish. */
  const links = new Set<SlackSocketLink>();
  /** Start times of trigger handlers still running after their dispatch timeout. */
  const abandoned = new Set<{ startedAt: Date }>();
  const counters = {
    lastCompletedAt: null as Date | null,
    acceptTimeouts: 0,
    ackTimeouts: 0,
    dispatchTimeouts: 0,
    lastAcceptOkAt: null as Date | null,
    lastAcceptTimeoutAt: null as Date | null,
    lastPongAt: null as Date | null,
  };
  /** When the newest successful durable accept began; an older accept's timeout is stale. */
  let lastAcceptOkStartedAt: Date | null = null;
  const scrubValues = () => [
    options.appToken,
    ...(options.apiUrl === undefined ? [] : [options.apiUrl]),
  ];

  const run = async () => {
    for (;;) {
      if (stopped) return;
      setStatus({ state: attempt === 0 ? "connecting" : "reconnecting" });
      controller = new AbortController();
      try {
        const connection = await openSlackSocket({
          appToken: options.appToken,
          appId: options.appId,
          signal: controller.signal,
          ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        const link: SlackSocketLink = {
          connection,
          frames: Promise.resolve(),
          closed: false,
          queued: 0,
          active: undefined,
          failureOwned: false,
          expectedClose: false,
          terminalDisconnect: undefined,
        };
        current = link;
        links.add(link);
        const stopPinging = pingUntilClosed(link);
        connection.socket.once("close", () => {
          link.closed = true;
          stopPinging();
          forgetIfDrained(link);
        });
        transientReported = false;
        attempt = 0;
        setStatus({ state: "connected" });
        logger.info(
          { provider: "slack", operation: "slack.socket.connect", appId: options.appId },
          "Slack Socket Mode connected",
        );
        connection.socket.on("message", (data, binary) => {
          link.queued += 1;
          link.frames = link.frames
            .then(() => {
              link.queued -= 1;
              return handleFrame(link, data, binary);
            })
            .catch((error: unknown) => {
              if (!link.failureOwned) {
                link.failureOwned = true;
                report(error, "slack.socket.handoff", "internal");
              }
              connection.socket.close();
            })
            .then(() => completeFrame(link));
        });
        const closed = await connection.closed;
        if (current === link) current = undefined;
        if (stopped) return;
        if (link.terminalDisconnect !== undefined) {
          setStatus({ state: "actionNeeded", reason: link.terminalDisconnect });
          if (!link.failureOwned)
            report(new Error("Slack Socket Mode is off"), "slack.socket.disconnect", "validation");
          return;
        }
        if (!link.expectedClose && !link.failureOwned) {
          report(
            Object.assign(new Error("Slack Socket Mode connection closed"), {
              closeCode: closed,
            }),
            "slack.socket.connect",
            "network",
          );
          transientReported = true;
        }
      } catch (error) {
        if (stopped || controller.signal.aborted) return;
        if (error instanceof SlackSocketConnectionError && error.reason !== "transient") {
          setStatus({ state: "actionNeeded", reason: error.reason });
          report(error, "slack.socket.authenticate", "authentication");
          return;
        }
        if (!transientReported) {
          transientReported = true;
          report(error, "slack.socket.connect", "network");
        }
        minimumDelay = error instanceof SlackSocketConnectionError ? error.retryAfterMs : 0;
      }
      attempt += 1;
      const delayMs = Math.max(
        minimumDelay,
        Math.floor(random() * Math.min(30_000, 1_000 * 2 ** (attempt - 1))),
      );
      minimumDelay = 0;
      await waitForRetry(delayMs);
    }
  };

  const startSupervisor = () => {
    supervisor = run().catch((error: unknown) => report(error, "slack.socket.loop", "internal"));
  };

  return {
    async start(handler) {
      handlers.add(handler);
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      startSupervisor();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      controller?.abort();
      wake?.();
      const link = current;
      if (link !== undefined) await link.connection.close(250, "shutdown");
      await supervisor;
      if (link !== undefined) await settleWithin(link.frames, stopGraceMs);
      handlers.clear();
      setStatus({ state: "stopped" });
    },
    status: () => status,
    intake: () => {
      const link = current?.closed === false ? current : undefined;
      const closedLinks = [...links].filter((candidate) => candidate !== link);
      return {
        transport: "socket",
        state: status.state,
        stateChangedAt,
        queuedFrames: link?.queued ?? 0,
        activePhase: link?.active?.phase ?? null,
        activePhaseStartedAt: link?.active?.startedAt ?? null,
        ...counters,
        abandonedHandlers: abandoned.size,
        oldestAbandonedStartedAt: earliest([...abandoned].map((entry) => entry.startedAt)),
        closedConnectionFrames: closedLinks.reduce(
          (total, closed) => total + closed.queued + (closed.active === undefined ? 0 : 1),
          0,
        ),
        oldestClosedFrameStartedAt: earliest(
          closedLinks.flatMap((closed) =>
            closed.active === undefined ? [] : [closed.active.startedAt],
          ),
        ),
      };
    },
    async retry() {
      if (!stopped && status.state !== "actionNeeded") {
        wake?.();
        return;
      }
      if (stopped) return;
      attempt = 0;
      transientReported = false;
      startSupervisor();
    },
  };

  async function handleFrame(link: SlackSocketLink, data: RawData, binary: boolean): Promise<void> {
    const frame = slackSocketFrame(data);
    const bytes = frame.byteLength;
    if (binary || bytes > MAX_FRAME_BYTES) {
      reportInvalidFrame(bytes);
      return;
    }
    const value = parseSlackSocketFrame(frame);
    const disconnect = SlackSocketDisconnectSchema.safeParse(value);
    if (disconnect.success) {
      link.expectedClose = disconnect.data.reason !== "link_disabled";
      if (!link.expectedClose) link.terminalDisconnect = "socketModeOff";
      link.connection.socket.close(1000, disconnect.data.reason);
      return;
    }
    const envelope = SlackSocketEnvelopeSchema.safeParse(value);
    if (!envelope.success) {
      reportInvalidFrame(bytes);
      const envelopeId = boundedEnvelopeId(value);
      if (envelopeId !== undefined) await sendAck(link, envelopeId);
      return;
    }
    if (envelope.data.type === "events_api") {
      if (objectString(envelope.data.payload, "type") === "app_rate_limited") {
        logger.warn(
          {
            provider: "slack",
            operation: "slack.socket.rate_limited",
            teamId: objectString(envelope.data.payload, "team_id"),
          },
          "Slack is delaying events for a workspace",
        );
      } else {
        await handleEvent(link, envelope.data.envelope_id, envelope.data.payload, bytes);
        return;
      }
    }
    if (!stopped) await sendAck(link, envelope.data.envelope_id);
  }

  /** Accept durably, acknowledge, then hand to the triggers, each step bounded. */
  async function handleEvent(
    link: SlackSocketLink,
    envelopeId: string,
    payload: unknown,
    bytes: number,
  ): Promise<void> {
    const signatureHash = createHash("sha256").update(envelopeId).digest("hex");
    let events: AcceptedSlackEvents = [];
    const acceptStartedAt = startPhase(link, "accept").startedAt;
    // Ignored events (bot messages) never reach the durable store, so they prove nothing.
    let durable = false;
    const accept: SlackEventIntakeOptions["accept"] = async (input) => {
      const acceptance = await options.accept(input);
      durable = true;
      return acceptance;
    };
    try {
      const accepted = await settleWithin(
        acceptSlackEvent(payload, signatureHash, handlers, { ...options, accept }),
        acceptTimeoutMs,
        "slack.socket.accept",
      );
      if (accepted === TIMED_OUT) {
        counters.acceptTimeouts += 1;
        // A closed connection's accept can time out after a newer accept succeeded.
        if (
          lastAcceptOkStartedAt === null ||
          lastAcceptOkStartedAt.getTime() <= acceptStartedAt.getTime()
        ) {
          counters.lastAcceptTimeoutAt = new Date();
        }
        // Leave it unacknowledged: Slack redelivers it and the receipt store replays it.
        report(
          new Error("Slack event accept timed out"),
          "slack.socket.accept_timeout",
          "internal",
        );
        return;
      }
      if (durable) {
        counters.lastAcceptOkAt = new Date();
        // Accepts on different connections can finish out of order; keep the newest start.
        if (
          lastAcceptOkStartedAt === null ||
          lastAcceptOkStartedAt.getTime() < acceptStartedAt.getTime()
        ) {
          lastAcceptOkStartedAt = acceptStartedAt;
        }
      }
      events = accepted;
    } catch (error) {
      if (!(error instanceof SlackEventIntakeValidationError)) throw error;
      reportInvalidFrame(bytes);
    }
    if (stopped) return;
    // Dispatch only what Slack has been told it received; anything else it redelivers.
    if (!(await sendAck(link, envelopeId))) return;
    if (events.length === 0) return;
    const phase = startPhase(link, "dispatch");
    const running = new Set<Promise<unknown>>();
    try {
      const calls = startSlackDispatch(events, handlers);
      for (const call of calls) {
        running.add(call);
        const settle = () => running.delete(call);
        // Already acknowledged, so dropping the connection would not bring the event back.
        call.then(settle, (error: unknown) => {
          settle();
          report(error, "slack.socket.handoff", "internal");
        });
      }
      // allSettled, so one failing handler leaves the others under the deadline.
      const dispatched = await settleWithin(
        Promise.allSettled(calls),
        dispatchTimeoutMs,
        "slack.socket.dispatch",
      );
      if (dispatched === TIMED_OUT) {
        counters.dispatchTimeouts += 1;
        // One entry per handler call still running, each forgotten when it settles.
        for (const call of running) {
          const entry = { startedAt: phase.startedAt };
          abandoned.add(entry);
          const forget = () => abandoned.delete(entry);
          call.then(forget, forget);
        }
        report(
          new Error("Slack trigger handlers timed out"),
          "slack.socket.dispatch_timeout",
          "internal",
        );
      }
    } catch (error) {
      // Already acknowledged, so dropping the connection would not bring the event back.
      report(error, "slack.socket.handoff", "internal");
    }
  }

  /** Resolves true once the acknowledgement is written. */
  async function sendAck(link: SlackSocketLink, envelopeId: string): Promise<boolean> {
    if (link.closed) return false;
    startPhase(link, "ack");
    const { socket } = link.connection;
    try {
      const sent = await settleWithin(
        new Promise<void>((resolve, reject) => {
          socket.send(slackSocketAck(envelopeId), (error) => {
            if (error != null) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
        ackTimeoutMs,
        "slack.socket.ack",
      );
      if (sent !== TIMED_OUT) return true;
      counters.ackTimeouts += 1;
      if (!link.failureOwned) {
        link.failureOwned = true;
        report(new Error("Slack acknowledgement timed out"), "slack.socket.ack_timeout", "network");
      }
      socket.terminate();
    } catch (error) {
      // A ping timeout may already have dropped the socket, failing this write with it.
      if (!link.failureOwned) {
        link.failureOwned = true;
        report(error, "slack.socket.ack", "network");
      }
      socket.terminate();
    }
    return false;
  }

  /**
   * Pings Slack on a schedule and drops a socket that stops answering, which a half-open
   * connection never reports on its own. Returns the function that stops the timers.
   */
  function pingUntilClosed(link: SlackSocketLink): () => void {
    const { socket } = link.connection;
    let pongTimer: NodeJS.Timeout | undefined;
    const onPong = () => {
      clearTimeout(pongTimer);
      pongTimer = undefined;
      counters.lastPongAt = new Date();
    };
    socket.on("pong", onPong);
    const pinger = setInterval(() => {
      if (pongTimer !== undefined) return;
      pongTimer = setTimeout(() => {
        if (!link.failureOwned) {
          link.failureOwned = true;
          report(
            new Error("Slack stopped answering pings"),
            "slack.socket.ping_timeout",
            "network",
          );
        }
        // Not close(): it waits for a close handshake that a dead peer never sends.
        socket.terminate();
      }, pongTimeoutMs);
      socket.ping();
    }, pingIntervalMs);
    return () => {
      clearInterval(pinger);
      clearTimeout(pongTimer);
      socket.off("pong", onPong);
    };
  }

  function setStatus(next: SlackDeliveryStatus): void {
    // Stamped on a change of state only, so a retry loop does not look freshly down.
    if (next.state !== status.state) stateChangedAt = new Date();
    status = next;
  }

  function startPhase(
    link: SlackSocketLink,
    phase: SlackIntakePhase,
  ): { phase: SlackIntakePhase; startedAt: Date } {
    link.active = { phase, startedAt: new Date() };
    return link.active;
  }

  function completeFrame(link: SlackSocketLink): void {
    link.active = undefined;
    counters.lastCompletedAt = new Date();
    forgetIfDrained(link);
  }

  function forgetIfDrained(link: SlackSocketLink): void {
    if (link.closed && link.queued === 0 && link.active === undefined) links.delete(link);
  }

  function waitForRetry(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      timer.unref();
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      wake = undefined;
    });
  }

  function report(
    error: unknown,
    operation: string,
    kind: "authentication" | "network" | "validation" | "internal",
  ): void {
    reportFailure(
      error,
      { operation, component: "triggers", provider: "slack" },
      { kind, scrubValues: scrubValues() },
    );
  }

  function reportInvalidFrame(byteCount: number): void {
    report(
      Object.assign(new Error("Slack sent an invalid event"), { frameBytes: byteCount }),
      "slack.socket.envelope.parse",
      "validation",
    );
  }
}

/**
 * Resolves with the work's result, or TIMED_OUT once `milliseconds` pass. Work that outlives its
 * timeout keeps running; its late outcome is only logged, so it can never surface as an
 * unhandled rejection.
 */
async function settleWithin<T>(
  work: Promise<T>,
  milliseconds: number,
  operation?: string,
): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(resolve, milliseconds, TIMED_OUT);
  });
  try {
    const outcome = await Promise.race([work, timeout]);
    if (outcome === TIMED_OUT && operation !== undefined) {
      work.then(
        () =>
          logger.debug({ provider: "slack", operation }, "Slack work finished after its timeout"),
        () => logger.debug({ provider: "slack", operation }, "Slack work failed after its timeout"),
      );
    }
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

function earliest(times: readonly Date[]): Date | null {
  let first: Date | null = null;
  for (const time of times) if (first === null || time < first) first = time;
  return first;
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
