import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "vitest";
import {
  decryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import { FORGEJO_HOOK_EVENTS, handleForgejoWebhookRequest } from "./hooks.js";
import {
  createMemoryForgejoDirectory,
  handleForgejoInstancesRequest,
  type ForgejoAccess,
  type ForgejoAccessResolver,
  type ForgejoDirectory,
  type ForgejoHttp,
} from "./instances.js";
import { handleForgejoConnectionsRequest } from "./connections.js";
import { field, list, record } from "./contract-test-read.js";
import { loadForgejoContractFixtures } from "./fake-server.js";

const ADMIN_PAT = "forgejo_webhook_admin_unscoped";
const CONNECTION_PAT = "forgejo_pat_repository_limited";

describe("Forgejo hook setup", () => {
  it("creates managed hooks with the required events and discards the one-time admin PAT", async () => {
    const { directory, http, secrets, connectionId, seen, tokens } = await connectedWorld();
    const created = await handleForgejoWebhookRequest(
      jsonRequest(`https://hub.test/connections/${connectionId}/hooks`, {
        mode: "automatic",
        adminPat: ADMIN_PAT,
      }),
      webhookOptions({ directory, http, secrets }),
    );
    assert.equal(created.status, 200);
    const body = record(await created.json(), "automatic");
    assert.equal(JSON.stringify(body).includes(ADMIN_PAT), false);
    assert.deepEqual(field(body, "events"), [...FORGEJO_HOOK_EVENTS]);
    assert.equal(
      String(field(body, "callbackUrl")),
      `https://hub.example.test/api/integrations/forgejo/webhook/${connectionId}`,
    );
    const hooks = list(field(body, "hooks"), "hooks");
    assert.equal(record(hooks[0], "hook")["status"], "active");
    assert.equal(
      seen.some((path) => path.endsWith("/hooks") && path.includes("/repos/")),
      true,
    );
    assert.equal(
      seen.some((path) => path.endsWith("/tests")),
      true,
    );
    assert.equal(tokens.length > 0, true);
    assert.equal(
      tokens.every((token) => token === `token ${ADMIN_PAT}`),
      true,
    );
    const stored = await directory.findActiveWebhookSecret(connectionId);
    assert.notEqual(stored, undefined);
    if (stored === undefined) throw new Error("webhook secret missing");
    const plaintext = decryptSecret(
      secrets,
      {
        alg: "aes-256-gcm",
        keyId: stored.keyId,
        nonce: stored.nonce,
        ciphertext: stored.ciphertext,
        aadVersion: 1,
      },
      {
        organizationId: stored.organizationId,
        credentialId: stored.id,
        kind: "webhook_secret",
      },
    );
    assert.equal(plaintext.includes(ADMIN_PAT), false);
    assert.match(plaintext, /^[0-9a-f]{64}$/u);
    const connectionCredential = await directory.findActiveConnectionCredential(connectionId);
    assert.notEqual(connectionCredential, undefined);
    if (connectionCredential === undefined) throw new Error("connection credential missing");
    assert.equal(
      decryptSecret(
        secrets,
        {
          alg: "aes-256-gcm",
          keyId: connectionCredential.keyId,
          nonce: connectionCredential.nonce,
          ciphertext: connectionCredential.ciphertext,
          aadVersion: 1,
        },
        {
          organizationId: connectionCredential.organizationId,
          credentialId: connectionCredential.id,
          kind: "connection",
        },
      ).includes(ADMIN_PAT),
      false,
    );
  });

  it("reconciles an existing callback URL with PATCH instead of creating a second hook", async () => {
    const { directory, http, secrets, connectionId, calls } = await connectedWorld({
      existingHook: true,
    });
    const updated = await handleForgejoWebhookRequest(
      jsonRequest(`https://hub.test/connections/${connectionId}/hooks`, {
        mode: "automatic",
        adminPat: ADMIN_PAT,
      }),
      webhookOptions({ directory, http, secrets }),
    );
    assert.equal(updated.status, 200);
    assert.equal(
      calls.some((call) => call.method === "POST" && !call.path.endsWith("/tests")),
      false,
    );
    assert.equal(
      calls.some((call) => call.method === "PATCH"),
      true,
    );
  });

  it("configures manual hooks without an admin PAT and never calls hook APIs", async () => {
    const { directory, http, secrets, connectionId, seen } = await connectedWorld();
    const before = seen.length;
    const created = await handleForgejoWebhookRequest(
      jsonRequest(`https://hub.test/connections/${connectionId}/hooks`, { mode: "manual" }),
      webhookOptions({ directory, http, secrets }),
    );
    assert.equal(created.status, 200);
    const body = record(await created.json(), "manual");
    const credential = record(field(body, "credential"), "credential");
    assert.equal(field(credential, "kind"), "webhook_secret");
    assert.match(String(field(credential, "secret")), /^[0-9a-f]{64}$/u);
    const hooks = list(field(body, "hooks"), "hooks");
    const first = record(hooks[0], "manual hook");
    assert.equal(first["status"], "manual_pending");
    assert.equal(first["managed"], false);
    assert.equal(
      seen.slice(before).some((path) => path.includes("/hooks")),
      false,
    );
    const listed = await handleForgejoWebhookRequest(
      new Request(`https://hub.test/connections/${connectionId}/hooks`),
      webhookOptions({ directory, http, secrets }),
    );
    const listedBody = record(await listed.json(), "listed");
    const listedCredential = record(field(listedBody, "credential"), "listed credential");
    assert.equal(field(listedCredential, "secret"), "••••");
  });

  it("rejects automatic setup when Forgejo returns 403 for a non-admin token", async () => {
    const { directory, http, secrets, connectionId } = await connectedWorld({ hookStatus: 403 });
    const denied = await handleForgejoWebhookRequest(
      jsonRequest(`https://hub.test/connections/${connectionId}/hooks`, {
        mode: "automatic",
        adminPat: ADMIN_PAT,
      }),
      webhookOptions({ directory, http, secrets }),
    );
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "forgejo_identity_mismatch" });
  });

  it("rejects members and disconnected connections", async () => {
    const { directory, http, secrets, connectionId } = await connectedWorld();
    const member = await handleForgejoWebhookRequest(
      jsonRequest(`https://hub.test/connections/${connectionId}/hooks`, { mode: "manual" }),
      webhookOptions({
        directory,
        http,
        secrets,
        access: access({ organizationRole: "member" }),
      }),
    );
    assert.equal(member.status, 403);
  });
});

