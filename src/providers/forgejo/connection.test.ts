import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { z } from "zod";
import type { AuthServer } from "../../auth/server.js";
import type {
  Database,
  DisconnectConnectionResult,
  ForgejoConnectionRecord,
  ForgejoWebhookRecord,
  TenantRouteAccess,
} from "../../db/types.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { createForgejoConnection } from "./connection.js";
import { ForgejoApiError, type ForgejoApiClient } from "./client.js";

const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";
const CONNECTION_ID = "80000000-0000-4000-8000-000000000001";

const CreateResponseSchema = z.object({ connection: z.object({ webhookUrl: z.string() }) });

describe("Forgejo connection create", () => {
  it("stores the connection and returns the webhook url built server side", async () => {
    const database = fakeDatabase({});
    const api = fakeApi({
      readViewer: () => Promise.resolve({ login: "trillian", id: 42 }),
    });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api,
      applicationBaseUrl: "https://hub.example.test/",
    });

    const response = await connection.actions["create"]!(
      request("create", {}, { instanceBaseUrl: "https://git.example.test", accessToken: "t" }),
    );

    assert.equal(response.status, 200);
    const body = CreateResponseSchema.parse(await response.json());
    assert.equal(
      body.connection.webhookUrl,
      `https://hub.example.test/api/integrations/forgejo/events/${CONNECTION_ID}`,
    );
  });

  it("maps a 403 from the viewer lookup to a missing-scopes error, not the generic refusal", async () => {
    const database = fakeDatabase({});
    const api = fakeApi({
      readViewer: () => Promise.reject(new ForgejoApiError(403, "forbidden")),
    });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api,
      applicationBaseUrl: "https://hub.example.test/",
    });

    const response = await connection.actions["create"]!(
      request("create", {}, { instanceBaseUrl: "https://git.example.test", accessToken: "t" }),
    );

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "insufficient_token_scopes" });
  });

  it("refuses a second bind of the same account on the same instance in this org", async () => {
    const database = fakeDatabase({
      existingForgejoConnections: [
        { ...connectionRecord(), id: "existing-1", slug: "acme-forge-1", accountId: 42 },
      ],
    });
    const api = fakeApi({
      readViewer: () => Promise.resolve({ login: "trillian", id: 42 }),
    });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api,
      applicationBaseUrl: "https://hub.example.test/",
    });

    const response = await connection.actions["create"]!(
      request("create", {}, { instanceBaseUrl: "https://git.example.test", accessToken: "t" }),
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "account_already_connected",
      connectionId: "existing-1",
      connectionSlug: "acme-forge-1",
    });
  });

  it("allows the same account bound on a different instance", async () => {
    const database = fakeDatabase({
      existingForgejoConnections: [
        {
          ...connectionRecord(),
          id: "existing-1",
          instanceBaseUrl: "https://other.example.test",
          accountId: 42,
        },
      ],
    });
    const api = fakeApi({
      readViewer: () => Promise.resolve({ login: "trillian", id: 42 }),
    });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api,
      applicationBaseUrl: "https://hub.example.test/",
    });

    const response = await connection.actions["create"]!(
      request("create", {}, { instanceBaseUrl: "https://git.example.test", accessToken: "t" }),
    );

    assert.equal(response.status, 200);
  });

  it("allows a different account bound on the same instance", async () => {
    const database = fakeDatabase({
      existingForgejoConnections: [{ ...connectionRecord(), id: "existing-1", accountId: 7 }],
    });
    const api = fakeApi({
      readViewer: () => Promise.resolve({ login: "trillian", id: 42 }),
    });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api,
      applicationBaseUrl: "https://hub.example.test/",
    });

    const response = await connection.actions["create"]!(
      request("create", {}, { instanceBaseUrl: "https://git.example.test", accessToken: "t" }),
    );

    assert.equal(response.status, 200);
  });
});

