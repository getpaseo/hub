import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { DurableProviderEvent } from "../../../db/types.js";
import { runWithFailureTracking } from "../../../failures/index.js";
import type { TriggerHandler } from "../../index.js";
import { createLogger } from "../../../logger.js";
import { assertOneFailure, FailureLogStream } from "../../../test-utils/failure-logs.js";
import { startSlackSocketFixture } from "../../../test-utils/slack-socket-fixture.js";
import { createSlackEventSource } from "./index.js";
import { SLACK_SOCKET_PING_INTERVAL_MS, SLACK_SOCKET_PONG_TIMEOUT_MS } from "./internal/socket.js";

describe("Slack Socket Mode source", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(closers.splice(0).map((close) => close())));

  it("uses the app token and acknowledges only after the durable intake resolves", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acceptedInputs: Parameters<typeof createSlackEventSource>[0]["accept"] extends (
      input: infer T,
    ) => Promise<unknown>
      ? T[]
      : never = [];
    const source = socketSource(slack, async (input) => {
      acceptedInputs.push(input);
      await blocked;
      return { status: "accepted", events: [], receiptId: "receipt-123" };
    });

    await source.start(() => Promise.resolve());
    await waitFor(() => source.status().state === "connected");
    assert.equal(slack.authorization, "Bearer xapp-fixture-secret");
    slack.send(eventEnvelope("env-123", "E123"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(slack.acks, []);

    release?.();
    await waitFor(() => slack.acks.length === 1);
    assert.deepEqual(slack.acks, [{ envelope_id: "env-123" }]);
    assert.deepEqual(
      acceptedInputs.map((input) => {
        return { deliveryId: input.deliveryId, source: input.source, teamId: input.teamId };
      }),
      [{ deliveryId: "slack-E123", source: "slack.mention", teamId: "T123" }],
    );
    await source.stop();
  });

  it("stops retrying rejected app tokens and owns one secret-safe failure", async () => {
    const token = "xapp-token-canary-42";
    const bodyCanary = "provider-body-canary-91";
    const slack = await startSlackSocketFixture([
      { kind: "slackError", code: "invalid_auth", bodyCanary },
    ]);
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = socketSource(slack, () => Promise.reject(new Error("not reached")), token);

    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
    await waitFor(() => source.status().state === "actionNeeded");
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(slack.openCount, 1);
    const status = source.status();
    assert.equal(status.state === "actionNeeded" ? status.reason : undefined, "appTokenRejected");
    assertSlackFailure(stream, "slack.socket.authenticate", "authentication", token, 40);
    assert.equal(stream.text().includes(bodyCanary), false);
    await source.stop();
  });

  it("treats a wrong-app hello as terminal until an explicit retry", async () => {
    const slack = await startSlackSocketFixture([
      { kind: "socket", appId: "A-WRONG" },
      { kind: "socket" },
    ]);
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = socketSource(slack, accepted);

    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
    await waitFor(() => source.status().state === "actionNeeded");
    assert.equal(slack.openCount, 1);
    const status = source.status();
    assert.equal(
      status.state === "actionNeeded" ? status.reason : undefined,
      "appIdentityMismatch",
    );
    await source.retry();
    await waitFor(() => source.status().state === "connected");
    assert.equal(slack.openCount, 2);
    assertSlackFailure(
      stream,
      "slack.socket.authenticate",
      "authentication",
      "xapp-fixture-secret",
      40,
    );
    await source.stop();
  });

  it("retries a transient outage once without logging every reconnect", async () => {
    const slack = await startSlackSocketFixture([
      { kind: "http", status: 503 },
      { kind: "socket" },
    ]);
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = socketSource(slack, accepted);

    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
    await waitFor(() => source.status().state === "connected");

    assert.equal(slack.openCount, 2);
    assertSlackFailure(stream, "slack.socket.connect", "network", "xapp-fixture-secret");
    await source.stop();
  });

  it("reconnects cleanly for refresh and reports one abnormal close", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const cleanLogs = new FailureLogStream();
    const source = socketSource(slack, accepted);
    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(cleanLogs));
    await waitFor(() => source.status().state === "connected");

    slack.send({ type: "disconnect", reason: "refresh_requested" });
    await waitFor(() => slack.openCount === 2 && source.status().state === "connected");
    assert.equal(cleanLogs.records().length, 0);

    slack.terminateCurrent();
    await waitFor(() => slack.openCount === 3 && source.status().state === "connected");
    assertSlackFailure(cleanLogs, "slack.socket.connect", "network", "xapp-fixture-secret");
    await source.stop();
  });

  it("acknowledges a poison envelope once and never records its payload", async () => {
    const payloadCanary = "payload-canary-440";
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = socketSource(slack, accepted);
    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
    await waitFor(() => source.status().state === "connected");

    slack.send({ type: "events_api", envelope_id: "poison-1", payload: payloadCanary });
    await waitFor(() => slack.acks.length === 1);

    assert.deepEqual(slack.acks, [{ envelope_id: "poison-1" }]);
    assertSlackFailure(stream, "slack.socket.envelope.parse", "validation", payloadCanary, 40);
    await source.stop();
  });

  it("aborts a stalled open response and releases every transport on stop", async () => {
    const slack = await startSlackSocketFixture([{ kind: "unfinished", status: 200 }]);
    closers.push(() => slack.close());
    const source = socketSource(slack, accepted);
    await source.start(() => Promise.resolve());
    await waitFor(() => slack.openCount === 1);

    const started = Date.now();
    await source.stop();

    assert.ok(Date.now() - started < 1_000);
    await waitFor(() => slack.outstanding === 0);
    assert.equal(source.status().state, "stopped");
  });

  it("acknowledges after the accept and keeps reading while a handler hangs", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const dispatched: string[] = [];
    const source = socketSource(slack, acceptedWithEvent, undefined, { dispatchTimeoutMs: 300 });
    await source.start(async (trigger) => {
      dispatched.push(trigger.deliveryId);
      if (trigger.deliveryId === "slack-E1") await never;
    });
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    await waitFor(() => slack.acks.length === 1, 150);
    slack.send(eventEnvelope("env-2", "E2"));
    await waitFor(() => slack.acks.length === 2);

    assert.deepEqual(slack.acks, [{ envelope_id: "env-1" }, { envelope_id: "env-2" }]);
    assert.deepEqual(dispatched, ["slack-E1", "slack-E2"]);
    assert.equal(slack.openCount, 1);
    await source.stop();
  });

  it("never acknowledges an accept that outlives its timeout", async () => {
    const payloadCanary = "payload-canary-accept-77";
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    let releaseFirst: (() => void) | undefined;
    const firstAccept = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const dispatched: string[] = [];
    const source = socketSource(
      slack,
      async (input) => {
        if (input.deliveryId === "slack-E1") await firstAccept;
        return acceptedWithEvent(input);
      },
      undefined,
      { acceptTimeoutMs: 50, dispatchTimeoutMs: 60_000 },
    );
    const record: TriggerHandler = async (trigger) => {
      dispatched.push(trigger.deliveryId);
    };
    await runWithFailureTracking(() => source.start(record), createLogger(stream));
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1", payloadCanary));
    slack.send(eventEnvelope("env-2", "E2"));
    await waitFor(() => slack.acks.length === 1);
    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(slack.acks, [{ envelope_id: "env-2" }]);
    assert.deepEqual(dispatched, ["slack-E2"]);
    assert.equal(slack.openCount, 1);
    assertSlackFailure(stream, "slack.socket.accept_timeout", "internal", payloadCanary);
    assert.equal(stream.text().includes("xapp-fixture-secret"), false);
    await source.stop();
  });

  for (const [name, hung] of [
    ["an event", eventEnvelope("env-hang", "E1")],
    ["a poison envelope", { type: "events_api", envelope_id: "env-hang", payload: "poison" }],
  ] as const) {
    it(`drops the socket when the acknowledgement of ${name} is never written`, async () => {
      const slack = await startSlackSocketFixture();
      closers.push(() => slack.close());
      const stream = new FailureLogStream();
      // oxlint-disable-next-line typescript-eslint/unbound-method
      const send = WebSocket.prototype.send;
      const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
        this: WebSocket,
        ...args: Parameters<WebSocket["send"]>
      ) {
        // The fixture's server sockets share this prototype, so match only the ack frame.
        if (args[0] === JSON.stringify({ envelope_id: "env-hang" })) return;
        send.apply(this, args);
      });
      try {
        const source = socketSource(slack, acceptedWithEvent, undefined, { ackTimeoutMs: 50 });
        await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
        await waitFor(() => source.status().state === "connected");

        slack.send(hung);
        await waitFor(() => slack.openCount === 2 && source.status().state === "connected");
        slack.send(eventEnvelope("env-next", "E2"));
        await waitFor(() => slack.acks.length === 1);

        assert.deepEqual(slack.acks, [{ envelope_id: "env-next" }]);
        const timeouts = stream
          .records()
          .filter((record) => record["operation"] === "slack.socket.ack_timeout");
        assert.equal(timeouts.length, 1);
        assert.equal(timeouts[0]?.["failureKind"], "network");
        assert.equal(
          stream.records().some((record) => record["operation"] === "slack.socket.connect"),
          false,
        );
        await source.stop();
      } finally {
        spy.mockRestore();
      }
    });
  }

  it("reads the next connection's events while a closed connection's handler hangs", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const source = socketSource(slack, acceptedWithEvent, undefined, {
      dispatchTimeoutMs: 60_000,
    });
    await source.start(async (trigger) => {
      if (trigger.deliveryId === "slack-E1") await never;
    });
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    await waitFor(() => slack.acks.length === 1);
    slack.terminateCurrent();
    await waitFor(() => slack.openCount === 2 && source.status().state === "connected");
    slack.send(eventEnvelope("env-2", "E2"));
    await waitFor(() => slack.acks.length === 2);

    assert.deepEqual(slack.acks.at(-1), { envelope_id: "env-2" });
    await source.stop();
  });

  it("keeps a closed connection's late failure away from the next connection", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    let failFirst: ((error: Error) => void) | undefined;
    const firstAccept = new Promise<never>((_resolve, reject) => {
      failFirst = reject;
    });
    const source = socketSource(
      slack,
      async (input) => {
        if (input.deliveryId === "slack-E1") await firstAccept;
        return acceptedWithEvent(input);
      },
      undefined,
      { acceptTimeoutMs: 60_000 },
    );
    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    slack.terminateCurrent();
    await waitFor(() => slack.openCount === 2 && source.status().state === "connected");
    failFirst?.(new Error("late accept failure"));
    await waitFor(() => operations(stream).includes("slack.socket.handoff"));
    slack.terminateCurrent();
    await waitFor(() => slack.openCount === 3 && source.status().state === "connected");

    assert.deepEqual(operations(stream).toSorted(), [
      "slack.socket.connect",
      "slack.socket.connect",
      "slack.socket.handoff",
    ]);
    await source.stop();
  });

  it("neither acknowledges nor dispatches a closed connection's late accept", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    let releaseFirst: (() => void) | undefined;
    const firstAccept = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const dispatched: string[] = [];
    const source = socketSource(
      slack,
      async (input) => {
        if (input.deliveryId === "slack-E1") await firstAccept;
        return acceptedWithEvent(input);
      },
      undefined,
      { acceptTimeoutMs: 60_000 },
    );
    const record: TriggerHandler = async (trigger) => {
      dispatched.push(trigger.deliveryId);
    };
    await runWithFailureTracking(() => source.start(record), createLogger(stream));
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    slack.terminateCurrent();
    await waitFor(() => slack.openCount === 2 && source.status().state === "connected");
    releaseFirst?.();
    slack.send(eventEnvelope("env-2", "E2"));
    await waitFor(() => slack.acks.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(slack.acks, [{ envelope_id: "env-2" }]);
    assert.deepEqual(dispatched, ["slack-E2"]);
    assert.deepEqual(operations(stream), ["slack.socket.connect"]);
    await source.stop();
  });

  it("stops within its grace while a handler hangs", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const source = socketSource(slack, acceptedWithEvent, undefined, { stopGraceMs: 200 });
    await source.start(() => never);
    await waitFor(() => source.status().state === "connected");
    slack.send(eventEnvelope("env-1", "E1"));
    await waitFor(() => slack.acks.length === 1);

    const started = Date.now();
    await source.stop();

    assert.ok(Date.now() - started < 700);
    assert.equal(source.status().state, "stopped");
  });

  it("observes work that fails after its timeout", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const source = socketSource(
      slack,
      async (input) => {
        if (input.deliveryId === "slack-E1") {
          await new Promise((resolve) => setTimeout(resolve, 60));
          throw new Error("late accept failure");
        }
        return acceptedWithEvent(input);
      },
      undefined,
      { acceptTimeoutMs: 20, dispatchTimeoutMs: 20 },
    );
    await source.start(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new Error("late handler failure");
    });
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    slack.send(eventEnvelope("env-2", "E2"));
    await waitFor(() => slack.acks.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.deepEqual(slack.acks, [{ envelope_id: "env-2" }]);
    assert.equal(slack.openCount, 1);
    await source.stop();
  });
});