async function connectedWorld(
  options: { existingHook?: boolean; hookStatus?: number } = {},
): Promise<{
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
  connectionId: string;
  seen: string[];
  tokens: string[];
  calls: { method: string; path: string }[];
}> {
  const fixtures = await loadForgejoContractFixtures();
  const directory = createMemoryForgejoDirectory();
  const secrets = testSecrets();
  const seen: string[] = [];
  const tokens: string[] = [];
  const calls: { method: string; path: string }[] = [];
  const connectionRef = { id: "" };
  const http = hookHttp(fixtures, {
    seen,
    tokens,
    calls,
    existingHook: options.existingHook === true,
    connectionRef,
    ...(options.hookStatus === undefined ? {} : { hookStatus: options.hookStatus }),
  });
  const approved = await handleForgejoInstancesRequest(
    jsonRequest("https://hub.test/instances", { origin: "https://forgejo.example.test" }),
    { access: operatorAccess(), directory, http },
  );
  const instance = record(field(record(await approved.json(), "approved"), "instance"), "instance");
  const created = await handleForgejoConnectionsRequest(
    jsonRequest("https://hub.test/connections", {
      instanceId: String(instance["id"]),
      slug: "forgejo",
      claimedUsername: "t00user",
      pat: CONNECTION_PAT,
      scopes: ["write:issue", "write:repository"],
      repositories: [1],
    }),
    { access: ownerAccess(), directory, http, secrets },
  );
  assert.equal(created.status, 201);
  const connection = record(
    field(record(await created.json(), "created"), "connection"),
    "connection",
  );
  const connectionId = String(connection["id"]);
  connectionRef.id = connectionId;
  const enrolled = await handleForgejoConnectionsRequest(
    jsonRequest(`https://hub.test/connections/${connectionId}/enroll`, { repositoryIds: [1] }),
    { access: ownerAccess(), directory, http, secrets },
  );
  assert.equal(enrolled.status, 200);
  return { directory, http, secrets, connectionId, seen, tokens, calls };
}

