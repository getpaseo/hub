import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { field, record } from "./contract-test-read.js";
import { loadForgejoContractFixtures } from "./fake-server.js";
import {
  compareForgejoVersion,
  createMemoryForgejoDirectory,
  dispatchForgejoHttp,
  handleForgejoInstancesRequest,
  resolveApprovedOrigin,
  type ForgejoAccess,
  type ForgejoAccessResolver,
  type ForgejoHttp,
} from "./instances.js";

describe("Forgejo instance approval", () => {
  it("canonicalizes HTTPS origins and rejects http, userinfo, and organization callers", async () => {
    const origin = resolveApprovedOrigin("https://Forgejo.Example.test:8443/", false);
    assert.equal(origin.origin, "https://forgejo.example.test:8443");
    assert.throws(() => resolveApprovedOrigin("http://forgejo.example.test", false), {
      code: "forgejo_origin_invalid",
    });
    assert.throws(() => resolveApprovedOrigin("https://user:pass@forgejo.example.test", false), {
      code: "forgejo_origin_invalid",
    });
    const fixtures = await loadForgejoContractFixtures();
    const http = fixtureHttp(fixtures);
    const denied = await handleForgejoInstancesRequest(
      jsonRequest("https://hub.test/instances", {
        origin: "https://forgejo.example.test",
      }),
      {
        access: access({ isInstanceOperator: false, organizationRole: "owner" }),
        directory: createMemoryForgejoDirectory(),
        http,
      },
    );
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "forbidden" });
  });

  it("approves a compatible 16.0.3 instance and keeps older or incapable ones inactive", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const directory = createMemoryForgejoDirectory();
    const approved = await handleForgejoInstancesRequest(
      jsonRequest("https://hub.test/instances", {
        origin: "https://forgejo.example.test",
      }),
      { access: operatorAccess(), directory, http: fixtureHttp(fixtures) },
    );
    assert.equal(approved.status, 201);
    const created = instanceBody(await approved.json());
    assert.equal(created.status, "active");
    assert.equal(created.canonicalOrigin, "https://forgejo.example.test");
    assert.equal(created.reportedVersion, "16.0.3+gitea-1.22.0");
    assert.equal(compareForgejoVersion(created.reportedVersion), 0);

    const old = await handleForgejoInstancesRequest(
      jsonRequest("https://hub.test/instances", { origin: "https://old.example.test" }),
      {
        access: operatorAccess(),
        directory,
        http: fixtureHttp(fixtures, { version: "16.0.2+gitea-1.22.0", host: "old.example.test" }),
      },
    );
    assert.equal(old.status, 409);
    assert.deepEqual(await old.json(), { error: "forgejo_version_unsupported" });
    const stored = await directory.findInstanceByOrigin("https://old.example.test");
    assert.equal(stored?.status, "incompatible");

    const incapable = await handleForgejoInstancesRequest(
      jsonRequest("https://hub.test/instances", { origin: "https://bare.example.test" }),
      {
        access: operatorAccess(),
        directory,
        http: fixtureHttp(fixtures, {
          host: "bare.example.test",
          settings: { max_response_items: 0, default_paging_num: 30 },
        }),
      },
    );
    assert.equal(incapable.status, 409);
    assert.deepEqual(await incapable.json(), { error: "forgejo_version_unsupported" });
  });

  it("requires operator approval for private addresses and records identity drift", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const directory = createMemoryForgejoDirectory();
    const privateDenied = await handleForgejoInstancesRequest(
      jsonRequest("https://hub.test/instances", { origin: "https://forgejo.internal.test" }),
      {
        access: operatorAccess(),
        directory,
        http: fixtureHttp(fixtures, { host: "forgejo.internal.test", addresses: ["10.0.0.4"] }),
      },
    );
    assert.equal(privateDenied.status, 400);
    assert.deepEqual(await privateDenied.json(), { error: "forgejo_origin_unapproved" });

    const privateAllowed = await handleForgejoInstancesRequest(
      jsonRequest("https://hub.test/instances", {
        origin: "https://forgejo.internal.test",
        allowPrivateNetwork: true,
      }),
      {
        access: operatorAccess(),
        directory,
        http: fixtureHttp(fixtures, { host: "forgejo.internal.test", addresses: ["10.0.0.4"] }),
      },
    );
    assert.equal(privateAllowed.status, 201);

    const first = await handleForgejoInstancesRequest(
      jsonRequest("https://hub.test/instances", { origin: "https://forgejo.example.test" }),
      { access: operatorAccess(), directory, http: fixtureHttp(fixtures, { uid: "instance-a" }) },
    );
    const created = instanceBody(await first.json());
    const drifted = await handleForgejoInstancesRequest(
      new Request(`https://hub.test/instances/${created.id}/verify`, { method: "POST" }),
      { access: operatorAccess(), directory, http: fixtureHttp(fixtures, { uid: "instance-b" }) },
    );
    const verified = instanceBody(await drifted.json());
    assert.equal(verified.status, "identity_drifted");
    assert.equal((await directory.findInstanceById(created.id))?.status, "identity_drifted");
  });

  it("binds outbound Forgejo fetches to the allowlisted resolved addresses", async () => {
    const origin = resolveApprovedOrigin("https://forgejo.example.test", false);
    let bound: readonly string[] | undefined;
    const http: ForgejoHttp = {
      resolver: { resolve: async () => ["203.0.113.10"] },
      fetch: async () => {
        throw new Error("unpinned fetch");
      },
      bindFetch: async (_origin, addresses) => {
        bound = addresses;
        return new Response("{}", { status: 200 });
      },
    };
    const response = await dispatchForgejoHttp(
      http,
      origin,
      "https://forgejo.example.test/api/v1/version",
      { method: "GET" },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(bound, ["203.0.113.10"]);
  });
});