describe("Slack Socket Mode intake health", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(closers.splice(0).map((close) => close())));

  it("reports an idle connection with nothing queued or active", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const source = socketSource(slack, acceptedWithEvent);
    await source.start(ignoreTrigger);
    await waitFor(() => source.status().state === "connected");

    const health = intakeOf(source);
    assert.equal(health.state, "connected");
    assert.equal(health.queuedFrames, 0);
    assert.equal(health.activePhase, null);
    assert.equal(health.activePhaseStartedAt, null);
    assert.equal(health.lastCompletedAt, null);
    assert.equal(health.closedConnectionFrames, 0);
    await source.stop();
  });

  it("reports a hanging accept as an aging accept phase, then the stall and its recovery", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const source = socketSource(
      slack,
      async (input) => {
        if (input.deliveryId === "slack-E1") await never;
        return acceptedWithEvent(input);
      },
      undefined,
      { acceptTimeoutMs: 150 },
    );
    await source.start(ignoreTrigger);
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    await waitFor(() => intakeOf(source).activePhase === "accept");
    const startedAt = intakeOf(source).activePhaseStartedAt;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(intakeOf(source).activePhaseStartedAt, startedAt);
    assert.ok(Date.now() - (startedAt?.getTime() ?? Date.now()) >= 40);

    await waitFor(() => intakeOf(source).acceptTimeouts === 1);
    const stalled = intakeOf(source);
    assert.notEqual(stalled.lastAcceptTimeoutAt, null);
    assert.equal(stalled.lastAcceptOkAt, null);

    slack.send(eventEnvelope("env-2", "E2"));
    await waitFor(() => slack.acks.length === 1);
    const recovered = intakeOf(source);
    assert.ok(
      (recovered.lastAcceptOkAt?.getTime() ?? 0) >=
        (recovered.lastAcceptTimeoutAt?.getTime() ?? Infinity),
    );
    await source.stop();
  });

  it("counts frames queued behind a hanging handler", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const source = socketSource(slack, acceptedWithEvent, undefined, {
      dispatchTimeoutMs: 60_000,
      stopGraceMs: 100,
    });
    await source.start(() => never);
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    slack.send(eventEnvelope("env-2", "E2"));
    slack.send(eventEnvelope("env-3", "E3"));
    await waitFor(() => slack.acks.length === 1);
    await waitFor(() => intakeOf(source).queuedFrames === 2);

    assert.equal(intakeOf(source).activePhase, "dispatch");
    await source.stop();
  });

  it("restarts the phase clock for the ack and the dispatch after a slow accept", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    let acceptedAt = 0;
    const send = sendOf(WebSocket.prototype);
    const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket["send"]>
    ) {
      const callback = args.at(-1);
      if (
        args[0] === JSON.stringify({ envelope_id: "env-slow" }) &&
        typeof callback === "function"
      ) {
        send(this, [args[0]]);
        setTimeout(callback, 100);
        return;
      }
      send(this, args);
    });
    try {
      const source = socketSource(
        slack,
        async (input) => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          acceptedAt = Date.now();
          return acceptedWithEvent(input);
        },
        undefined,
        { acceptTimeoutMs: 300, dispatchTimeoutMs: 60_000, stopGraceMs: 100 },
      );
      await source.start(() => never);
      await waitFor(() => source.status().state === "connected");

      slack.send(eventEnvelope("env-slow", "E1"));
      await waitFor(() => intakeOf(source).activePhase === "ack", 1_000);
      const ack = intakeOf(source).activePhaseStartedAt?.getTime() ?? 0;
      assert.ok(ack >= acceptedAt && ack - acceptedAt < 50);
      await waitFor(() => intakeOf(source).activePhase === "dispatch", 1_000);
      const dispatch = intakeOf(source).activePhaseStartedAt?.getTime() ?? 0;
      assert.ok(dispatch - ack >= 90);
      await source.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the ack timeout count across the reconnect it causes", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const send = sendOf(WebSocket.prototype);
    const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket["send"]>
    ) {
      if (args[0] === JSON.stringify({ envelope_id: "env-hang" })) return;
      send(this, args);
    });
    try {
      const source = socketSource(slack, acceptedWithEvent, undefined, { ackTimeoutMs: 50 });
      await runWithFailureTracking(
        () => source.start(ignoreTrigger),
        createLogger(new FailureLogStream()),
      );
      await waitFor(() => source.status().state === "connected");

      slack.send(eventEnvelope("env-hang", "E1"));
      await waitFor(() => slack.openCount === 2 && source.status().state === "connected");

      assert.equal(intakeOf(source).ackTimeouts, 1);
      await source.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it("reports a handler that outlives its timeout as abandoned until it settles", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = socketSource(slack, acceptedWithEvent, undefined, { dispatchTimeoutMs: 50 });
    const hold: TriggerHandler = () => held;
    await runWithFailureTracking(() => source.start(hold), createLogger(new FailureLogStream()));
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    await waitFor(() => intakeOf(source).dispatchTimeouts === 1);
    const abandoned = intakeOf(source);
    assert.equal(abandoned.abandonedHandlers, 1);
    assert.equal(abandoned.activePhase, null);
    assert.equal(abandoned.queuedFrames, 0);
    const startedAt = abandoned.oldestAbandonedStartedAt;
    assert.notEqual(startedAt, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(intakeOf(source).oldestAbandonedStartedAt, startedAt);

    release?.();
    await waitFor(() => intakeOf(source).abandonedHandlers === 0);
    assert.equal(intakeOf(source).oldestAbandonedStartedAt, null);
    assert.equal(intakeOf(source).dispatchTimeouts, 1);
    await source.stop();
  });

  it("counts each abandoned handler call and forgets each as it settles", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: TriggerHandler = () => new Promise((resolve) => setTimeout(resolve, 120));
    const hold: TriggerHandler = () => held;
    const source = socketSource(slack, acceptedWithEvent, undefined, { dispatchTimeoutMs: 30 });
    await runWithFailureTracking(async () => {
      await source.start(slow);
      await source.start(hold);
    }, createLogger(new FailureLogStream()));
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    await waitFor(() => intakeOf(source).dispatchTimeouts === 1);
    assert.equal(intakeOf(source).abandonedHandlers, 2);
    await waitFor(() => intakeOf(source).abandonedHandlers === 1);
    release?.();
    await waitFor(() => intakeOf(source).abandonedHandlers === 0);
    await source.stop();
  });

  it("keeps a closed connection's hanging frame out of the current connection's fields", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    let releaseHandler: (() => void) | undefined;
    const handlerHeld = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const source = socketSource(
      slack,
      async (input) => {
        if (input.deliveryId === "slack-E2") await never;
        return acceptedWithEvent(input);
      },
      undefined,
      { acceptTimeoutMs: 60_000, dispatchTimeoutMs: 60_000, stopGraceMs: 100 },
    );
    const hold: TriggerHandler = () => handlerHeld;
    await runWithFailureTracking(() => source.start(hold), createLogger(new FailureLogStream()));
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    await waitFor(() => intakeOf(source).activePhase === "dispatch");
    slack.terminateCurrent();
    await waitFor(() => slack.openCount === 2 && source.status().state === "connected");
    slack.send(eventEnvelope("env-2", "E2"));
    slack.send(eventEnvelope("env-3", "E3"));
    await waitFor(() => intakeOf(source).queuedFrames === 1);

    const during = intakeOf(source);
    assert.equal(during.activePhase, "accept");
    assert.equal(during.closedConnectionFrames, 1);
    assert.notEqual(during.oldestClosedFrameStartedAt, null);

    releaseHandler?.();
    await waitFor(() => intakeOf(source).closedConnectionFrames === 0);
    const after = intakeOf(source);
    assert.equal(after.activePhase, "accept");
    assert.equal(after.activePhaseStartedAt, during.activePhaseStartedAt);
    assert.equal(after.queuedFrames, 1);
    assert.equal(after.oldestClosedFrameStartedAt, null);
    await source.stop();
  });

  it("keeps a closed connection's late accept timeout from marking a recovered source stalled", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const source = socketSource(
      slack,
      async (input) => {
        if (input.deliveryId === "slack-E1") await never;
        return acceptedWithEvent(input);
      },
      undefined,
      { acceptTimeoutMs: 300 },
    );
    await runWithFailureTracking(
      () => source.start(ignoreTrigger),
      createLogger(new FailureLogStream()),
    );
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    await waitFor(() => intakeOf(source).activePhase === "accept");
    slack.terminateCurrent();
    await waitFor(() => slack.openCount === 2 && source.status().state === "connected");
    slack.send(eventEnvelope("env-2", "E2"));
    await waitFor(() => slack.acks.length === 1);
    await waitFor(() => intakeOf(source).acceptTimeouts === 1);

    const health = intakeOf(source);
    assert.notEqual(health.lastAcceptOkAt, null);
    assert.equal(health.lastAcceptTimeoutAt, null);
    await source.stop();
  });

  it("keeps the newest success when accepts on older connections finish out of order", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    let releaseFirst: (() => void) | undefined;
    const firstAccept = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const source = socketSource(
      slack,
      async (input) => {
        if (input.deliveryId === "slack-E1") await firstAccept;
        if (input.deliveryId === "slack-E2") await never;
        return acceptedWithEvent(input);
      },
      undefined,
      { acceptTimeoutMs: 800 },
    );
    await runWithFailureTracking(
      () => source.start(ignoreTrigger),
      createLogger(new FailureLogStream()),
    );
    await waitFor(() => source.status().state === "connected");

    // E1 starts on the first connection, E2 on the second, E3 on the third.
    slack.send(eventEnvelope("env-1", "E1"));
    await waitFor(() => intakeOf(source).activePhase === "accept");
    slack.terminateCurrent();
    await waitFor(() => slack.openCount === 2 && source.status().state === "connected");
    slack.send(eventEnvelope("env-2", "E2"));
    await waitFor(() => intakeOf(source).activePhase === "accept");
    slack.terminateCurrent();
    await waitFor(() => slack.openCount === 3 && source.status().state === "connected");
    slack.send(eventEnvelope("env-3", "E3"));
    await waitFor(() => slack.acks.length === 1);
    // E1 succeeds after E3, then E2 times out: E3 began after E2 and succeeded.
    releaseFirst?.();
    await waitFor(() => intakeOf(source).acceptTimeouts === 1);

    assert.equal(intakeOf(source).lastAcceptTimeoutAt, null);
    await source.stop();
  });

  it("does not count an ignored event as a successful accept", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const durable: string[] = [];
    const source = socketSource(
      slack,
      async (input) => {
        durable.push(input.deliveryId);
        await never;
        return acceptedWithEvent(input);
      },
      undefined,
      { acceptTimeoutMs: 100 },
    );
    await runWithFailureTracking(
      () => source.start(ignoreTrigger),
      createLogger(new FailureLogStream()),
    );
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    await waitFor(() => intakeOf(source).acceptTimeouts === 1);
    const fromBot = eventEnvelope("env-2", "E2");
    slack.send({
      ...fromBot,
      payload: { ...fromBot.payload, event: { ...fromBot.payload.event, bot_id: "B123" } },
    });
    await waitFor(() => slack.acks.length === 1);

    assert.deepEqual(durable, ["slack-E1"]);
    const health = intakeOf(source);
    assert.equal(health.lastAcceptOkAt, null);
    assert.notEqual(health.lastAcceptTimeoutAt, null);
    await source.stop();
  });

  it("keeps the deadline for the other handlers when one fails", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const fail: TriggerHandler = () => Promise.reject(new Error("handler failed"));
    const hold: TriggerHandler = () => never;
    const source = socketSource(slack, acceptedWithEvent, undefined, {
      dispatchTimeoutMs: 50,
      stopGraceMs: 100,
    });
    await runWithFailureTracking(async () => {
      await source.start(fail);
      await source.start(hold);
    }, createLogger(stream));
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    await waitFor(() => intakeOf(source).dispatchTimeouts === 1);

    assert.equal(intakeOf(source).abandonedHandlers, 1);
    assert.deepEqual(operations(stream).toSorted(), [
      "slack.socket.dispatch_timeout",
      "slack.socket.handoff",
    ]);
    await source.stop();
  });

  it("stamps the state change once across failed reconnect attempts", async () => {
    const slack = await startSlackSocketFixture([
      { kind: "socket" },
      { kind: "http", status: 503 },
      { kind: "http", status: 503 },
      { kind: "unfinished", status: 200 },
    ]);
    closers.push(() => slack.close());
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-fixture-secret",
      },
      socket: { apiUrl: slack.openUrl, random: () => 0.05, timeoutMs: 250 },
      accept: acceptedWithEvent,
    });
    await runWithFailureTracking(
      () => source.start(ignoreTrigger),
      createLogger(new FailureLogStream()),
    );
    await waitFor(() => source.status().state === "connected");

    slack.terminateCurrent();
    await waitFor(() => slack.openCount === 2);
    const first = intakeOf(source);
    assert.equal(first.state, "reconnecting");
    await waitFor(() => slack.openCount === 4);
    const later = intakeOf(source);

    assert.equal(later.state, "reconnecting");
    assert.equal(later.stateChangedAt, first.stateChangedAt);
    await source.stop();
  });

  it("advances the last completion time as each frame leaves the chain", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const source = socketSource(slack, acceptedWithEvent);
    await source.start(ignoreTrigger);
    await waitFor(() => source.status().state === "connected");

    slack.send(eventEnvelope("env-1", "E1"));
    await waitFor(() => intakeOf(source).lastCompletedAt !== null);
    const first = intakeOf(source).lastCompletedAt?.getTime() ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
    slack.send(eventEnvelope("env-2", "E2"));
    await waitFor(() => (intakeOf(source).lastCompletedAt?.getTime() ?? 0) > first);
    await source.stop();
  });
});

