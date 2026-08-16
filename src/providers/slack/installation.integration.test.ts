import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, it } from "vitest";
import { WebSocketServer } from "ws";
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

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function base(server: Server): string {
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
