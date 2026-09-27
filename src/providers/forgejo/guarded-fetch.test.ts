import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, describe, it } from "vitest";
import { createForgejoApiClient, ForgejoRedirectRefusedError } from "./client.js";
import { createGuardedForgejoFetch } from "./guarded-fetch.js";
import { NO_ALLOWED_PRIVATE_HOSTS, parseAllowedPrivateHosts } from "./instance-guard.js";
import type { RawForgejoLookup } from "./instance-lookup.js";

// exercises the real wiring against a real node:http server, proving the guard's
// decision logic actually reaches the socket undici opens and keeps the host header the
// caller asked for even though the connection was pinned to a different address

let server: Server | undefined;

afterEach(async () => {
  if (server === undefined) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

function startServer(
  handle: (request: { host: string | undefined }, respond: (status: number) => void) => void,
): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((request, response) => {
      handle({ host: request.headers.host }, (status) => {
        if (status >= 300 && status < 400) {
          response.writeHead(status, { location: "https://elsewhere.test" }).end();
          return;
        }
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify({ login: "trillian", id: 1 }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function fakeLookup(address: string, family: number): RawForgejoLookup {
  return () => Promise.resolve({ address, family });
}

describe("Forgejo guarded fetch, against a real server", () => {
  it("refuses a loopback address with no allowlist", async () => {
    const port = await startServer((_req, respond) => respond(200));
    const client = createForgejoApiClient({
      fetch: createGuardedForgejoFetch(NO_ALLOWED_PRIVATE_HOSTS),
    });

    await assert.rejects(
      client.readViewer({ instanceBaseUrl: `http://127.0.0.1:${port}`, accessToken: "t" }),
    );
  });

  it("allows a loopback address once it is in the allowlist", async () => {
    const port = await startServer((_req, respond) => respond(200));
    const client = createForgejoApiClient({
      fetch: createGuardedForgejoFetch(parseAllowedPrivateHosts("127.0.0.1")),
    });

    const viewer = await client.readViewer({
      instanceBaseUrl: `http://127.0.0.1:${port}`,
      accessToken: "t",
    });
    assert.equal(viewer.login, "trillian");
  });

  it("blocks a hostname that resolves to a loopback address, unless that hostname is allowed", async () => {
    const seenHosts: (string | undefined)[] = [];
    const port = await startServer((req, respond) => {
      seenHosts.push(req.host);
      respond(200);
    });
    const lookup = fakeLookup("127.0.0.1", 4);

    const blocked = createForgejoApiClient({
      fetch: createGuardedForgejoFetch(NO_ALLOWED_PRIVATE_HOSTS, lookup),
    });
    await assert.rejects(
      blocked.readViewer({
        instanceBaseUrl: `http://forge.example.test:${port}`,
        accessToken: "t",
      }),
    );
    assert.equal(seenHosts.length, 0, "a blocked lookup must never reach the server");

    const allowed = createForgejoApiClient({
      fetch: createGuardedForgejoFetch(parseAllowedPrivateHosts("forge.example.test"), lookup),
    });
    const viewer = await allowed.readViewer({
      instanceBaseUrl: `http://forge.example.test:${port}`,
      accessToken: "t",
    });
    assert.equal(viewer.login, "trillian");
    assert.equal(seenHosts[0], `forge.example.test:${port}`);
  });

  it("refuses a redirect and never dials the location it points to", async () => {
    let requests = 0;
    const port = await startServer((_req, respond) => {
      requests++;
      respond(302);
    });
    const client = createForgejoApiClient({
      fetch: createGuardedForgejoFetch(parseAllowedPrivateHosts("127.0.0.1")),
    });

    await assert.rejects(
      client.readViewer({ instanceBaseUrl: `http://127.0.0.1:${port}`, accessToken: "t" }),
      (error: unknown) => error instanceof ForgejoRedirectRefusedError && error.status === 302,
    );
    assert.equal(requests, 1);
  });
});
