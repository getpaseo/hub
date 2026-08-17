import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterEach, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ProviderVerificationError } from "../../provider-applications/index.js";
import { SLACK_REQUIRED_BOT_SCOPES } from "./client.js";
import { createSlackSocketInstallationVerifier } from "./installation.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(close.splice(0).map((operation) => operation())));

it("derives and cross-checks the app and workspace over Slack HTTP and a real socket", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/apps.connections.open") {
      assert.equal(request.headers.authorization, "Bearer xapp-secret");
      response.end(
        JSON.stringify({ ok: true, url: `${base(server).replace("http", "ws")}/socket` }),
      );
      return;
    }
    if (request.url === "/api/auth.test") {
      assert.equal(request.headers.authorization, "Bearer xoxb-secret");
      response.setHeader("x-oauth-scopes", SLACK_REQUIRED_BOT_SCOPES.join(","));
      response.end(
        JSON.stringify({
          ok: true,
          team_id: "T1",
          team: "Acme",
          user_id: "U1",
          bot_id: "B1",
        }),
      );
      return;
    }
    if (request.url === "/api/bots.info?bot=B1") {
      assert.equal(request.headers.authorization, "Bearer xoxb-secret");
      response.end(JSON.stringify({ ok: true, bot: { id: "B1", app_id: "A1", user_id: "U1" } }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ ok: false }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
  });
  sockets.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "hello", connection_info: { app_id: "A1" } }));
  });
  await listen(server);
  close.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const verifier = createSlackSocketInstallationVerifier({ apiBaseUrl: `${base(server)}/api` });
  assert.deepEqual(await verifier.verify("xapp-secret", "xoxb-secret"), {
    appId: "A1",
    teamId: "T1",
    teamName: "Acme",
    botId: "B1",
    botUserId: "U1",
    botAccessToken: "xoxb-secret",
    scopes: [...SLACK_REQUIRED_BOT_SCOPES].sort(),
  });
});

it("does not return from successful verification while a close-stalled socket is alive", async () => {
  const fixture = await verificationFixture({ stallSocketClose: true });
  close.push(() => fixture.close());
  const clientSockets = new Set<WebSocket>();
  const verifier = createSlackSocketInstallationVerifier({
    apiBaseUrl: `${base(fixture.server)}/api`,
    timeoutMs: 100,
    webSocket: (url) => trackClientSocket(url, clientSockets),
  });

  const started = Date.now();
  const installation = await verifier.verify("xapp-secret", "xoxb-secret");

  assert.equal(installation.appId, "A1");
  assert(Date.now() - started < 500);
  assert.equal(clientSockets.size, 0);
  assert.equal(fixture.unfinishedResponses.size, 0);
  for (const socket of fixture.webSockets.clients) socket.resume();
  await eventually(() => assert.equal(fixture.webSockets.clients.size, 0));
  await eventually(() => assert.equal(fixture.unfinishedConnections.size, 0));
});

for (const status of [429, 500] as const) {
  it(`cancels a never-ending ${status} response before reporting verification failure`, async () => {
    const canary = `provider-body-secret-${status}-${crypto.randomUUID()}`;
    const fixture = await verificationFixture({ unfinishedStatus: status, canary });
    close.push(() => fixture.close());
    const clientSockets = new Set<WebSocket>();
    const verifier = createSlackSocketInstallationVerifier({
      apiBaseUrl: `${base(fixture.server)}/api`,
      timeoutMs: 100,
      webSocket: (url) => trackClientSocket(url, clientSockets),
    });

    const started = Date.now();
    const error = await verifier
      .verify("xapp-secret", "xoxb-secret")
      .catch((failure: unknown) => failure);

    assert(error instanceof ProviderVerificationError);
    assert.equal(error.reason, status === 429 ? "rateLimited" : "upstreamUnavailable");
    assert(Date.now() - started < 500);
    assert.equal(JSON.stringify(error).includes(canary), false);
    assert.equal(error.message.includes(canary), false);
    await eventually(() => assert.equal(fixture.unfinishedResponses.size, 0));
    assert.equal(clientSockets.size, 0);
    await eventually(() => assert.equal(fixture.unfinishedConnections.size, 0));
  });
}

for (const path of ["/api/auth.test", "/api/bots.info?bot=B1"] as const) {
  for (const status of [429, 500] as const) {
    it(`disposes an unfinished ${status} body from ${path} without leaving setup resources`, async () => {
      const canary = `provider-body-secret-${status}-${crypto.randomUUID()}`;
      const fixture = await verificationFixture({
        unfinishedStatus: status,
        unfinishedPath: path,
        canary,
      });
      close.push(() => fixture.close());
      const clientSockets = new Set<WebSocket>();
      const verifier = createSlackSocketInstallationVerifier({
        apiBaseUrl: `${base(fixture.server)}/api`,
        timeoutMs: 100,
        webSocket: (url) => trackClientSocket(url, clientSockets),
      });

      const error = await verifier
        .verify("xapp-secret", "xoxb-secret")
        .catch((failure: unknown) => failure);

      assert(error instanceof ProviderVerificationError);
      assert.equal(error.reason, status === 429 ? "rateLimited" : "upstreamUnavailable");
      assert.equal(error.message.includes(canary), false);
      await eventually(() => assert.equal(fixture.unfinishedConnections.size, 0));
      assert.equal(clientSockets.size, 0);
    });
  }
}