describe("Slack Socket Mode liveness", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(closers.splice(0).map((close) => close())));
  const pingIntervalMs = 50;
  const pongTimeoutMs = 50;

  it("detects within the production bound", () => {
    assert.equal(SLACK_SOCKET_PING_INTERVAL_MS, 30_000);
    assert.equal(SLACK_SOCKET_PONG_TIMEOUT_MS, 10_000);
    assert.ok(SLACK_SOCKET_PING_INTERVAL_MS + SLACK_SOCKET_PONG_TIMEOUT_MS <= 40_000);
  });

  it("records pongs and reopens a socket whose peer stops answering", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = socketSource(slack, acceptedWithEvent, undefined, {
      pingIntervalMs,
      pongTimeoutMs,
    });
    await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
    await waitFor(() => source.status().state === "connected");
    assert.equal(intakeOf(source).lastPongAt, null);
    await waitFor(() => intakeOf(source).lastPongAt !== null);
    assert.ok(Date.now() - (intakeOf(source).lastPongAt?.getTime() ?? 0) < 200);

    const pausedAt = Date.now();
    slack.pauseCurrent();
    await waitFor(() => slack.openCount === 2 && source.status().state === "connected");

    assert.ok(Date.now() - pausedAt <= pingIntervalMs + pongTimeoutMs + 500);
    assertSlackFailure(stream, "slack.socket.ping_timeout", "network", "xapp-fixture-secret");
    await source.stop();
  });

  it("reports a ping timeout once when it fails an acknowledgement still being written", async () => {
    const slack = await startSlackSocketFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    let held: ((error: Error) => void) | undefined;
    const send = sendOf(WebSocket.prototype);
    const terminate = terminateOf(WebSocket.prototype);
    const sendSpy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket["send"]>
    ) {
      const callback = args.at(-1);
      if (
        args[0] === JSON.stringify({ envelope_id: "env-held" }) &&
        typeof callback === "function"
      ) {
        held = callback;
        return;
      }
      send(this, args);
    });
    const terminateSpy = vi
      .spyOn(WebSocket.prototype, "terminate")
      .mockImplementation(function (this: WebSocket) {
        terminate(this);
        const fail = held;
        held = undefined;
        fail?.(new Error("WebSocket is not open"));
      });
    try {
      const source = socketSource(slack, acceptedWithEvent, undefined, {
        pingIntervalMs,
        pongTimeoutMs,
        ackTimeoutMs: 60_000,
      });
      await runWithFailureTracking(() => source.start(ignoreTrigger), createLogger(stream));
      await waitFor(() => source.status().state === "connected");

      slack.send(eventEnvelope("env-held", "E1"));
      await waitFor(() => intakeOf(source).activePhase === "ack");
      slack.pauseCurrent();
      await waitFor(() => slack.openCount === 2 && source.status().state === "connected");

      assert.deepEqual(operations(stream), ["slack.socket.ping_timeout"]);
      await source.stop();
    } finally {
      sendSpy.mockRestore();
      terminateSpy.mockRestore();
    }
  });

  it("starts the reconnect within a second of the termination and opens when Slack answers late", async () => {
    const slack = await startSlackSocketFixture([
      { kind: "socket" },
      { kind: "socket", delayMs: 150 },
    ]);
    closers.push(() => slack.close());
    let terminatedAt: number | undefined;
    const terminate = terminateOf(WebSocket.prototype);
    const spy = vi
      .spyOn(WebSocket.prototype, "terminate")
      .mockImplementation(function (this: WebSocket) {
        terminatedAt ??= Date.now();
        terminate(this);
      });
    try {
      // 0.8 of the first attempt's one-second cap, so the retry delay is really sampled.
      const source = socketSource(slack, acceptedWithEvent, undefined, {
        pingIntervalMs,
        pongTimeoutMs,
        random: () => 0.8,
      });
      await runWithFailureTracking(
        () => source.start(ignoreTrigger),
        createLogger(new FailureLogStream()),
      );
      await waitFor(() => source.status().state === "connected");

      slack.pauseCurrent();
      await waitFor(() => slack.openCount === 2, pingIntervalMs + pongTimeoutMs + 2_000);
      const reopenedAfter = (slack.openTimes[1] ?? Infinity) - (terminatedAt ?? -Infinity);
      assert.ok(
        reopenedAfter >= 700 && reopenedAfter <= 1_000,
        `reconnect started ${reopenedAfter} ms after the termination`,
      );
      assert.notEqual(source.status().state, "connected");
      await waitFor(() => source.status().state === "connected");
      await source.stop();
    } finally {
      spy.mockRestore();
    }
  });
});

