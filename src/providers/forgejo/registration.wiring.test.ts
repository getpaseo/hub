import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "vitest";
import type { AuthServer } from "../../auth/server.js";
import { ProductRequestError } from "../../auth/organization-access.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { loadForgejoContractFixtures } from "./fake-server.js";
import { createForgejoRegistration } from "./index.js";
import { field, record } from "./contract-test-read.js";
import type { ForgejoHttp } from "./instances.js";

describe("Forgejo registration wiring", () => {
  it("keeps reserved names unavailable until database and auth exist", async () => {
    const registration = createForgejoRegistration({
      database: null,
      auth: null,
      applicationBaseUrl: "https://hub.example.test",
      configuration: { provider: "forgejo" },
    });
    const response = await registration.requests[0]!.handle(
      new Request("https://hub.example.test/instances"),
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "unavailable" });
  });

  it("approves an instance through the registered forgejo.instances handler", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const registration = createForgejoRegistration({
      database: createMemoryDatabase(),
      auth: operatorAuth(),
      applicationBaseUrl: "https://hub.example.test",
      configuration: { provider: "forgejo" },
      http: fixtureHttp(fixtures),
      secrets: {
        current: () => ({ keyId: 1, key: randomBytes(32) }),
        byId: () => undefined,
      },
    });
    const created = await registration.requests
      .find((request) => request.name === "forgejo.instances")!
      .handle(
        jsonRequest("https://hub.example.test/api/integrations/forgejo/instances", {
          origin: "https://forgejo.example.test",
        }),
      );
    assert.equal(created.status, 201);
    const wrapper = record(await created.json(), "instance response");
    const instance = record(field(wrapper, "instance"), "instance");
    assert.equal(field(instance, "status"), "active");
    assert.equal(field(instance, "canonicalOrigin"), "https://forgejo.example.test");

    const webhook = await registration.requests
      .find((request) => request.name === "forgejo.webhook")!
      .handle(new Request("https://hub.example.test/webhook"));
    assert.equal(webhook.status, 409);
  });
});

function operatorAuth(): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () =>
      Promise.reject(new ProductRequestError(403, "organization_required")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: null },
        account: { id: "operator-1", name: "Operator", email: "operator@example.test" },
        isInstanceOperator: true,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fixtureHttp(
  fixtures: Awaited<ReturnType<typeof loadForgejoContractFixtures>>,
): ForgejoHttp {
  const capability = record(fixtures.hydration["apiCapability"], "apiCapability");
  const version = record(field(capability, "version"), "version");
  const settings = record(field(capability, "settings"), "settings");
  return {
    resolver: { resolve: async () => ["203.0.113.10"] },
    fetch: async (input) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/api/v1/version") return Response.json(version);
      if (url.pathname === "/api/v1/settings/api") return Response.json(settings);
      throw new Error(`unexpected Forgejo path ${url.pathname}`);
    },
  };
}
