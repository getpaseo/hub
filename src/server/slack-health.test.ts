import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SlackIntakeHealth } from "../triggers/slack/source/index.js";
import { slackHealthReport } from "./slack-health.js";

const KEYS = [
  "ok",
  "reason",
  "transport",
  "state",
  "stateChangedAt",
  "queuedFrames",
  "activePhase",
  "activePhaseAgeMs",
  "lastCompletedAt",
  "acceptTimeouts",
  "ackTimeouts",
  "dispatchTimeouts",
  "lastAcceptOkAt",
  "lastAcceptTimeoutAt",
  "abandonedHandlers",
  "oldestAbandonedAgeMs",
  "closedConnectionFrames",
  "oldestClosedFrameAgeMs",
  "lastPongAt",
].toSorted();

const NOW = new Date("2026-10-31T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;

function socket(overrides: Partial<Extract<SlackIntakeHealth, { transport: "socket" }>> = {}) {
  return {
    transport: "socket",
    state: "connected",
    stateChangedAt: ago(60 * MINUTE),
    queuedFrames: 0,
    activePhase: null,
    activePhaseStartedAt: null,
    lastCompletedAt: null,
    acceptTimeouts: 0,
    ackTimeouts: 0,
    dispatchTimeouts: 0,
    lastAcceptOkAt: null,
    lastAcceptTimeoutAt: null,
    abandonedHandlers: 0,
    oldestAbandonedStartedAt: null,
    closedConnectionFrames: 0,
    oldestClosedFrameStartedAt: null,
    lastPongAt: null,
    ...overrides,
  } satisfies SlackIntakeHealth;
}

function judge(intake: SlackIntakeHealth | undefined) {
  const report = slackHealthReport(intake, NOW);
  assert.deepEqual(Object.keys(report.body).toSorted(), KEYS);
  assert.equal(report.body.ok, report.status === 200);
  if (report.status === 200) assert.equal(report.body.reason, null);
  const json = JSON.stringify(report.body);
  assert.doesNotMatch(json, /xapp-|xoxb-|token|appId|app_id|teamId|team_id|T0[A-Z0-9]{6,}/i);
  return report;
}

function healthy(intake: SlackIntakeHealth | undefined) {
  const report = judge(intake);
  assert.equal(report.status, 200);
  return report.body;
}

function unhealthy(intake: SlackIntakeHealth, reason: string) {
  const report = judge(intake);
  assert.equal(report.status, 503);
  assert.equal(report.body.reason, reason);
  return report.body;
}

describe("Slack intake health report", () => {
  it("is healthy and all null when Slack is not configured", () => {
    const body = healthy(undefined);
    assert.equal(body.transport, null);
    for (const [key, value] of Object.entries(body)) {
      if (key !== "ok" && key !== "reason") assert.equal(value, null, key);
    }
  });

  it("is healthy for the webhook transport", () => {
    const body = healthy({ transport: "webhook" });
    assert.equal(body.transport, "webhook");
    assert.equal(body.state, null);
    assert.equal(body.acceptTimeouts, null);
  });

  it("is healthy when idle", () => {
    const body = healthy(socket());
    assert.equal(body.transport, "socket");
    assert.equal(body.state, "connected");
    assert.equal(body.stateChangedAt, ago(60 * MINUTE).toISOString());
    assert.equal(body.activePhase, null);
    assert.equal(body.activePhaseAgeMs, null);
    assert.equal(body.lastCompletedAt, null);
  });

  it("is healthy with traffic and reports times as ISO strings", () => {
    const body = healthy(
      socket({
        lastCompletedAt: ago(5_000),
        lastAcceptOkAt: ago(5_000),
        lastPongAt: ago(1_000),
        activePhase: "accept",
        activePhaseStartedAt: ago(200),
      }),
    );
    assert.equal(body.lastCompletedAt, ago(5_000).toISOString());
    assert.equal(body.lastAcceptOkAt, ago(5_000).toISOString());
    assert.equal(body.lastPongAt, ago(1_000).toISOString());
    assert.equal(body.activePhaseAgeMs, 200);
  });

  it("allows an active phase of exactly 60 000 ms", () => {
    healthy(socket({ activePhase: "dispatch", activePhaseStartedAt: ago(60_000) }));
  });

  it("reports frame_stuck once a phase passes 60 000 ms", () => {
    const body = unhealthy(
      socket({ activePhase: "dispatch", activePhaseStartedAt: ago(60_001) }),
      "frame_stuck",
    );
    assert.equal(body.activePhaseAgeMs, 60_001);
  });

  it("is healthy while a backlog drains", () => {
    const body = healthy(
      socket({ queuedFrames: 5, activePhase: "accept", activePhaseStartedAt: ago(20_000) }),
    );
    assert.equal(body.queuedFrames, 5);
  });

  it("is healthy during a 20 000 ms ack phase", () => {
    healthy(socket({ activePhase: "ack", activePhaseStartedAt: ago(20_000) }));
  });

  it("allows reconnecting for 299 999 ms", () => {
    healthy(socket({ state: "reconnecting", stateChangedAt: ago(299_999) }));
  });

  it("reports socket_down after 300 000 ms of reconnecting", () => {
    unhealthy(socket({ state: "reconnecting", stateChangedAt: ago(300_000) }), "socket_down");
  });

  it("reports socket_down after 300 000 ms of connecting", () => {
    unhealthy(socket({ state: "connecting", stateChangedAt: ago(300_000) }), "socket_down");
  });

  it("reports accept_stalled when no accept has ever succeeded", () => {
    const body = unhealthy(
      socket({ acceptTimeouts: 1, lastAcceptTimeoutAt: ago(1_000) }),
      "accept_stalled",
    );
    assert.equal(body.acceptTimeouts, 1);
    assert.equal(body.lastAcceptTimeoutAt, ago(1_000).toISOString());
  });

  it("reports accept_stalled when the last accept timed out after the last success", () => {
    unhealthy(
      socket({ acceptTimeouts: 1, lastAcceptOkAt: ago(9_000), lastAcceptTimeoutAt: ago(1_000) }),
      "accept_stalled",
    );
  });

  it("recovers when the next accept succeeds in the same millisecond as the timeout", () => {
    healthy(
      socket({ acceptTimeouts: 1, lastAcceptTimeoutAt: ago(1_000), lastAcceptOkAt: ago(1_000) }),
    );
  });

  it("recovers once an accept succeeds after the stall", () => {
    healthy(
      socket({ acceptTimeouts: 1, lastAcceptTimeoutAt: ago(9_000), lastAcceptOkAt: ago(1_000) }),
    );
  });

  it("stays healthy while Slack needs action from a person", () => {
    const body = healthy(socket({ state: "actionNeeded", stateChangedAt: ago(10 * MINUTE) }));
    assert.equal(body.state, "actionNeeded");
  });

  it("stays healthy with abandoned handlers only", () => {
    const body = healthy(
      socket({ dispatchTimeouts: 2, abandonedHandlers: 2, oldestAbandonedStartedAt: ago(90_000) }),
    );
    assert.equal(body.abandonedHandlers, 2);
    assert.equal(body.oldestAbandonedAgeMs, 90_000);
  });

  it("stays healthy with frames left on closed connections only", () => {
    const body = healthy(
      socket({ closedConnectionFrames: 1, oldestClosedFrameStartedAt: ago(120_000) }),
    );
    assert.equal(body.closedConnectionFrames, 1);
    assert.equal(body.oldestClosedFrameAgeMs, 120_000);
  });
});
