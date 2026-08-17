import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, describe, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { runWithFailureTracking } from "../../../failures/index.js";
import { createLogger } from "../../../logger.js";
import { assertOneFailure, FailureLogStream } from "../../../test-utils/failure-logs.js";
import { createSlackEventSource } from "./index.js";
import type { DurableProviderEvent } from "../../../db/types.js";
import { createMemoryDatabase } from "../../../db/memory.js";
import type { AuthServer } from "../../../auth/server.js";
import type { ProviderRegistration } from "../../../providers/registration.js";
import { DynamicProviderRuntime } from "../../../provider-applications/internal/runtime-owner.js";

describe("Slack Socket Mode source", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0).toReversed()) await close();
  });

  it("cuts over real Socket admissions only when a healthy replacement is published", async () => {
    const slack = await startSlackFixture();
    closers.push(() => slack.close());
    const accepted: number[] = [];
    const runtime = new DynamicProviderRuntime({
      database: createMemoryDatabase(),
      auth: unusedAuth(),
      applicationBaseUrl: "https://hub.test",
      registrationFactory: ({ configuration, configurationVersion }) => {
        if (configuration.provider !== "slack") throw new Error("expected Slack configuration");
        const events = createSlackEventSource({
          configuration,
          configurationVersion,
          socket: { apiUrl: slack.openUrl },
          accept: (input) =>
            Promise.resolve({
              status: "accepted" as const,
              receiptId: `receipt-${input.deliveryId}`,
              events: [
                {
                  ...acceptedEvent(),
                  providerEventReceiptId: `receipt-${input.deliveryId}`,
                  deliveryId: input.deliveryId,
                  payload: { configurationVersion },
                },
              ],
            }),
        });
        return socketRegistration(events.source, () => events.status());
      },
    });
    const stable = runtime
      .registrations()
      .find((registration) => registration.connection.name === "slack")!;
    closers.push(() => stable.sources[0]!.stop());
    await stable.sources[0]!.start((event) => {
      accepted.push(eventConfigurationVersion(event.payload));
      return Promise.resolve();
    });
    const configuration = {
      provider: "slack" as const,
      transport: "socket" as const,
      appId: "A123",
      appToken: "xapp-fixture-secret",
    };
    const first = await runtime.prepare(
      "slack",
      configuration,
      "https://hub.test",
      { provider: "slack", id: "A123", name: "Paseo" },
      1,
    );
    await first.start();
    first.publish();
    slack.send(mentionEnvelope("env-cutover-one", "E-cutover-one"));
    await waitUntil(() => accepted.length === 1 && slack.acks.length === 1);

    const replacement = await runtime.prepare(
      "slack",
      configuration,
      "https://hub.test",
      { provider: "slack", id: "A123", name: "Paseo" },
      2,
    );
    await replacement.start();
    slack.send(mentionEnvelope("env-cutover-two", "E-cutover-two"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(accepted, [1]);
    assert.equal(slack.acks.length, 1);

    replacement.publish();
    await slack.firstClosed;
    await waitUntil(() => accepted.length === 2 && slack.acks.length === 2);
    assert.deepEqual(accepted, [1, 2]);
  });

  it("finishes an old admitted event after cutover and leaves its retry for the new socket", async () => {
    const slack = await startSlackFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    let releaseAcceptance: (() => void) | undefined;
    let markAcceptanceStarted: (() => void) | undefined;
    const acceptanceGate = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    const acceptanceStarted = new Promise<void>((resolve) => {
      markAcceptanceStarted = resolve;
    });
    const seen = new Set<string>();
    let workflows = 0;
    const runtime = new DynamicProviderRuntime({
      database: createMemoryDatabase(),
      auth: unusedAuth(),
      applicationBaseUrl: "https://hub.test",
      registrationFactory: ({ configuration, configurationVersion }) => {
        if (configuration.provider !== "slack") throw new Error("expected Slack configuration");
        const events = createSlackEventSource({
          configuration,
          configurationVersion,
          socket: { apiUrl: slack.openUrl, shutdownTimeoutMs: 20 },
          accept: async (input) => {
            if (seen.has(input.deliveryId)) {
              return { status: "duplicate", receiptId: "receipt-cutover-retry" };
            }
            seen.add(input.deliveryId);
            markAcceptanceStarted?.();
            await acceptanceGate;
            return {
              status: "accepted",
              receiptId: "receipt-cutover-retry",
              events: [acceptedEvent()],
            };
          },
        });
        return socketRegistration(events.source, () => events.status());
      },
    });
    const stable = runtime
      .registrations()
      .find((registration) => registration.connection.name === "slack")!;
    closers.push(() => stable.sources[0]!.stop());
    await stable.sources[0]!.start(() => {
      workflows += 1;
      return Promise.resolve();
    });
    const configuration = {
      provider: "slack" as const,
      transport: "socket" as const,
      appId: "A123",
      appToken: "xapp-cutover-retry-canary",
    };
    const first = await runtime.prepare(
      "slack",
      configuration,
      "https://hub.test",
      { provider: "slack", id: "A123", name: "Paseo" },
      1,
    );
    await runWithFailureTracking(() => first.start(), createLogger(stream));
    first.publish();
    slack.send(mentionEnvelope("env-cutover-retry", "E-cutover-retry"));
    await acceptanceStarted;

    const replacement = await runtime.prepare(
      "slack",
      configuration,
      "https://hub.test",
      { provider: "slack", id: "A123", name: "Paseo" },
      2,
    );
    await runWithFailureTracking(() => replacement.start(), createLogger(stream));
    replacement.publish();
    await slack.firstClosed;
    releaseAcceptance?.();
    await waitUntil(() => workflows === 1);

    slack.send(mentionEnvelope("env-cutover-retry", "E-cutover-retry"));
    await slack.waitForAck();
    assert.equal(workflows, 1);
    assert.deepEqual(slack.acks, [{ envelope_id: "env-cutover-retry" }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(stream.records(), []);
  });

  it("opens with the app token and acknowledges only after durable handoff", async () => {
    const slack = await startSlackFixture();
    closers.push(() => slack.close());
    let releaseHandoff: (() => void) | undefined;
    const handedOff = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-fixture-secret",
      },
      configurationVersion: 7,
      socket: { apiUrl: slack.openUrl },
      accept: async (input) => {
        assert.equal(input.deliveryId, "slack-E123");
        await handedOff;
        return { status: "accepted", events: [], receiptId: "receipt-123" };
      },
    });

    const started = source.source.start(ignoreEvent);
    await slack.connected;
    assert.equal(slack.authorization, "Bearer xapp-fixture-secret");
    await started;
    const connectedStatus = source.status();
    assert.equal(connectedStatus.state, "connected");
    assert.deepEqual(connectedStatus, {
      state: "connected",
      since: connectedStatus.state === "connected" ? connectedStatus.since : undefined,
      connectionCount: 1,
    });

    slack.send({
      type: "events_api",
      envelope_id: "env-123",
      accepts_response_payload: false,
      payload: {
        type: "event_callback",
        team_id: "T123",
        api_app_id: "A123",
        event_id: "E123",
        event_time: 1_700_000_000,
        event: {
          type: "app_mention",
          user: "U123",
          channel: "C123",
          text: "<@UBOT> hello",
          ts: "1700000000.001",
          event_ts: "1700000000.001",
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(slack.acks, []);

    releaseHandoff?.();
    await slack.waitForAck();
    assert.deepEqual(slack.acks, [{ envelope_id: "env-123" }]);
    await source.source.stop();
  });

  it("owns a rejected app token with one structured secret-safe failure", async () => {
    const token = "xapp-formatless-canary-42";
    const bodyCanary = "formatless-slack-body-canary-91";
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: false,
          error: "invalid_auth",
          detail: bodyCanary,
        }),
      );
    });
    await listen(server);
    closers.push(() => closeServer(server));
    const stream = new FailureLogStream();
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: token,
      },
      configurationVersion: 8,
      socket: {
        apiUrl: `http://127.0.0.1:${port(server)}/api/apps.connections.open`,
      },
      accept: () => Promise.reject(new Error("not reached")),
    });
    closers.push(() => source.source.stop());

    const ignorePendingEvent = () => Promise.resolve();
    const starting = runWithFailureTracking(
      () => source.source.start(ignorePendingEvent),
      createLogger(stream),
    );
    await assert.rejects(starting);

    assert.deepEqual(source.status().state, "actionNeeded");
    assertOneFailure(stream, {
      operation: "slack.socket.authenticate",
      component: "triggers",
      failureKind: "authentication",
      level: 40,
      canary: token,
    });
    assert.equal(stream.text().includes(bodyCanary), false);
    await source.source.stop();
  });

  it("opens a healthy replacement before retiring a refresh-requested socket", async () => {
    const slack = await startSlackFixture();
    closers.push(() => slack.close());
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-fixture-secret",
      },
      configurationVersion: 9,
      socket: { apiUrl: slack.openUrl },
      accept: () =>
        Promise.resolve({
          status: "accepted",
          events: [],
          receiptId: "unused",
        }),
    });
    await source.source.start(ignoreEvent);

    slack.send({ type: "disconnect", reason: "refresh_requested" });
    await slack.secondConnected;
    await slack.firstClosed;

    assert.equal(slack.connectionCount, 2);
    assert.equal(source.status().state, "connected");
    await source.source.stop();
  });

  it("retries real 503 and 429 open responses before connecting", async () => {
    const slack = await startSlackFixture({
      openResponses: [
        { status: 503, body: { ok: false, error: "temporarily_unavailable" } },
        {
          status: 429,
          headers: { "retry-after": "0" },
          body: { ok: false, error: "ratelimited" },
        },
      ],
    });
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-retry-canary",
      },
      configurationVersion: 10,
      socket: {
        apiUrl: slack.openUrl,
        random: () => 0,
        readinessTimeoutMs: 500,
      },
      accept: () =>
        Promise.resolve({
          status: "accepted",
          events: [],
          receiptId: "unused",
        }),
    });
    closers.push(() => source.source.stop());

    await runWithFailureTracking(() => source.source.start(ignoreEvent), createLogger(stream));

    assert.equal(slack.openRequestCount, 3);
    assert.equal(stream.records().length, 1);
    assert.equal(source.status().state, "connected");
  });

  for (const reason of ["warning", "refresh_requested"] as const) {
    it(`overlaps a healthy replacement for Slack ${reason}`, async () => {
      const slack = await startSlackFixture();
      closers.push(() => slack.close());
      const source = createSlackEventSource({
        configuration: {
          provider: "slack",
          transport: "socket",
          appId: "A123",
          appToken: "xapp-refresh-canary",
        },
        configurationVersion: 11,
        socket: { apiUrl: slack.openUrl },
        accept: () =>
          Promise.resolve({
            status: "accepted",
            events: [],
            receiptId: "unused",
          }),
      });
      closers.push(() => source.source.stop());
      await source.source.start(ignoreEvent);

      slack.send({ type: "disconnect", reason });
      await slack.secondConnected;
      await slack.firstClosed;

      assert.equal(source.status().state, "connected");
      assert.equal(slack.connectionCount, 2);
    });
  }

  it("turns link_disabled into one actionable terminal failure", async () => {
    const slack = await startSlackFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-disabled-canary",
      },
      configurationVersion: 12,
      socket: { apiUrl: slack.openUrl },
      accept: () =>
        Promise.resolve({
          status: "accepted",
          events: [],
          receiptId: "unused",
        }),
    });
    closers.push(() => source.source.stop());
    await runWithFailureTracking(() => source.source.start(ignoreEvent), createLogger(stream));

    slack.send({ type: "disconnect", reason: "link_disabled" });
    await waitUntil(() => source.status().state === "actionNeeded");

    assert.deepEqual(source.status().state, "actionNeeded");
    assertOneFailure(stream, {
      operation: "slack.socket.disconnect",
      component: "triggers",
      failureKind: "validation",
      level: 40,
      canary: "xapp-disabled-canary",
    });
  });

  it("acks a poison envelope once after recording one safe parse failure", async () => {
    const slack = await startSlackFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-poison-canary",
      },
      configurationVersion: 13,
      socket: { apiUrl: slack.openUrl },
      accept: () => Promise.reject(new Error("not reached")),
    });
    closers.push(() => source.source.stop());
    await runWithFailureTracking(() => source.source.start(ignoreEvent), createLogger(stream));

    slack.send({
      type: "events_api",
      envelope_id: "env-poison",
      payload: { bad: true },
    });
    await slack.waitForAck();

    assert.deepEqual(slack.acks, [{ envelope_id: "env-poison" }]);
    assertOneFailure(stream, {
      operation: "slack.socket.envelope.parse",
      component: "triggers",
      failureKind: "validation",
      level: 40,
      canary: "xapp-poison-canary",
    });
  });

  it("owns an acknowledgement failure after a real peer disconnect", async () => {
    const slack = await startSlackFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    let releaseAcceptance: (() => void) | undefined;
    let markAcceptanceStarted: (() => void) | undefined;
    const acceptanceStarted = new Promise<void>((resolve) => {
      markAcceptanceStarted = resolve;
    });
    const acceptance = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-ack-canary",
      },
      configurationVersion: 14,
      socket: { apiUrl: slack.openUrl, random: () => 0 },
      accept: async () => {
        markAcceptanceStarted?.();
        await acceptance;
        return { status: "accepted", events: [], receiptId: "receipt-ack" };
      },
    });
    closers.push(() => source.source.stop());
    await runWithFailureTracking(() => source.source.start(ignoreEvent), createLogger(stream));
    slack.send(mentionEnvelope("env-ack-failure", "E-ack-failure"));
    await acceptanceStarted;
    slack.terminateLatest();
    await slack.firstClosed;
    await slack.secondConnected;
    releaseAcceptance?.();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(
      stream.records().map((record) => record["operation"]),
      ["slack.socket.ack"],
    );
    assertOneFailure(stream, {
      operation: "slack.socket.ack",
      component: "triggers",
      canary: "xapp-ack-canary",
    });
  });

  it("recovers delivery health after an acknowledged rate limit notice and successful event", async () => {
    const slack = await startSlackFixture();
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    let dispatches = 0;
    const countDispatch = () => {
      dispatches += 1;
      return Promise.resolve();
    };
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-rate-limit-recovery-canary",
      },
      configurationVersion: 17,
      socket: { apiUrl: slack.openUrl },
      accept: (input) =>
        Promise.resolve({
          status: "accepted",
          events: [{ ...acceptedEvent(), deliveryId: input.deliveryId }],
          receiptId: `receipt-${input.deliveryId}`,
        }),
    });
    closers.push(() => source.source.stop());
    await runWithFailureTracking(() => source.source.start(countDispatch), createLogger(stream));

    slack.send({
      type: "events_api",
      envelope_id: "env-rate-limited",
      payload: { type: "app_rate_limited", team_id: "T123", minute_rate_limited: 123 },
    });
    await slack.waitForAck();
    assert.equal(source.status().state, "rateLimited");

    slack.send(mentionEnvelope("env-rate-limit-recovered", "E-rate-limit-recovered"));
    await waitUntil(() => slack.acks.length === 2 && dispatches === 1);

    assert.equal(source.status().state, "connected");
    assert.deepEqual(slack.acks, [
      { envelope_id: "env-rate-limited" },
      { envelope_id: "env-rate-limit-recovered" },
    ]);
    assertOneFailure(stream, {
      operation: "slack.socket.event.rate_limited",
      component: "triggers",
      failureKind: "rateLimited",
      canary: "xapp-rate-limit-recovery-canary",
    });
  });

  it("bounds initial readiness while a transient Slack outage keeps reconnecting", async () => {
    const canary = "xapp-readiness-canary-51";
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "temporarily_unavailable" }));
    });
    await listen(server);
    closers.push(() => closeServer(server));
    const stream = new FailureLogStream();
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: canary,
      },
      configurationVersion: 10,
      socket: {
        apiUrl: `http://127.0.0.1:${port(server)}/api/apps.connections.open`,
        readinessTimeoutMs: 40,
        random: () => 1,
      },
      accept: () => Promise.reject(new Error("not reached")),
    });
    closers.push(() => source.source.stop());

    const outcome = await Promise.race([
      runWithFailureTracking(() => source.source.start(ignoreEvent), createLogger(stream)).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 150)),
    ]);

    assert.equal(outcome, "rejected");
    assertOneFailure(stream, {
      operation: "slack.socket.connect",
      component: "triggers",
      failureKind: "network",
      canary,
    });
    await source.source.stop();
  });

  it("does not finish shutdown until an admitted event is handed off and acknowledged", async () => {
    const slack = await startSlackFixture();
    closers.push(() => slack.close());
    let releaseAcceptance: (() => void) | undefined;
    let markAcceptanceStarted: (() => void) | undefined;
    const acceptanceStarted = new Promise<void>((resolve) => {
      markAcceptanceStarted = resolve;
    });
    const acceptance = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-shutdown-canary",
      },
      configurationVersion: 11,
      socket: { apiUrl: slack.openUrl, shutdownTimeoutMs: 500 },
      accept: async () => {
        markAcceptanceStarted?.();
        await acceptance;
        return {
          status: "accepted",
          events: [],
          receiptId: "receipt-shutdown",
        };
      },
    });
    closers.push(() => source.source.stop());
    await source.source.start(ignoreEvent);
    slack.send(mentionEnvelope("env-shutdown", "E-shutdown"));
    await acceptanceStarted;

    let stopped = false;
    const stopping = source.source.stop().then(() => {
      stopped = true;
      return undefined;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(stopped, false);
    assert.deepEqual(slack.acks, []);

    releaseAcceptance?.();
    await stopping;
    assert.deepEqual(slack.acks, [{ envelope_id: "env-shutdown" }]);
  });

  it("retains the admitted dispatch obligation after bounded transport shutdown", async () => {
    const slack = await startSlackFixture();
    closers.push(() => slack.close());
    let releaseAcceptance: (() => void) | undefined;
    let markAcceptanceStarted: (() => void) | undefined;
    const acceptanceStarted = new Promise<void>((resolve) => {
      markAcceptanceStarted = resolve;
    });
    const acceptance = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    let dispatches = 0;
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-long-admission-canary",
      },
      configurationVersion: 18,
      socket: { apiUrl: slack.openUrl, shutdownTimeoutMs: 20 },
      accept: async () => {
        markAcceptanceStarted?.();
        await acceptance;
        return {
          status: "accepted",
          events: [acceptedEvent()],
          receiptId: "receipt-long-admission",
        };
      },
    });
    closers.push(() => source.source.stop());
    await source.source.start(() => {
      dispatches += 1;
      return Promise.resolve();
    });
    slack.send(mentionEnvelope("env-long-admission", "E-long-admission"));
    await acceptanceStarted;

    await source.source.stop();
    assert.equal(dispatches, 0);
    releaseAcceptance?.();
    await source.source.drain?.();

    assert.equal(dispatches, 1);
    assert.deepEqual(slack.acks, []);
  });

  it("drains dispatch before shutdown returns and acknowledges", async () => {
    const slack = await startSlackFixture();
    closers.push(() => slack.close());
    let releaseDispatch: (() => void) | undefined;
    let markDispatchStarted: (() => void) | undefined;
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    const dispatch = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-dispatch-canary",
      },
      configurationVersion: 15,
      socket: { apiUrl: slack.openUrl, shutdownTimeoutMs: 500 },
      accept: () =>
        Promise.resolve({
          status: "accepted",
          events: [acceptedEvent()],
          receiptId: "receipt-dispatch",
        }),
    });
    closers.push(() => source.source.stop());
    await source.source.start(async () => {
      markDispatchStarted?.();
      await dispatch;
    });
    slack.send(mentionEnvelope("env-dispatch", "E-dispatch"));
    await dispatchStarted;

    let stopped = false;
    const stopping = source.source.stop().then(() => {
      stopped = true;
      return undefined;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(stopped, false);
    releaseDispatch?.();
    await stopping;

    assert.deepEqual(slack.acks, [{ envelope_id: "env-dispatch" }]);
  });

  it("drains the acknowledgement when shutdown begins as dispatch returns", async () => {
    const slack = await startSlackFixture();
    closers.push(() => slack.close());
    let stopping: Promise<void> | undefined;
    let markShutdownStarted: (() => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      markShutdownStarted = resolve;
    });
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: "xapp-ack-shutdown-canary",
      },
      configurationVersion: 16,
      socket: { apiUrl: slack.openUrl, shutdownTimeoutMs: 500 },
      accept: () =>
        Promise.resolve({
          status: "accepted",
          events: [acceptedEvent()],
          receiptId: "receipt-ack-shutdown",
        }),
    });
    closers.push(() => source.source.stop());
    await source.source.start(() => {
      stopping = source.source.stop();
      markShutdownStarted?.();
      return Promise.resolve();
    });
    slack.send(mentionEnvelope("env-ack-shutdown", "E-ack-shutdown"));
    await shutdownStarted;
    await stopping;

    assert.deepEqual(slack.acks, [{ envelope_id: "env-ack-shutdown" }]);
    const completedWork = slack.acks.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(slack.acks.length, completedWork);
  });

  it.each([
    ["malformed", (canary: string) => `not-json-${canary}`],
    [
      "wrong-app",
      (canary: string) =>
        JSON.stringify({
          type: "hello",
          connection_info: { app_id: `wrong-${canary}` },
          num_connections: 1,
        }),
    ],
  ])("gives a %s pre-hello frame one secret-safe failure owner", async (_kind, frame) => {
    const canary = "xapp-prehello-canary-73";
    const slack = await startPreHelloFixture(frame(canary));
    closers.push(() => slack.close());
    const stream = new FailureLogStream();
    const source = createSlackEventSource({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: "A123",
        appToken: canary,
      },
      configurationVersion: 12,
      socket: {
        apiUrl: slack.openUrl,
        helloTimeoutMs: 40,
        readinessTimeoutMs: 100,
      },
      accept: () => Promise.reject(new Error("not reached")),
    });
    closers.push(() => source.source.stop());

    const outcome = await Promise.race([
      runWithFailureTracking(() => source.source.start(ignoreEvent), createLogger(stream)).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 150)),
    ]);

    assert.equal(outcome, "rejected");
    assert.equal(stream.records().length, 1);
    assert.equal(stream.text().includes(canary), false);
    await source.source.stop();
  });
});