it("keeps repeated failed setup attempts resource-flat and accepts a corrected retry", async () => {
  const canary = `provider-body-secret-${crypto.randomUUID()}`;
  const fixture = await verificationFixture({ unfinishedStatus: 429, canary });
  close.push(() => fixture.close());
  const clientSockets = new Set<WebSocket>();
  const verifier = createSlackSocketInstallationVerifier({
    apiBaseUrl: `${base(fixture.server)}/api`,
    timeoutMs: 100,
    webSocket: (url) => trackClientSocket(url, clientSockets),
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await assert.rejects(
      () => verifier.verify("xapp-secret", "xoxb-secret"),
      (error: unknown) =>
        error instanceof ProviderVerificationError &&
        error.reason === "rateLimited" &&
        !error.message.includes(canary),
    );
    await eventually(() => assert.equal(fixture.unfinishedResponses.size, 0));
    assert.equal(clientSockets.size, 0);
  }

  fixture.setUnfinishedStatus(undefined);
  assert.equal((await verifier.verify("xapp-secret", "xoxb-secret")).teamId, "T1");
  assert.equal(fixture.unfinishedResponses.size, 0);
  assert.equal(clientSockets.size, 0);
  assert(fixture.peakConnectionCount() <= 2, `peak connections: ${fixture.peakConnectionCount()}`);
  await eventually(() => assert.equal(fixture.connections.size, 0));
});

async function verificationFixture(options: {
  unfinishedStatus?: 429 | 500;
  unfinishedPath?: "/api/apps.connections.open" | "/api/auth.test" | "/api/bots.info?bot=B1";
  canary?: string;
  stallSocketClose?: boolean;
}): Promise<{
  server: Server;
  webSockets: WebSocketServer;
  unfinishedResponses: Set<ServerResponse>;
  unfinishedConnections: Set<Socket>;
  connections: Set<Socket>;
  peakConnectionCount(): number;
  setUnfinishedStatus(status: 429 | 500 | undefined): void;
  close(): Promise<void>;
}> {
  let unfinishedStatus = options.unfinishedStatus;
  const unfinishedResponses = new Set<ServerResponse>();
  const unfinishedConnections = new Set<Socket>();
  const connections = new Set<Socket>();
  let peakConnections = 0;
  const server = createServer((request, response) => {
    response.setHeader("connection", "close");
    response.setHeader("content-type", "application/json");
    if (
      request.url === (options.unfinishedPath ?? "/api/apps.connections.open") &&
      unfinishedStatus !== undefined
    ) {
      const responseSocket = response.socket;
      if (responseSocket !== null) {
        unfinishedConnections.add(responseSocket);
        responseSocket.once("close", () => unfinishedConnections.delete(responseSocket));
      }
      response.writeHead(unfinishedStatus, unfinishedStatus === 429 ? { "retry-after": "1" } : {});
      unfinishedResponses.add(response);
      response.once("close", () => unfinishedResponses.delete(response));
      response.write(`{"error":"${options.canary ?? "unfinished"}`);
      return;
    }
    if (request.url === "/api/apps.connections.open") {
      response.end(
        JSON.stringify({ ok: true, url: `${base(server).replace("http", "ws")}/socket` }),
      );
      return;
    }
    if (request.url === "/api/auth.test") {
      response.setHeader("x-oauth-scopes", SLACK_REQUIRED_BOT_SCOPES.join(","));
      response.end(
        JSON.stringify({
          ok: true,
          team_id: "T1",
          team: "Acme",
          user_id: "U1",
          bot_id: "B1",
        }),
      );
      return;
    }
    if (request.url === "/api/bots.info?bot=B1") {
      response.end(JSON.stringify({ ok: true, bot: { id: "B1", app_id: "A1", user_id: "U1" } }));
      return;
    }
    response.writeHead(404).end();
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    peakConnections = Math.max(peakConnections, connections.size);
    socket.once("close", () => connections.delete(socket));
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (client) =>
      webSockets.emit("connection", client),
    );
  });
  webSockets.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "hello", connection_info: { app_id: "A1" } }), () => {
      if (options.stallSocketClose === true) socket.pause();
    });
  });
  await listen(server);
  return {
    server,
    webSockets,
    unfinishedResponses,
    unfinishedConnections,
    connections,
    peakConnectionCount: () => peakConnections,
    setUnfinishedStatus(status) {
      unfinishedStatus = status;
    },
    async close() {
      for (const socket of webSockets.clients) socket.terminate();
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => webSockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function eventually(assertion: () => void, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function trackClientSocket(url: string, sockets: Set<WebSocket>): WebSocket {
  const socket = new WebSocket(url);
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  return socket;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function base(server: Server): string {
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
