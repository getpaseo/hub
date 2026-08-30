import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "vitest";
import { field, record } from "./contract-test-read.js";
import { loadForgejoContractFixtures } from "./fake-server.js";
import {
  forgejoConfigurationResourceItems,
  handleForgejoConnectionsRequest,
  maskForgejoPat,
  validateConnectionCredential,
} from "./connections.js";
import {
  createMemoryForgejoDirectory,
  handleForgejoInstancesRequest,
  type ForgejoAccess,
  type ForgejoAccessResolver,
  type ForgejoHttp,
} from "./instances.js";
import {
  decryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";

describe("Forgejo organization connections", () => {
  it("rejects OAuth2, passwords, unscoped tokens, and forbidden scopes", () => {
    const pat = "forgejo_pat_repository_limited";
    assert.throws(
      () =>
        validateConnectionCredential({
          pat,
          scopes: ["write:issue"],
          limitedRepositoryIds: [],
          oauth2: true,
        }),
      {
        code: "forgejo_scope_invalid",
      },
    );
    assert.throws(
      () =>
        validateConnectionCredential({
          pat,
          scopes: ["write:issue", "write:repository"],
          limitedRepositoryIds: [],
          password: "hunter2",
        }),
      { code: "forgejo_scope_invalid" },
    );
    assert.throws(
      () =>
        validateConnectionCredential({
          pat,
          scopes: ["write:issue", "write:repository"],
          limitedRepositoryIds: "unscoped",
        }),
      { code: "forgejo_scope_invalid" },
    );
    assert.throws(
      () =>
        validateConnectionCredential({
          pat,
          scopes: ["write:issue", "write:repository", "read:user"],
          limitedRepositoryIds: [1],
        }),
      { code: "forgejo_scope_invalid" },
    );
    assert.throws(
      () =>
        validateConnectionCredential({
          pat,
          scopes: ["write:issue", "write:repository", "read:organization"],
          limitedRepositoryIds: [1],
        }),
      { code: "forgejo_scope_invalid" },
    );
    const stored = validateConnectionCredential({
      pat,
      scopes: ["read:issue", "write:issue", "read:repository", "write:repository"],
      limitedRepositoryIds: [1],
    });
    assert.deepEqual(stored.scopes, ["write:issue", "write:repository"]);
    assert.equal(maskForgejoPat(), "••••");
  });

  it("lets owners connect only by approved instance id, bind identity without GET /user, and mask PATs", async () => {
    const fixtures = await loadForgejoContractFixtures();
    const directory = createMemoryForgejoDirectory();
    const secrets = testSecrets();
    const seen: string[] = [];
    const http = fixtureHttp(fixtures, seen);
    const approved = await handleForgejoInstancesRequest(
      jsonRequest("https://hub.test/instances", { origin: "https://forgejo.example.test" }),
      { access: operatorAccess(), directory, http },
    );
    const instance = record(
      field(record(await approved.json(), "approved"), "instance"),
      "instance",
    );
    const operatorDenied = await handleForgejoConnectionsRequest(
      jsonRequest("https://hub.test/connections", connectionBody(String(instance["id"]))),
      { access: operatorOnlyAccess(), directory, http, secrets },
    );
    assert.equal(operatorDenied.status, 403);

    const created = await handleForgejoConnectionsRequest(
      jsonRequest("https://hub.test/connections", connectionBody(String(instance["id"]))),
      { access: ownerAccess(), directory, http, secrets },
    );
    assert.equal(created.status, 201);
    const payload = record(await created.json(), "created");
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes("forgejo_pat_repository_limited"), false);
    assert.equal(serialized.includes("••••"), true);
    const connection = record(field(payload, "connection"), "connection");
    assert.equal(connection["status"], "active");
    assert.equal(connection["forgejoUserLogin"], "t00user");
    assert.equal(connection["instanceId"], instance["id"]);
    assert.equal(
      seen.some((path) => path === "/api/v1/user" || path.startsWith("/api/v1/user?")),
      false,
    );
    assert.equal(
      seen.some((path) => path.includes("/collaborators/t00user/permission")),
      true,
    );

    const credential = await directory.findActiveConnectionCredential(String(connection["id"]));
    assert.notEqual(credential, undefined);
    if (credential === undefined) throw new Error("connection credential missing");
    assert.equal(credential.kind, "connection");
    const plaintext = decryptSecret(
      secrets,
      {
        alg: "aes-256-gcm",
        keyId: credential.keyId,
        nonce: credential.nonce,
        ciphertext: credential.ciphertext,
        aadVersion: 1,
      },
      {
        organizationId: "org-1",
        credentialId: credential.id,
        kind: "connection",
      },
    );
    assert.equal(plaintext, "forgejo_pat_repository_limited");

    const secondInstance = await handleForgejoInstancesRequest(
      jsonRequest("https://hub.test/instances", { origin: "https://other.example.test" }),
      {
        access: operatorAccess(),
        directory,
        http: fixtureHttp(fixtures, seen, { host: "other.example.test" }),
      },
    );
    const other = record(
      field(record(await secondInstance.json(), "other"), "instance"),
      "instance",
    );
    const isolated = await handleForgejoConnectionsRequest(
      jsonRequest(
        "https://hub.test/connections",
        connectionBody(String(other["id"]), { slug: "other-bot" }),
      ),
      {
        access: ownerAccess(),
        directory,
        http: fixtureHttp(fixtures, seen, { host: "other.example.test" }),
        secrets,
      },
    );
    assert.equal(isolated.status, 201);
    const listed = await handleForgejoConnectionsRequest(
      new Request("https://hub.test/connections"),
      {
        access: ownerAccess(),
        directory,
        http,
        secrets,
      },
    );
    const listing = record(await listed.json(), "listing");
    const connections = field(listing, "connections");
    assert.equal(Array.isArray(connections) && connections.length, 2);

    const mismatch = await handleForgejoConnectionsRequest(
      jsonRequest(
        "https://hub.test/connections",
        connectionBody(String(instance["id"]), { claimedUsername: "other-user", slug: "drifted" }),
      ),
      {
        access: ownerAccess(),
        directory,
        http: fixtureHttp(fixtures, seen, { claimed: "t00user" }),
        secrets,
      },
    );
    assert.equal(mismatch.status, 403);
    assert.deepEqual(await mismatch.json(), { error: "forgejo_identity_mismatch" });
    assert.equal(
      (await directory.listConnectionsForOrganization("org-1")).some(
        (row) => row.slug === "drifted",
      ),
      false,
    );

    const resources = forgejoConfigurationResourceItems({
      connections: await directory.listConnectionsForOrganization("org-1"),
      originByInstanceId: new Map([
        [String(instance["id"]), "https://forgejo.example.test"],
        [String(other["id"]), "https://other.example.test"],
      ]),
      enrolledFullNamesByConnectionId: new Map(),
    });
    assert.equal(resources[0]?.instanceOrigin, "https://forgejo.example.test");
  });
});

