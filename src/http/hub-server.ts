import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  createFetchRequestListener,
  type FetchHandler,
  type FetchRequestOptions,
} from "./node-server.js";

/** How long shutdown waits for in-flight requests before stopping the runtime under them. */
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

export interface HubServerOptions extends FetchRequestOptions {
  fetch: FetchHandler;
  upgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
  /** Stops the application runtime: daemon sockets, sources, and the database. */
  stopRuntime: () => Promise<void>;
  drainTimeoutMs?: number;
}

export interface HubServer {
  listen(port: number, host: string): Promise<AddressInfo>;
  /**
   * Refuses new work, lets in-flight requests finish, stops the runtime (which closes daemon
   * sockets and the database), then drops the connections that remain. Resolves once the listener
   * is closed.
   */
  close(): Promise<void>;
}

/**
 * The production HTTP server. It owns shutdown order: the runtime is the only thing that closes
 * daemon WebSockets, and the listener cannot finish closing while one is open.
 */
export function createHubServer(options: HubServerOptions): HubServer {
  const {
    fetch,
    upgrade,
    stopRuntime,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    ...requestOptions
  } = options;
  const forward = createFetchRequestListener(fetch, requestOptions);
  const inFlight = new Set<ServerResponse>();
  const upgraded = new Set<Duplex>();
  let closing: Promise<void> | undefined;

  // Once shutdown starts nothing reaches the runtime again: its entry points start a runtime when
  // none is running, which would reopen the database mid-shutdown.
  const server = createServer((request, response) => {
    if (closing !== undefined) {
      refuse(response);
      return;
    }
    inFlight.add(response);
    response.once("close", () => inFlight.delete(response));
    forward(request, response);
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closing !== undefined) {
      socket.destroy();
      return;
    }
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    void upgrade(request, socket, head);
  });

  async function shutdown(): Promise<void> {
    // Stops accepting and closes idle keep-alive connections. The callback waits for every
    // connection, daemon WebSockets included, so it is awaited last.
    const listenerClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    for (const response of inFlight) response.shouldKeepAlive = false;
    await drain(inFlight, drainTimeoutMs);
    try {
      await stopRuntime();
    } finally {
      server.closeAllConnections();
      for (const socket of upgraded) socket.destroy();
      await listenerClosed;
    }
  }

  return {
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("hub server is not listening on a TCP port"));
            return;
          }
          resolve(address);
        });
      });
    },
    close() {
      closing ??= shutdown();
      return closing;
    },
  };
}

function refuse(response: ServerResponse): void {
  response.writeHead(503, {
    connection: "close",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Hub is shutting down");
}

/** Resolves once every response has closed, or when the timeout passes. */
async function drain(responses: Set<ServerResponse>, timeoutMs: number): Promise<void> {
  const closed = Array.from(responses)
    .filter((response) => !response.closed)
    .map((response) => new Promise<void>((resolve) => response.once("close", () => resolve())));
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.all(closed), timedOut]);
  clearTimeout(timer);
}
