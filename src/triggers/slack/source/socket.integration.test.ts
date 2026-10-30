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