function mentionEnvelope(envelopeId: string, eventId: string): unknown {
  return {
    type: "events_api",
    envelope_id: envelopeId,
    accepts_response_payload: false,
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
        text: "<@UBOT> hello",
        ts: "1700000000.001",
        event_ts: "1700000000.001",
      },
    },
  };
}

function acceptedEvent(): DurableProviderEvent {
  return {
    providerEventReceiptId: "receipt-dispatch",
    organizationId: "org",
    projectId: "project",
    configurationRevisionId: "revision",
    deliveryId: "slack-E-dispatch",
    source: "slack.mention",
    payload: { type: "mention" },
    receivedAt: new Date(),
    connectionId: "connection",
    resourceId: "T123",
  };
}

function ignoreEvent(): Promise<void> {
  return Promise.resolve();
}

function eventConfigurationVersion(payload: unknown): number {
  if (payload === null || typeof payload !== "object")
    throw new Error("configuration version payload is unavailable");
  const version: unknown = Reflect.get(payload, "configurationVersion");
  if (typeof version !== "number") throw new Error("configuration version payload is invalid");
  return version;
}

function socketRegistration(
  source: ReturnType<typeof createSlackEventSource>["source"],
  status: ReturnType<typeof createSlackEventSource>["status"],
): ProviderRegistration {
  return {
    connection: {
      name: "slack",
      status: () => ({ status: "connected" }),
      actions: {},
    },
    triggerProviders: [],
    sources: [source],
    outputs: [],
    requests: [],
    slackDelivery: { status, retry: () => Promise.resolve() },
  };
}