describe("Forgejo connection actions, cross-organization refusal", () => {
  it("refuses to list orgs for a connection that belongs to another organization", async () => {
    const database = fakeDatabase({
      connection: { ...connectionRecord(), organizationId: OTHER_ORG_ID },
    });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api: fakeApi({}),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await connection.actions["orgs"]!(
      request("orgs", { connectionId: CONNECTION_ID }),
    );

    assert.equal(response.status, 403);
  });

  it("refuses to subscribe a connection that belongs to another organization", async () => {
    const database = fakeDatabase({
      connection: { ...connectionRecord(), organizationId: OTHER_ORG_ID },
    });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api: fakeApi({}),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await connection.actions["subscribe"]!(
      request("subscribe", { connectionId: CONNECTION_ID }, { scope: "user" }),
    );

    assert.equal(response.status, 403);
  });

  it("refuses to disconnect a connection that belongs to another organization", async () => {
    const database = fakeDatabase({
      connection: { ...connectionRecord(), organizationId: OTHER_ORG_ID },
    });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api: fakeApi({}),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await connection.actions["disconnect"]!(
      request("disconnect", { connectionId: CONNECTION_ID }),
    );

    assert.equal(response.status, 403);
  });
});

describe("Forgejo connection orgs listing", () => {
  it("offers an empty list instead of failing when the instance refuses the listing", async () => {
    const database = fakeDatabase({ connection: connectionRecord() });
    const api = fakeApi({
      listMyOrgs: () => Promise.reject(new Error("instance refused")),
    });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api,
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await connection.actions["orgs"]!(
      request("orgs", { connectionId: CONNECTION_ID }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      orgs: [],
      unavailable: true,
      webhookUrl: `https://hub.example.test/api/integrations/forgejo/events/${CONNECTION_ID}`,
      webhookSecret: "shh",
    });
  });

  it("sends the stored secret back so an existing connection's manual path can show it again", async () => {
    const database = fakeDatabase({ connection: connectionRecord() });
    const api = fakeApi({ listMyOrgs: () => Promise.resolve([{ username: "acme-org" }]) });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api,
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await connection.actions["orgs"]!(
      request("orgs", { connectionId: CONNECTION_ID }),
    );

    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    assert.deepEqual(body, {
      orgs: [{ username: "acme-org" }],
      unavailable: false,
      webhookUrl: `https://hub.example.test/api/integrations/forgejo/events/${CONNECTION_ID}`,
      webhookSecret: "shh",
    });
  });
});

