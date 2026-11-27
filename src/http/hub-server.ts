import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
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
  /** Stops background claimers, trigger sources, and daemon sockets before HTTP drain. */
  drainRuntime?: () => Promise<void>;
  /** Stops the application runtime: closes the database and remaining resources. */
  stopRuntime: () => Promise<void>;
  drainTimeoutMs?: number;
}

export interface HubServer {
  listen(port: number, host: string): Promise<AddressInfo>;
  /**
   * Immediately marks `/health` as draining (`503`) and refuses new work, stops background
   * claimers/sources and closes daemon WebSockets (`1001`), drains in-flight HTTP requests,
   * then stops the runtime (closing the database) and drops any remaining connections.
   */
  close(): Promise<void>;
}

/**
 * The production HTTP server. It owns shutdown order: flipping `/health` to `503` immediately,
 * stopping background workers and daemon WebSockets first so daemons reconnect to a healthy peer,
 * draining in-flight HTTP requests while the database is still open, and closing the database last.
 */
export function createHubServer(options: HubServerOptions): HubServer {
  const {
    fetch,
    upgrade,
    drainRuntime,
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
      if (isHealthPath(request.url)) refuseHealth(response);
      else refuse(response);
      return;
    }
    inFlight.add(response);
    response.once("close", () => inFlight.delete(response));
    forward(request, response);
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (closing !== undefined) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    void upgrade(request, socket, head);
  });

  async function shutdown(): Promise<void> {
    const errors: unknown[] = [];
    closeAfterLastResponse(inFlight);
    try {
      await drainRuntime?.();
    } catch (error) {
      errors.push(error);
    }
    // Stops accepting new connections and closes idle keep-alive sockets. The callback waits for
    // every remaining connection, so it is awaited last.
    const listenerClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    server.closeIdleConnections();
    closeAfterLastResponse(inFlight);
    await drain(inFlight, drainTimeoutMs);
    try {
      await stopRuntime();
    } catch (error) {
      errors.push(error);
    } finally {
      server.closeAllConnections();
      for (const socket of upgraded) socket.destroy();
      await listenerClosed;
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "hub server shutdown failed");
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

/**
 * Ends each connection after the last response it already accepted, so the client's next request
 * opens a new connection instead of reaching a stopping Hub. Earlier pipelined responses keep the
 * connection open; closing after them would drop the ones queued behind.
 */
function closeAfterLastResponse(responses: Set<ServerResponse>): void {
  const lastBySocket = new Map<Socket, ServerResponse>();
  for (const response of responses) lastBySocket.set(response.req.socket, response);
  for (const response of lastBySocket.values()) response.shouldKeepAlive = false;
}

function isHealthPath(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    return new URL(url, "http://hub.invalid").pathname === "/health";
  } catch {
    return false;
  }
}

function refuseHealth(response: ServerResponse): void {
  response.writeHead(503, {
    connection: "close",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ ok: false, status: "draining" }));
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
