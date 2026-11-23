import assert from "node:assert/strict";
import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, describe, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createHubServer, type HubServer } from "./hub-server.js";

/**
 * Stands in for the application runtime at the server boundary: accepts daemon WebSockets on
 * upgrade, and on stop closes them with 1001 the way `ActiveDaemonRegistry.stop()` does.
 */
class FakeRuntime {
  readonly sockets = new WebSocketServer({ noServer: true });
  stopStarted = false;
  stopped = false;
  /** When set, stop waits for it before closing daemon sockets. */
  stopGate: Promise<void> | undefined;

  upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    this.sockets.handleUpgrade(request, socket, head, () => undefined);
  };

  stop = async (): Promise<void> => {
    this.stopStarted = true;
    await this.stopGate;
    await Promise.all(
      Array.from(
        this.sockets.clients,
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            socket.close(1001, "server shutdown");
          }),
      ),
    );
    this.stopped = true;
  };
}

const agents: Agent[] = [];
const servers: HubServer[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

async function startHubServer(
  runtime: FakeRuntime,
  fetch: (request: Request) => Promise<Response> = async () => new Response("ok"),
  options: { drainTimeoutMs?: number } = {},
) {
  const server = createHubServer({
    fetch,
    upgrade: runtime.upgrade,
    stopRuntime: runtime.stop,
    ...options,
  });
  servers.push(server);
  const address = await server.listen(0, "127.0.0.1");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function keepAliveAgent(): Agent {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  agents.push(agent);
  return agent;
}

function get(
  agent: Agent,
  url: string,
): Promise<{ status: number; body: string; connection: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { agent }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          body,
          connection: response.headers.connection,
        }),
      );
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

async function connectDaemon(origin: string): Promise<{ closeCode: Promise<number> }> {
  const socket = new WebSocket(`${origin.replace("http", "ws")}/api/daemons/socket`);
  const closeCode = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return { closeCode };
}

/** Starts a GET and resolves once the response headers arrive, while its body is still open. */
function openStream(agent: Agent, url: string): Promise<{ body: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { agent }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      resolve({
        body: new Promise((settle, fail) => {
          response.on("end", () => settle(body));
          response.on("error", fail);
        }),
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
    }),
  ]);
}

describe("hub server shutdown", () => {
  it("stops the runtime and closes while a daemon WebSocket and a keep-alive connection are open", async () => {
    const runtime = new FakeRuntime();
    const { server, origin } = await startHubServer(runtime);
    const daemon = await connectDaemon(origin);
    const browser = keepAliveAgent();
    assert.equal((await get(browser, `${origin}/`)).status, 200);

    await withinMs(server.close(), 2_000, "server.close()");

    assert.equal(runtime.stopped, true);
    assert.equal(await daemon.closeCode, 1001);
  });

  it("answers a request on a reused connection during shutdown without reaching the runtime", async () => {
    const runtime = new FakeRuntime();
    const paths: string[] = [];
    let finishStream!: () => void;
    const { server, origin } = await startHubServer(runtime, async (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path !== "/stream") return new Response("ok");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed"));
          finishStream = () => controller.close();
        },
      });
      return new Response(body);
    });
    const browser = keepAliveAgent();
    const streamed = await openStream(browser, `${origin}/stream`);
    const stopGate = deferred();
    runtime.stopGate = stopGate.promise;

    const closed = server.close();
    finishStream();
    assert.equal(await streamed.body, "streamed");
    await waitFor(() => runtime.stopStarted, "runtime stop to start");
    const late = await get(browser, `${origin}/late`);
    stopGate.resolve();
    await withinMs(closed, 2_000, "server.close()");

    assert.deepEqual(late, { status: 503, body: "Hub is shutting down", connection: "close" });
    assert.deepEqual(paths, ["/stream"]);
  });

  it("stops the runtime once the drain timeout passes for a request that never finishes", async () => {
    const runtime = new FakeRuntime();
    const requestStarted = deferred();
    const { server, origin } = await startHubServer(
      runtime,
      async () => {
        requestStarted.resolve();
        return new Promise<Response>(() => undefined);
      },
      { drainTimeoutMs: 50 },
    );
    get(keepAliveAgent(), `${origin}/stuck`).catch(() => undefined);
    await requestStarted.promise;

    await withinMs(server.close(), 2_000, "server.close()");

    assert.equal(runtime.stopped, true);
  });

  it("lets an in-flight request finish before stopping the runtime", async () => {
    const runtime = new FakeRuntime();
    const requestStarted = deferred();
    const finishRequest = deferred();
    const { server, origin } = await startHubServer(runtime, async () => {
      requestStarted.resolve();
      await finishRequest.promise;
      return new Response("finished");
    });
    const response = get(keepAliveAgent(), `${origin}/slow`);
    await requestStarted.promise;

    const closed = server.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(runtime.stopStarted, false);
    finishRequest.resolve();
    await withinMs(closed, 2_000, "server.close()");

    assert.deepEqual(await response, { status: 200, body: "finished", connection: "close" });
    assert.equal(runtime.stopped, true);
  });
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => (resolve = settle));
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
