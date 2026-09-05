import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { HubFaultProxy } from "./fault-proxy.js";

describe("HubFaultProxy", () => {
  let proxy: HubFaultProxy | undefined;
  let targetServer: Server | undefined;
  let targetSockets: WebSocketServer | undefined;
  let daemonSocket: WebSocket | undefined;

  afterEach(async () => {
    daemonSocket?.terminate();
    await proxy?.stop();
    for (const socket of targetSockets?.clients ?? []) socket.terminate();
    if (targetSockets) await new Promise<void>((resolve) => targetSockets!.close(() => resolve()));
    targetServer?.closeIdleConnections();
    targetServer?.closeAllConnections();
    if (targetServer) await new Promise<void>((resolve) => targetServer!.close(() => resolve()));
  });

  it("preserves daemon session protocol negotiation across its terminated upgrade", async () => {
    targetServer = createServer();
    targetSockets = new WebSocketServer({ server: targetServer });
    await new Promise<void>((resolve, reject) => {
      targetServer!.once("error", reject);
      targetServer!.listen(0, "127.0.0.1", resolve);
    });
    const targetAddress = targetServer.address();
    assert.ok(targetAddress && typeof targetAddress !== "string");

    proxy = await HubFaultProxy.start(
      `http://127.0.0.1:${targetAddress.port}`,
      await availablePort(),
    );
    daemonSocket = new WebSocket(`${proxy.origin.replace("http:", "ws:")}/api/daemons/socket`, {
      headers: { "x-paseo-session-protocol": "1" },
    });
    const upgrade = new Promise<IncomingMessage>((resolve) =>
      daemonSocket!.once("upgrade", resolve),
    );

    await once(daemonSocket, "open");

    assert.equal((await upgrade).headers["x-paseo-session-protocol"], "1");
    daemonSocket.close();
    await once(daemonSocket, "close");
    daemonSocket = undefined;
  });
});

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