describe("Forgejo connection disconnect", () => {
  it("answers before the detached hook cleanup finishes, not after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deleted: number[] = [];
    const database = fakeDatabase({
      connection: connectionRecord(),
      webhooks: [
        {
          id: "hook-row-1",
          connectionId: CONNECTION_ID,
          scope: "user",
          owner: "trillian",
          hookId: 1,
        },
      ],
    });
    const api = fakeApi({
      deleteHook: async (_credentials, _target, hookId) => {
        await gate;
        deleted.push(hookId);
      },
    });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api,
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await connection.actions["disconnect"]!(
      request("disconnect", { connectionId: CONNECTION_ID }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { disconnected: true });
    assert.deepEqual(deleted, []);

    release();
    await vi.waitFor(() => {
      if (deleted.length === 0) throw new Error("detached cleanup has not run yet");
    });
    assert.deepEqual(deleted, [1]);
  });

  it("best-effort deletes every recorded hook and still disconnects when a delete fails", async () => {
    const deleted: number[] = [];
    const database = fakeDatabase({
      connection: connectionRecord(),
      webhooks: [
        {
          id: "hook-row-1",
          connectionId: CONNECTION_ID,
          scope: "user",
          owner: "trillian",
          hookId: 1,
        },
        { id: "hook-row-2", connectionId: CONNECTION_ID, scope: "org", owner: "acme", hookId: 2 },
      ],
    });
    const api = fakeApi({
      deleteHook: (_credentials, _target, hookId) => {
        deleted.push(hookId);
        if (hookId === 2) return Promise.reject(new Error("instance unreachable"));
        return Promise.resolve();
      },
    });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api,
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await connection.actions["disconnect"]!(
      request("disconnect", { connectionId: CONNECTION_ID }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { disconnected: true });
    await vi.waitFor(() => {
      if (deleted.length < 2) throw new Error("detached cleanup has not run yet");
    });
    assert.deepEqual(
      deleted.sort((a, b) => a - b),
      [1, 2],
    );
  });

  it("also deletes a hook beyond the tracked row, found by listing and matching Hub's url", async () => {
    const deleted: number[] = [];
    const webhookUrl = `https://hub.example.test/api/integrations/forgejo/events/${CONNECTION_ID}`;
    const database = fakeDatabase({
      connection: connectionRecord(),
      webhooks: [
        {
          id: "hook-row-1",
          connectionId: CONNECTION_ID,
          scope: "user",
          owner: "trillian",
          hookId: 1,
        },
      ],
    });
    const api = fakeApi({
      deleteHook: (_credentials, _target, hookId) => {
        deleted.push(hookId);
        return Promise.resolve();
      },
      listHooks: () =>
        Promise.resolve([
          { id: 1, url: webhookUrl, active: undefined, events: undefined },
          // orphaned: hub's own url, but not the row disconnect already knew about
          { id: 99, url: webhookUrl, active: undefined, events: undefined },
          {
            id: 100,
            url: "https://git.example.test/some/other/hook",
            active: undefined,
            events: undefined,
          },
        ]),
    });
    const connection = createForgejoConnection({
      database,
      auth: fakeAuth(),
      api,
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await connection.actions["disconnect"]!(
      request("disconnect", { connectionId: CONNECTION_ID }),
    );

    assert.equal(response.status, 200);
    await vi.waitFor(() => {
      if (deleted.length < 2) throw new Error("detached cleanup has not run yet");
    });
    assert.deepEqual(
      deleted.sort((a, b) => a - b),
      [1, 99],
    );
  });

  it("answers 409 while a subscribe holds the connection's hook lease", async () => {
    let disconnected = false;
    const database = fakeDatabase({ connection: connectionRecord() });
    const connection = createForgejoConnection({
      database: {
        ...database,
        disconnectConnection: (...args) => {
          disconnected = true;
          return database.disconnectConnection(...args);
        },
      },
      auth: fakeAuth(),
      api: fakeApi({}),
      applicationBaseUrl: "https://hub.example.test",
    });

    const subscribeLease = await database.claimForgejoHookLease(CONNECTION_ID, ORG_ID);
    assert.ok(subscribeLease);
    const response = await connection.actions["disconnect"]!(
      request("disconnect", { connectionId: CONNECTION_ID }),
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "operation_in_progress" });
    assert.equal(disconnected, false);
  });
});

function connectionRecord(): ForgejoConnectionRecord {
  return {
    id: CONNECTION_ID,
    organizationId: ORG_ID,
    slug: "acme-forge",
    instanceBaseUrl: "https://git.example.test",
    instanceHost: "git.example.test",
    webhookSecret: "shh",
    accessToken: "forgejo-access-token",
    accountLogin: "trillian",
    accountId: 42,
    instanceFlavor: "forgejo",
    instanceVersion: "16.0.5+gitea-1.22.0",
  };
}

function request(
  action: "create" | "disconnect" | "orgs" | "subscribe",
  params: Record<string, string>,
  body?: unknown,
): Request {
  const url = new URL(`https://hub.example.test/connections/${action}`);
  url.searchParams.set("organizationSlug", "acme");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function fakeAuth(): AuthServer {
  return {
    handle: () => Promise.reject(new Error("not used in this test")),
    resources: () => Promise.reject(new Error("not used in this test")),
    resolveOrganizationAccess: () => Promise.reject(new Error("not used in this test")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: null },
        account: { id: "user-1", name: "Trillian", email: "trillian@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}

type ForgejoActionsDatabase = Pick<
  Database,
  | "resolveTenantRouteAccess"
  | "findForgejoConnection"
  | "listForgejoWebhooks"
  | "recordForgejoWebhook"
  | "disconnectConnection"
  | "bindForgejoConnection"
  | "claimForgejoHookLease"
  | "releaseForgejoHookLease"
  | "organizationConnectionUsage"
>;

function fakeDatabase(input: {
  connection?: ForgejoConnectionRecord;
  webhooks?: ForgejoWebhookRecord[];
  // feeds organizationConnectionUsage, for the already-connected-account guard in create
  existingForgejoConnections?: ForgejoConnectionRecord[];
}): Database {
  const webhooks = input.webhooks ?? [];
  const partial: ForgejoActionsDatabase = {
    resolveTenantRouteAccess: (): Promise<TenantRouteAccess | undefined> =>
      Promise.resolve({
        organization: { id: ORG_ID, name: "Acme", slug: "acme" },
        membership: { id: "membership-1", role: "owner" },
      }),
    findForgejoConnection: (id: string) =>
      Promise.resolve(input.connection?.id === id ? input.connection : undefined),
    listForgejoWebhooks: (connectionId: string) =>
      Promise.resolve(webhooks.filter((hook) => hook.connectionId === connectionId)),
    recordForgejoWebhook: (record) => Promise.resolve({ id: "row-1", ...record }),
    disconnectConnection: (): Promise<DisconnectConnectionResult> =>
      Promise.resolve({
        provider: "forgejo",
        instanceBaseUrl: input.connection?.instanceBaseUrl,
        accessToken: input.connection?.accessToken,
      }),
    bindForgejoConnection: () =>
      Promise.resolve({
        id: CONNECTION_ID,
        organizationId: ORG_ID,
        slug: "acme-forge",
        instanceBaseUrl: "https://git.example.test",
        instanceHost: "git.example.test",
        webhookSecret: "shh",
        accessToken: "forgejo-access-token",
        accountLogin: "trillian",
        accountId: 42,
        instanceFlavor: "forgejo",
        instanceVersion: "16.0.5+gitea-1.22.0",
      }),
    claimForgejoHookLease: (connectionId, organizationId) =>
      leases.claimForgejoHookLease(connectionId, organizationId),
    releaseForgejoHookLease: (connectionId, leaseId) =>
      leases.releaseForgejoHookLease(connectionId, leaseId),
    organizationConnectionUsage: () =>
      Promise.resolve({
        github: [],
        discord: [],
        slack: [],
        linear: [],
        forgejo: input.existingForgejoConnections ?? [],
      }),
  };
  // real lease semantics from the memory store, not stubbed
  const leases = createMemoryDatabase();
  leases.findForgejoConnection = partial.findForgejoConnection;
  const store = new Proxy(partial, {
    get(target, property: string) {
      if (property in target) return Reflect.get(target, property) as unknown;
      throw new Error(`forgejo connection actions should not need Database.${property}`);
    },
  });
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the proxy answers every other member by throwing, which no type can express
  return store as Database;
}

function fakeApi(overrides: Partial<ForgejoApiClient>): ForgejoApiClient {
  return {
    createIssueComment: () => Promise.reject(new Error("not used in this test")),
    readViewer: () => Promise.reject(new Error("not used in this test")),
    // create/replaceToken always probe this after readViewer succeeds
    readVersion: () => Promise.resolve({ version: "16.0.5+gitea-1.22.0" }),
    getRepository: () => Promise.reject(new Error("not used in this test")),
    listIssueTimeline: () => Promise.reject(new Error("not used in this test")),
    listPullReviews: () => Promise.reject(new Error("not used in this test")),
    listPullReviewComments: () => Promise.reject(new Error("not used in this test")),
    listMyOrgs: () => Promise.reject(new Error("not used in this test")),
    listHooks: () => Promise.reject(new Error("not used in this test")),
    createHook: () => Promise.reject(new Error("not used in this test")),
    deleteHook: () => Promise.reject(new Error("not used in this test")),
    createReaction: () => Promise.reject(new Error("not used in this test")),
    deleteReaction: () => Promise.reject(new Error("not used in this test")),
    ...overrides,
  };
}
