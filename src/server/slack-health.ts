import type { SlackIntakeHealth } from "../triggers/slack/source/index.js";

/** Longest a frame may sit in one intake phase before the source counts as stuck. */
export const SLACK_FRAME_STUCK_MS = 60_000;
/** Longest the socket may stay connecting or reconnecting before the source counts as down. */
export const SLACK_SOCKET_DOWN_MS = 300_000;

export type SlackHealthReason = "frame_stuck" | "accept_stalled" | "socket_down";

export interface SlackHealthBody {
  ok: boolean;
  reason: SlackHealthReason | null;
  transport: SlackIntakeHealth["transport"] | null;
  state: string | null;
  stateChangedAt: string | null;
  queuedFrames: number | null;
  activePhase: "accept" | "ack" | "dispatch" | null;
  activePhaseAgeMs: number | null;
  lastCompletedAt: string | null;
  acceptTimeouts: number | null;
  ackTimeouts: number | null;
  dispatchTimeouts: number | null;
  lastAcceptOkAt: string | null;
  lastAcceptTimeoutAt: string | null;
  abandonedHandlers: number | null;
  oldestAbandonedAgeMs: number | null;
  closedConnectionFrames: number | null;
  oldestClosedFrameAgeMs: number | null;
  lastPongAt: string | null;
}

export interface SlackHealthReport {
  status: 200 | 503;
  body: SlackHealthBody;
}

const NOT_APPLICABLE = {
  state: null,
  stateChangedAt: null,
  queuedFrames: null,
  activePhase: null,
  activePhaseAgeMs: null,
  lastCompletedAt: null,
  acceptTimeouts: null,
  ackTimeouts: null,
  dispatchTimeouts: null,
  lastAcceptOkAt: null,
  lastAcceptTimeoutAt: null,
  abandonedHandlers: null,
  oldestAbandonedAgeMs: null,
  closedConnectionFrames: null,
  oldestClosedFrameAgeMs: null,
  lastPongAt: null,
} as const;

/**
 * Judges Slack intake for `/health/slack`: 503 with a reason when intake has stopped, 200
 * otherwise. Slack not configured and the webhook transport are healthy: nothing here can stall.
 */
export function slackHealthReport(
  intake: SlackIntakeHealth | undefined,
  now: Date,
): SlackHealthReport {
  if (intake === undefined || intake.transport === "webhook") {
    return {
      status: 200,
      body: { ok: true, reason: null, transport: intake?.transport ?? null, ...NOT_APPLICABLE },
    };
  }
  const ageOf = (time: Date | null) => (time === null ? null : now.getTime() - time.getTime());
  const activePhaseAgeMs = ageOf(intake.activePhaseStartedAt);
  const reason = stallReason(intake, activePhaseAgeMs, now);
  return {
    status: reason === null ? 200 : 503,
    body: {
      ok: reason === null,
      reason,
      transport: "socket",
      state: intake.state,
      stateChangedAt: intake.stateChangedAt.toISOString(),
      queuedFrames: intake.queuedFrames,
      activePhase: intake.activePhase,
      activePhaseAgeMs,
      lastCompletedAt: isoOf(intake.lastCompletedAt),
      acceptTimeouts: intake.acceptTimeouts,
      ackTimeouts: intake.ackTimeouts,
      dispatchTimeouts: intake.dispatchTimeouts,
      lastAcceptOkAt: isoOf(intake.lastAcceptOkAt),
      lastAcceptTimeoutAt: isoOf(intake.lastAcceptTimeoutAt),
      abandonedHandlers: intake.abandonedHandlers,
      oldestAbandonedAgeMs: ageOf(intake.oldestAbandonedStartedAt),
      closedConnectionFrames: intake.closedConnectionFrames,
      oldestClosedFrameAgeMs: ageOf(intake.oldestClosedFrameStartedAt),
      lastPongAt: isoOf(intake.lastPongAt),
    },
  };
}

function stallReason(
  intake: Extract<SlackIntakeHealth, { transport: "socket" }>,
  activePhaseAgeMs: number | null,
  now: Date,
): SlackHealthReason | null {
  if (activePhaseAgeMs !== null && activePhaseAgeMs > SLACK_FRAME_STUCK_MS) return "frame_stuck";
  // Frames run one at a time and a timeout fires long after its frame began, so a success
  // stamped in the same millisecond as the last timeout came after it.
  const timedOut = intake.lastAcceptTimeoutAt;
  const accepted = intake.lastAcceptOkAt;
  if (timedOut !== null && (accepted === null || accepted.getTime() < timedOut.getTime()))
    return "accept_stalled";
  const down = intake.state === "connecting" || intake.state === "reconnecting";
  if (down && now.getTime() - intake.stateChangedAt.getTime() >= SLACK_SOCKET_DOWN_MS) {
    return "socket_down";
  }
  return null;
}

function isoOf(time: Date | null): string | null {
  return time === null ? null : time.toISOString();
}
