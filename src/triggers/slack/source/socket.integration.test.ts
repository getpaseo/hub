import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, describe, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { runWithFailureTracking } from "../../../failures/index.js";
import { createLogger } from "../../../logger.js";
import { assertOneFailure, FailureLogStream } from "../../../test-utils/failure-logs.js";
import { createSlackEventSource } from "./index.js";

describe("Slack Socket Mode source", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
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

    const started = source.source.start(() => Promise.resolve());
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
      response.end(JSON.stringify({ ok: false, error: "invalid_auth", detail: bodyCanary }));
    });
    await listen(server);
    closers.push(() => closeServer(server));
    const stream = new FailureLogStream();
    const source = createSlackEventSource({
      configuration: { provider: "slack", transport: "socket", appId: "A123", appToken: token },
      configurationVersion: 8,
      socket: { apiUrl: `http://127.0.0.1:${port(server)}/api/apps.connections.open` },
      accept: () => Promise.reject(new Error("not reached")),
    });

    const ignoreEvent = () => Promise.resolve();
    const starting = runWithFailureTracking(
      () => source.source.start(ignoreEvent),
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
      accept: () => Promise.resolve({ status: "accepted", events: [], receiptId: "unused" }),
    });
    await source.source.start(() => Promise.resolve());

    slack.send({ type: "disconnect", reason: "refresh_requested" });
    await slack.secondConnected;
    await slack.firstClosed;

    assert.equal(slack.connectionCount, 2);
    assert.equal(source.status().state, "connected");
    await source.source.stop();
  });
});

async function startSlackFixture(): Promise<{
  openUrl: string;
  authorization: string | undefined;
  connected: Promise<void>;
  secondConnected: Promise<void>;
  firstClosed: Promise<void>;
  readonly connectionCount: number;
  acks: unknown[];
  send(value: unknown): void;
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
  const server = createServer((request, response) => {
    if (request.url !== "/api/apps.connections.open" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    authorization = request.headers.authorization;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port(server)}/socket?ticket=secret` }),
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
      JSON.stringify({ type: "hello", connection_info: { app_id: "A123" }, num_connections: 1 }),
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
    acks,
    send(value) {
      connectedSockets.at(-1)?.send(JSON.stringify(value));
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