function operatorAccess(): ForgejoAccessResolver {
  return access({ isInstanceOperator: true, organizationRole: null });
}

function access(input: {
  isInstanceOperator: boolean;
  organizationRole: ForgejoAccess["organizationRole"];
}): ForgejoAccessResolver {
  return {
    resolve: async () => ({
      userId: "user-1",
      isInstanceOperator: input.isInstanceOperator,
      organizationId: input.organizationRole === null ? null : "org-1",
      organizationRole: input.organizationRole,
    }),
  };
}

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function instanceBody(value: unknown): {
  id: string;
  canonicalOrigin: string;
  reportedVersion: string;
  status: string;
} {
  const wrapper = record(value, "instance response");
  const instance = record(field(wrapper, "instance"), "instance");
  const id = field(instance, "id");
  const canonicalOrigin = field(instance, "canonicalOrigin");
  const reportedVersion = field(instance, "reportedVersion");
  const status = field(instance, "status");
  if (
    typeof id !== "string" ||
    typeof canonicalOrigin !== "string" ||
    typeof reportedVersion !== "string" ||
    typeof status !== "string"
  ) {
    throw new Error("instance response is invalid");
  }
  return { id, canonicalOrigin, reportedVersion, status };
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  throw new Error("unsupported fetch input");
}

function fixtureHttp(
  fixtures: Awaited<ReturnType<typeof loadForgejoContractFixtures>>,
  options: {
    version?: string;
    host?: string;
    uid?: string;
    settings?: Record<string, unknown>;
    addresses?: readonly string[];
  } = {},
): ForgejoHttp {
  const capability = record(fixtures.hydration["apiCapability"], "apiCapability");
  const version = record(field(capability, "version"), "version");
  const settings = record(field(capability, "settings"), "settings");
  const host = options.host ?? "forgejo.example.test";
  const addresses = options.addresses ?? ["203.0.113.10"];
  return {
    resolver: { resolve: async () => addresses },
    fetch: async (input) => {
      const url = requestUrl(input);
      assert.equal(url.protocol, "https:");
      if (url.pathname === "/api/v1/version") {
        return Response.json({
          ...version,
          version: options.version ?? version["version"],
          ...(options.uid === undefined ? {} : { uid: options.uid }),
        });
      }
      if (url.pathname === "/api/v1/settings/api") {
        return Response.json(options.settings ?? settings);
      }
      throw new Error(`unexpected Forgejo path ${url.pathname} on ${host}`);
    },
  };
}
