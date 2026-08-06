import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { isIP } from "node:net";
import { logger } from "../logger.js";
import { INTERNAL_CLIENT_ADDRESS_HEADER } from "./client-address.js";
import { takeResponseLifecycle } from "./response-lifecycle.js";

export type FetchHandler = (request: Request) => Response | Promise<Response>;

interface StreamingRequestInit extends RequestInit {
  duplex: "half";
}

interface FetchServerOptions {
  trustedClientIpHeader?: string;
}

export function createFetchServer(
  fetchHandler: FetchHandler,
  options: FetchServerOptions = {},
): Server {
  return createServer((request, response) => {
    void forwardRequest(fetchHandler, request, response, options);
  });
}

async function forwardRequest(
  fetchHandler: FetchHandler,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: FetchServerOptions,
): Promise<void> {
  try {
    const clientAddress = resolveClientAddress(incoming, options.trustedClientIpHeader);
    const request = toRequest(incoming, clientAddress);
    const response = await fetchHandler(request);
    const lifecycle = takeResponseLifecycle(response);
    let responseForwarded = false;
    let lifecycleSettled = false;
    const runLifecycle = (callback: (() => void | Promise<void>) | undefined): void => {
      if (callback === undefined || lifecycleSettled) return;
      lifecycleSettled = true;
      void Promise.resolve(callback()).catch((error: unknown) => {
        logger.error({ err: error }, "response lifecycle cleanup failed");
      });
    };
    const abortLifecycle = (): void => {
      if (lifecycle === undefined) return;
      runLifecycle(lifecycle.onAbort);
    };
    if (lifecycle !== undefined) {
      outgoing.once("finish", () => {
        if (!responseForwarded) {
          abortLifecycle();
          return;
        }
        runLifecycle(lifecycle.onFinish);
      });
      const markResponseAborted = () => {
        if (outgoing.writableFinished) return;
        responseForwarded = false;
        abortLifecycle();
      };
      outgoing.once("close", markResponseAborted);
      outgoing.once("error", markResponseAborted);
    }
    outgoing.statusCode = response.status;
    outgoing.statusMessage = response.statusText;
    for (const [name, value] of response.headers) outgoing.setHeader(name, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);
    if (response.body === null) {
      responseForwarded = true;
      outgoing.end();
      return;
    }
    const reader = response.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!outgoing.write(chunk.value)) await once(outgoing, "drain");
    }
    responseForwarded = true;
    outgoing.end();
  } catch (error) {
    logger.error({ err: error }, "request failed");
    outgoing.statusCode = 500;
    outgoing.end("Internal Server Error");
  }
}

function toRequest(incoming: IncomingMessage, clientAddress: string): Request {
  const method = incoming.method ?? "GET";
  const origin = `http://${incoming.headers.host ?? "localhost"}`;
  const headers = requestHeaders(incoming);
  headers.set(INTERNAL_CLIENT_ADDRESS_HEADER, clientAddress);
  const base = { method, headers } satisfies RequestInit;
  if (method === "GET" || method === "HEAD") {
    return new Request(new URL(incoming.url ?? "/", origin), base);
  }
  const streaming = {
    ...base,
    body: requestBody(incoming),
    duplex: "half",
  } satisfies StreamingRequestInit;
  return new Request(new URL(incoming.url ?? "/", origin), streaming);
}

function resolveClientAddress(
  incoming: IncomingMessage,
  trustedClientIpHeader: string | undefined,
): string {
  const peerAddress = incoming.socket.remoteAddress ?? "unknown";
  if (trustedClientIpHeader === undefined) return peerAddress;
  const value = incoming.headers[trustedClientIpHeader.toLowerCase()];
  if (typeof value !== "string") return peerAddress;
  const address = value.trim();
  return isIP(address) === 0 ? peerAddress : address;
}

function requestBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<unknown> | undefined;
  const source = {
    type: "bytes",
    async pull(controller) {
      iterator ??= incoming[Symbol.asyncIterator]();
      try {
        const chunk = await iterator.next();
        if (chunk.done) {
          controller.close();
          return;
        }
        controller.enqueue(readChunk(chunk.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator?.return?.();
      incoming.destroy();
    },
  } satisfies UnderlyingByteSource;
  return new ReadableStream(source);
}

function readChunk(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  throw new TypeError("request body contained an unsupported chunk");
}

function requestHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}
