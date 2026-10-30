import { createHash } from "node:crypto";
import type { RawData } from "ws";
import { reportFailure } from "../../../../failures/index.js";
import { logger } from "../../../../logger.js";
import type { TriggerHandler, TriggerSource } from "../../../index.js";
import {
  acceptSlackEvent,
  dispatchSlackEvents,
  SlackEventIntakeValidationError,
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
const TIMED_OUT = Symbol("timed out");

export type SlackDeliveryStatus =
  | { state: "connecting" | "reconnecting" | "connected" }
  | {
      state: "actionNeeded";
      reason: "appTokenRejected" | "socketModeOff" | "appIdentityMismatch";
    }
  | { state: "stopped" };

export interface SlackSocketSource extends TriggerSource {
  status(): SlackDeliveryStatus;
  retry(): Promise<void>;
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
>;

/** State owned by one Socket Mode connection, so a closed one cannot affect the next. */
interface SlackSocketLink {
  readonly connection: OpenSlackSocketResult;
  frames: Promise<void>;
  /** Set once the socket has closed; its late frames neither acknowledge nor dispatch. */
  closed: boolean;
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
  let status: SlackDeliveryStatus = { state: "stopped" };
  let stopped = true;
  let attempt = 0;
  let controller: AbortController | undefined;
  let current: SlackSocketLink | undefined;
  let supervisor: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let transientReported = false;
  let minimumDelay = 0;
  const scrubValues = () => [
    options.appToken,
    ...(options.apiUrl === undefined ? [] : [options.apiUrl]),
  ];

  const run = async () => {
    for (;;) {
      if (stopped) return;
      status = { state: attempt === 0 ? "connecting" : "reconnecting" };
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
          failureOwned: false,
          expectedClose: false,
          terminalDisconnect: undefined,
        };
        current = link;
        connection.socket.once("close", () => {
          link.closed = true;
        });
        transientReported = false;
        attempt = 0;
        status = { state: "connected" };
        logger.info(
          { provider: "slack", operation: "slack.socket.connect", appId: options.appId },
          "Slack Socket Mode connected",
        );
        connection.socket.on("message", (data, binary) => {
          link.frames = link.frames
            .then(() => handleFrame(link, data, binary))
            .catch((error: unknown) => {
              if (!link.failureOwned) {
                link.failureOwned = true;
                report(error, "slack.socket.handoff", "internal");
              }
              connection.socket.close();
            });
        });
        const closed = await connection.closed;
        if (current === link) current = undefined;
        if (stopped) return;
        if (link.terminalDisconnect !== undefined) {
          status = { state: "actionNeeded", reason: link.terminalDisconnect };
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
          status = { state: "actionNeeded", reason: error.reason };
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
      status = { state: "stopped" };
    },
    status: () => status,
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
    try {
      const accepted = await settleWithin(
        acceptSlackEvent(payload, signatureHash, handlers, options),
        acceptTimeoutMs,
        "slack.socket.accept",
      );
      if (accepted === TIMED_OUT) {
        // Leave it unacknowledged: Slack redelivers it and the receipt store replays it.
        report(
          new Error("Slack event accept timed out"),
          "slack.socket.accept_timeout",
          "internal",
        );
        return;
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
    try {
      const dispatched = await settleWithin(
        dispatchSlackEvents(events, handlers),
        dispatchTimeoutMs,
        "slack.socket.dispatch",
      );
      if (dispatched === TIMED_OUT) {
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
      if (!link.failureOwned) {
        link.failureOwned = true;
        report(new Error("Slack acknowledgement timed out"), "slack.socket.ack_timeout", "network");
      }
      socket.terminate();
    } catch (error) {
      link.failureOwned = true;
      report(error, "slack.socket.ack", "network");
      socket.close();
    }
    return false;
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

function boundedEnvelopeId(value: unknown): string | undefined {
  const id = objectString(value, "envelope_id");
  return id !== undefined && id.length <= 255 ? id : undefined;
}

function objectString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate: unknown = Reflect.get(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}
