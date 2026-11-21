import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { it } from "vitest";
import { createDiscordBotClient } from "./bot.js";

it("closes a silent socket and suppresses the SDK's reconnect", async () => {
  await withGateway(async (fixture) => {
    const bot = fixture.createBot(750);
    const start = bot.start();
    await once(fixture.gateway, "connection");
    const peer = [...fixture.gateway.clients][0];
    assert.ok(peer);
    const closed = once(peer, "close");
    await assert.rejects(start, { name: "DiscordStartupTimeoutError" });
    await closed;
    await delay(650); // The SDK schedules another connection after 500 ms.
    assert.equal(fixture.upgrades, 1);
  });
});

it("cancels an upgrade before the server completes the handshake", async () => {
  await withGateway(
    async (fixture) => {
      const bot = fixture.createBot(750);
      const start = bot.start();
      const socket = await fixture.upgrade;
      const ended = once(socket, "end");
      await assert.rejects(start, { name: "DiscordStartupTimeoutError" });
      await ended;
    },
    { stallUpgrade: true },
  );
});

it("prevents a connection when discovery completes after cancellation", async () => {
  await withGateway(
    async (fixture) => {
      const bot = fixture.createBot(250);
      const start = bot.start();
      const reply = await fixture.discovery;
      await assert.rejects(start, { name: "DiscordStartupTimeoutError" });
      fixture.sendDiscovery(reply);
      await delay(650);
      assert.equal(fixture.upgrades, 0);
    },
    { stallDiscovery: true },
  );
});

it("starts and stops after a real READY exchange", async () => {
  await withGateway(async (fixture) => {
    const bot = fixture.createBot(2_000);
    fixture.gateway.on("connection", (socket) => answerIdentify(socket, fixture.gatewayUrl));
    await bot.start();
    assert.equal(bot.getSelfUserId(), "100");
    await bot.stop();
  });
});

it("preserves classification for an unrecoverable gateway close", async () => {
  await withGateway(async (fixture) => {
    fixture.gateway.on("connection", (socket) => socket.close(4014));
    await assert.rejects(fixture.createBot(2_000).start(), {
      name: "DiscordGatewayError",
      code: "permissionMissing",
      gatewayCloseCode: 4014,
    });
  });
});

async function withGateway(
  run: (fixture: Awaited<ReturnType<typeof startGateway>>) => Promise<void>,
  options?: Parameters<typeof startGateway>[0],
) {
  const fixture = await startGateway(options);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

async function startGateway(options: { stallDiscovery?: boolean; stallUpgrade?: boolean } = {}) {
  let didDiscover!: (reply: ServerResponse) => void;
  const discovery = new Promise<ServerResponse>((resolve) => {
    didDiscover = resolve;
  });
  let didUpgrade!: (socket: Duplex) => void;
  const upgrade = new Promise<Duplex>((resolve) => {
    didUpgrade = resolve;
  });
  const gateway = new WebSocketServer({ noServer: true });
  const sockets = new Set<Duplex>();
  let upgrades = 0;
  const server = createServer((_request, reply) => {
    didDiscover(reply);
    if (!options.stallDiscovery) sendDiscovery(reply);
  });
  server.on("upgrade", (request, socket, head) => {
    upgrades += 1;
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
    didUpgrade(socket);
    socket.resume();
    if (!options.stallUpgrade) {
      gateway.handleUpgrade(request, socket, head, (peer) => gateway.emit("connection", peer));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const api = `http://127.0.0.1:${address.port}`;
  const gatewayUrl = `ws://127.0.0.1:${address.port}`;

  function sendDiscovery(reply: ServerResponse) {
    reply.writeHead(200, { "content-type": "application/json" });
    reply.end(
      JSON.stringify({
        url: gatewayUrl,
        shards: 1,
        session_start_limit: {
          total: 100,
          remaining: 100,
          reset_after: 60_000,
          max_concurrency: 1,
        },
      }),
    );
  }

  return {
    gateway,
    gatewayUrl,
    discovery,
    upgrade,
    sendDiscovery,
    get upgrades() {
      return upgrades;
    },
    createBot: (startupTimeoutMs: number) =>
      createDiscordBotClient({ token: "test-token", startupTimeoutMs, restOptions: { api } }),
    async close() {
      for (const socket of sockets) socket.destroy();
      gateway.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
        server.closeAllConnections();
      });
    },
  };
}

function answerIdentify(socket: WebSocket, gatewayUrl: string) {
  socket.on("message", (data) => {
    assert.ok(Buffer.isBuffer(data));
    const packet: unknown = JSON.parse(data.toString("utf8"));
    if (typeof packet !== "object" || packet === null || Reflect.get(packet, "op") !== 2) {
      return;
    }
    socket.send(
      JSON.stringify({
        op: 0,
        t: "READY",
        s: 1,
        d: {
          v: 10,
          user: { id: "100", username: "Bot", bot: true, discriminator: "0", avatar: null },
          guilds: [],
          session_id: "session",
          resume_gateway_url: gatewayUrl,
          application: { id: "100", flags: 0 },
        },
      }),
    );
  });
  socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }));
}