function unusedAuth(): AuthServer {
  return {
    handle: () => Promise.reject(new Error("unused")),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () => Promise.reject(new Error("unused")),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function startPreHelloFixture(
  frame: string,
): Promise<{ openUrl: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        url: `ws://127.0.0.1:${port(server)}/socket`,
      }),
    );
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, rawSocket, head) => {
    webSockets.handleUpgrade(request, rawSocket, head, (client) =>
      webSockets.emit("connection", client),
    );
  });
  webSockets.on("connection", (client) => client.send(frame));
  await listen(server);
  return {
    openUrl: `http://127.0.0.1:${port(server)}/api/apps.connections.open`,
    async close() {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await closeServer(server);
    },
  };
}

async function startSlackFixture(
  options: {
    openResponses?: readonly {
      status: number;
      body: unknown;
      headers?: Readonly<Record<string, string>>;
    }[];
  } = {},
): Promise<{
  openUrl: string;
  authorization: string | undefined;
  connected: Promise<void>;
  secondConnected: Promise<void>;
  firstClosed: Promise<void>;
  readonly connectionCount: number;
  readonly openRequestCount: number;
  acks: unknown[];
  send(value: unknown): void;
  terminateLatest(): void;
  waitForAck(): Promise<void>;
  close(): Promise<void>;
}> {
  const connectedSockets: WebSocket[] = [];
  let resolveConnected: (() => void) | undefined;
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });
  let resolveSecondConnected: (() => void) | undefined;
  const secondConnected = new Promise<void>((resolve) => {
    resolveSecondConnected = resolve;
  });
  let resolveFirstClosed: (() => void) | undefined;
  const firstClosed = new Promise<void>((resolve) => {
    resolveFirstClosed = resolve;
  });
  let resolveAck: (() => void) | undefined;
  let ack = new Promise<void>((resolve) => {
    resolveAck = resolve;
  });
  const acks: unknown[] = [];
  let authorization: string | undefined;
  let openRequestCount = 0;
  const server = createServer((request, response) => {
    if (request.url !== "/api/apps.connections.open" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const configuredResponse = options.openResponses?.[openRequestCount];
    openRequestCount += 1;
    if (configuredResponse !== undefined) {
      response.writeHead(configuredResponse.status, {
        "content-type": "application/json",
        ...configuredResponse.headers,
      });
      response.end(JSON.stringify(configuredResponse.body));
      return;
    }
    authorization = request.headers.authorization;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ok: true,
        url: `ws://127.0.0.1:${port(server)}/socket?ticket=secret`,
      }),
    );
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, rawSocket, head) => {
    webSockets.handleUpgrade(request, rawSocket, head, (client) =>
      webSockets.emit("connection", client),
    );
  });
  webSockets.on("connection", (client) => {
    connectedSockets.push(client);
    if (connectedSockets.length === 1) client.once("close", () => resolveFirstClosed?.());
    client.on("message", (data) => {
      acks.push(JSON.parse(rawDataText(data)));
      resolveAck?.();
    });
    client.send(
      JSON.stringify({
        type: "hello",
        connection_info: { app_id: "A123" },
        num_connections: 1,
      }),
    );
    resolveConnected?.();
    if (connectedSockets.length === 2) resolveSecondConnected?.();
  });
  await listen(server);
  return {
    get openUrl() {
      return `http://127.0.0.1:${port(server)}/api/apps.connections.open`;
    },
    get authorization() {
      return authorization;
    },
    connected,
    secondConnected,
    firstClosed,
    get connectionCount() {
      return connectedSockets.length;
    },
    get openRequestCount() {
      return openRequestCount;
    },
    acks,
    send(value) {
      connectedSockets.at(-1)?.send(JSON.stringify(value));
    },
    terminateLatest() {
      connectedSockets.at(-1)?.terminate();
    },
    waitForAck() {
      return ack;
    },
    async close() {
      for (const client of webSockets.clients) client.terminate();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await closeServer(server);
      ack = Promise.resolve();
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function port(server: Server): number {
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return address.port;
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