function webhookOptions(input: {
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
  access?: ForgejoAccessResolver;
}) {
  return {
    access: input.access ?? ownerAccess(),
    directory: input.directory,
    http: input.http,
    secrets: input.secrets,
    applicationBaseUrl: "https://hub.example.test",
  };
}

function hookHttp(
  fixtures: Awaited<ReturnType<typeof loadForgejoContractFixtures>>,
  options: {
    seen: string[];
    tokens: string[];
    calls: { method: string; path: string }[];
    existingHook: boolean;
    hookStatus?: number;
    connectionRef: { id: string };
  },
): ForgejoHttp {
  const capability = record(fixtures.hydration["apiCapability"], "apiCapability");
  const version = record(field(capability, "version"), "version");
  const settings = record(field(capability, "settings"), "settings");
  const repository = record(
    field(record(fixtures.hydration["repository"], "repository"), "body"),
    "body",
  );
  return {
    resolver: { resolve: async () => ["203.0.113.10"] },
    fetch: async (input, init) => {
      const url = requestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      options.seen.push(url.pathname);
      if (url.pathname.includes("/hooks")) {
        options.calls.push({ method, path: url.pathname });
        const authorization = headersOf(init).get("authorization");
        if (authorization !== null) options.tokens.push(authorization);
        if (options.hookStatus !== undefined) {
          return Response.json({ message: "forbidden" }, { status: options.hookStatus });
        }
        if (method === "GET") {
          return Response.json(
            options.existingHook
              ? [
                  {
                    id: 42,
                    config: {
                      url: `https://hub.example.test/api/integrations/forgejo/webhook/${options.connectionRef.id}`,
                    },
                  },
                ]
              : [],
          );
        }
        if (method === "POST" && url.pathname.endsWith("/tests")) {
          return new Response(null, { status: 204 });
        }
        if (method === "POST") return Response.json({ id: 7 });
        if (method === "PATCH") return Response.json({ id: 42 });
      }
      if (url.pathname === "/api/v1/version") return Response.json(version);
      if (url.pathname === "/api/v1/settings/api") return Response.json(settings);
      if (url.pathname === "/api/v1/repos/search") {
        return new Response(JSON.stringify({ ok: true, data: [repository] }), {
          headers: { "content-type": "application/json", "x-total-count": "1" },
        });
      }
      if (url.pathname.includes("/collaborators/")) {
        return Response.json({
          permission: "admin",
          role_name: "owner",
          user: { id: 1, login: "t00user" },
        });
      }
      throw new Error(`unexpected Forgejo path ${url.pathname}`);
    },
  };
}

function headersOf(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  throw new Error("unsupported fetch input");
}

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ownerAccess(): ForgejoAccessResolver {
  return access({ organizationRole: "owner" });
}

function operatorAccess(): ForgejoAccessResolver {
  return access({ isInstanceOperator: true, organizationId: null, organizationRole: null });
}

function access(
  input: Partial<ForgejoAccess> & { organizationRole?: ForgejoAccess["organizationRole"] } = {},
): ForgejoAccessResolver {
  return {
    resolve: async () => ({
      userId: "user-1",
      isInstanceOperator: input.isInstanceOperator === true,
      organizationId: input.organizationId === undefined ? "org-1" : input.organizationId,
      organizationRole: input.organizationRole ?? "owner",
    }),
  };
}

function testSecrets(): SecretEncryptionKeySource {
  const key = randomBytes(32);
  const current = { keyId: 1, key };
  return {
    current: () => current,
    byId: (id) => (id === 1 ? current : undefined),
  };
}