function intakeOf(source: ReturnType<typeof createSlackEventSource>) {
  const health = source.intake();
  if (health.transport !== "socket") throw new Error("expected Socket Mode intake health");
  return health;
}

/** Calls the real terminate even while the prototype is spied on. */
function terminateOf(prototype: WebSocket): (socket: WebSocket) => void {
  // oxlint-disable-next-line typescript-eslint/unbound-method
  const terminate = prototype.terminate;
  return (socket) => {
    Reflect.apply(terminate, socket, []);
  };
}

/** Calls the real send even while the prototype is spied on. */
function sendOf(prototype: WebSocket): (socket: WebSocket, args: readonly unknown[]) => void {
  // oxlint-disable-next-line typescript-eslint/unbound-method
  const original = prototype.send;
  return (socket, args) => {
    Reflect.apply(original, socket, args);
  };
}

type SocketTuning = NonNullable<Parameters<typeof createSlackEventSource>[0]["socket"]>;

function socketSource(
  slack: { openUrl: string },
  accept: Parameters<typeof createSlackEventSource>[0]["accept"],
  appToken = "xapp-fixture-secret",
  tuning: SocketTuning = {},
) {
  return createSlackEventSource({
    configuration: { provider: "slack", transport: "socket", appId: "A123", appToken },
    socket: { apiUrl: slack.openUrl, random: () => 0, timeoutMs: 250, ...tuning },
    accept,
  });
}