function connectionBody(
  instanceId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    instanceId,
    slug: "forgejo-bot",
    claimedUsername: "t00user",
    pat: "forgejo_pat_repository_limited",
    scopes: ["write:issue", "write:repository"],
    repositories: [1],
    ...extra,
  };
}

function operatorAccess(): ForgejoAccessResolver {
  return access({ isInstanceOperator: true, organizationRole: null, organizationId: null });
}

function operatorOnlyAccess(): ForgejoAccessResolver {
  return access({ isInstanceOperator: true, organizationRole: null, organizationId: null });
}

function ownerAccess(): ForgejoAccessResolver {
  return access({ isInstanceOperator: false, organizationRole: "owner", organizationId: "org-1" });
}

function access(input: {
  isInstanceOperator: boolean;
  organizationRole: ForgejoAccess["organizationRole"];
  organizationId: string | null;
}): ForgejoAccessResolver {
  return {
    resolve: async () => ({
      userId: "user-1",
      isInstanceOperator: input.isInstanceOperator,
      organizationId: input.organizationId,
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

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  throw new Error("unsupported fetch input");
}

function testSecrets(): SecretEncryptionKeySource {
  const key = randomBytes(32);
  const current = { keyId: 1, key };
  return {
    current: () => current,
    byId: (id) => (id === 1 ? current : undefined),
  };
}

function fixtureHttp(
  fixtures: Awaited<ReturnType<typeof loadForgejoContractFixtures>>,
  seen: string[],
  options: { host?: string; claimed?: string } = {},
): ForgejoHttp {
  const capability = record(fixtures.hydration["apiCapability"], "apiCapability");
  const version = record(field(capability, "version"), "version");
  const settings = record(field(capability, "settings"), "settings");
  const repository = record(
    field(record(fixtures.hydration["repository"], "repository"), "body"),
    "body",
  );
  const host = options.host ?? "forgejo.example.test";
  const claimed = options.claimed ?? "t00user";
  return {
    resolver: { resolve: async () => ["203.0.113.10"] },
    fetch: async (input) => {
      const url = requestUrl(input);
      seen.push(url.pathname + url.search);
      assert.equal(url.hostname, host);
      if (url.pathname === "/api/v1/user") {
        throw new Error("GET /api/v1/user is forbidden for repository-limited PATs");
      }
      if (url.pathname === "/api/v1/version") return Response.json(version);
      if (url.pathname === "/api/v1/settings/api") return Response.json(settings);
      if (url.pathname === "/api/v1/repos/search") {
        return new Response(JSON.stringify({ ok: true, data: [repository] }), {
          headers: { "content-type": "application/json", "x-total-count": "1" },
        });
      }
      if (url.pathname.includes("/collaborators/")) {
        const username = url.pathname.split("/").at(-2);
        if (username !== claimed) {
          return Response.json(
            { message: "collaborators can query only their own" },
            { status: 403 },
          );
        }
        return Response.json({
          permission: "admin",
          role_name: "owner",
          user: { id: 7, login: claimed },
        });
      }
      throw new Error(`unexpected Forgejo path ${url.pathname}`);
    },
  };
}