const never = new Promise<never>(() => undefined);

const acceptedWithEvent: Parameters<typeof createSlackEventSource>[0]["accept"] = (input) =>
  Promise.resolve({
    status: "accepted",
    receiptId: `receipt-${input.deliveryId}`,
    events: [
      {
        providerEventReceiptId: `receipt-${input.deliveryId}`,
        organizationId: "org-1",
        projectId: "project-1",
        configurationRevisionId: "revision-1",
        deliveryId: input.deliveryId,
        source: input.source,
        payload: input.payload,
        receivedAt: input.receivedAt,
        connectionId: null,
        resourceId: null,
      } satisfies DurableProviderEvent,
    ],
  });

function operations(stream: FailureLogStream): string[] {
  return stream.records().map((record) => String(record["operation"]));
}

const accepted: Parameters<typeof createSlackEventSource>[0]["accept"] = () =>
  Promise.resolve({ status: "accepted", events: [], receiptId: "receipt-123" });
const ignoreTrigger = () => Promise.resolve();

function assertSlackFailure(
  stream: FailureLogStream,
  operation: string,
  failureKind: string,
  canary: string,
  level?: number,
) {
  assertOneFailure(stream, {
    operation,
    component: "triggers",
    failureKind,
    canary,
    ...(level === undefined ? {} : { level }),
  });
}

function eventEnvelope(envelopeId: string, eventId: string, text = "<@UBOT> hello") {
  return {
    type: "events_api",
    envelope_id: envelopeId,
    payload: {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A123",
      event_id: eventId,
      event_time: 1_700_000_000,
      event: {
        type: "app_mention",
        user: "U123",
        channel: "C123",
        text,
        ts: "1700000000.001",
        event_ts: "1700000000.001",
      },
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
