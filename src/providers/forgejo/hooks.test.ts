import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { z } from "zod";
import type { AuthServer } from "../../auth/server.js";
import type {
  Database,
  ForgejoConnectionRecord,
  ForgejoWebhookRecord,
  RecordForgejoWebhookInput,
  TenantRouteAccess,
} from "../../db/types.js";
import { ForgejoApiError, type ForgejoApiClient, type ForgejoHookTarget } from "./client.js";
import { createMemoryDatabase } from "../../db/memory.js";
import {
  createForgejoSubscribeAction,
  deleteConnectionHooksBestEffort,
  FORGEJO_HOOK_EVENTS,
  FORGEJO_USER_SCOPE_OWNER,
} from "./hooks.js";

const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";
const CONNECTION_ID = "80000000-0000-4000-8000-000000000002";

const SubscribeResponseSchema = z.object({
  scope: z.enum(["user", "org"]),
  owner: z.string(),
  webhookUrl: z.string(),
});

describe("Forgejo subscribe, idempotency", () => {
  it("creates a hook and records it when no matching hook exists yet", async () => {
    let created: { target: ForgejoHookTarget; events: readonly string[] } | undefined;
    const recorded: RecordForgejoWebhookInput[] = [];
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({ recorded }),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () => Promise.resolve([]),
        createHook: (_credentials, target, input) => {
          created = { target, events: input.events };
          return Promise.resolve({ id: 42 });
        },
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await subscribe(subscribeRequest({ scope: "user" }));

    assert.equal(response.status, 200);
    const body = SubscribeResponseSchema.parse(await response.json());
    assert.equal(body.scope, "user");
    assert.equal(body.owner, "trillian");
    assert.deepEqual(created?.target, { scope: "user" });
    // fixture connection is forgejo 16, past the ci-run events gate
    assert.deepEqual(
      [...(created?.events ?? [])],
      ["issues", "pull_request", "push", "action_run_failure", "action_run_success"],
    );
    assert.deepEqual(recorded, [
      { connectionId: CONNECTION_ID, scope: "user", owner: FORGEJO_USER_SCOPE_OWNER, hookId: 42 },
    ]);
  });

  it("does not ask an instance predating forgejo 12 for the CI-run events", async () => {
    let created: { events: readonly string[] } | undefined;
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({ instanceFlavor: "forgejo", instanceVersion: "11.0.1+gitea-1.22.0" }),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () => Promise.resolve([]),
        createHook: (_credentials, _target, input) => {
          created = { events: input.events };
          return Promise.resolve({ id: 1 });
        },
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    await subscribe(subscribeRequest({ scope: "user" }));

    assert.deepEqual([...(created?.events ?? [])], ["issues", "pull_request", "push"]);
  });

  it("does not ask a gitea instance for the CI-run events", async () => {
    let created: { events: readonly string[] } | undefined;
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({ instanceFlavor: "gitea", instanceVersion: "1.22.0" }),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () => Promise.resolve([]),
        createHook: (_credentials, _target, input) => {
          created = { events: input.events };
          return Promise.resolve({ id: 1 });
        },
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    await subscribe(subscribeRequest({ scope: "user" }));

    assert.deepEqual([...(created?.events ?? [])], ["issues", "pull_request", "push"]);
  });

  it("replaces a hook already pointing at Hub's own url instead of trusting its secret", async () => {
    const deleted: number[] = [];
    let createCalls = 0;
    const recorded: RecordForgejoWebhookInput[] = [];
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({ recorded }),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () =>
          Promise.resolve([
            {
              id: 9,
              url: "https://hub.example.test/api/integrations/forgejo/events/80000000-0000-4000-8000-000000000002",
              active: true,
              events: [...FORGEJO_HOOK_EVENTS],
            },
          ]),
        deleteHook: (_credentials, _target, hookId) => {
          deleted.push(hookId);
          return Promise.resolve();
        },
        createHook: () => {
          createCalls++;
          return Promise.resolve({ id: 99 });
        },
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await subscribe(subscribeRequest({ scope: "org", org: "acme" }));

    assert.equal(response.status, 200);
    assert.deepEqual(deleted, [9]);
    assert.equal(createCalls, 1);
    assert.deepEqual(recorded, [
      { connectionId: CONNECTION_ID, scope: "org", owner: "acme", hookId: 99 },
    ]);
  });

  it("replaces an unrecorded hook that already exists remotely, on a fresh connection", async () => {
    const deleted: number[] = [];
    const recorded: RecordForgejoWebhookInput[] = [];
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({ recorded }),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () =>
          Promise.resolve([
            {
              id: 5,
              url: "https://hub.example.test/api/integrations/forgejo/events/80000000-0000-4000-8000-000000000002",
              active: true,
              events: [...FORGEJO_HOOK_EVENTS],
            },
          ]),
        deleteHook: (_credentials, _target, hookId) => {
          deleted.push(hookId);
          return Promise.resolve();
        },
        createHook: () => Promise.resolve({ id: 6 }),
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    await subscribe(subscribeRequest({ scope: "user" }));

    assert.deepEqual(deleted, [5]);
    assert.deepEqual(recorded, [
      { connectionId: CONNECTION_ID, scope: "user", owner: FORGEJO_USER_SCOPE_OWNER, hookId: 6 },
    ]);
  });

  it("does not block subscribe when deleting the superseded hook fails", async () => {
    let createCalls = 0;
    const recorded: RecordForgejoWebhookInput[] = [];
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({ recorded }),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () =>
          Promise.resolve([
            {
              id: 9,
              url: "https://hub.example.test/api/integrations/forgejo/events/80000000-0000-4000-8000-000000000002",
              active: true,
              events: [...FORGEJO_HOOK_EVENTS],
            },
          ]),
        deleteHook: () => Promise.reject(new ForgejoApiError(403, "forbidden")),
        createHook: () => {
          createCalls++;
          return Promise.resolve({ id: 99 });
        },
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await subscribe(subscribeRequest({ scope: "user" }));

    assert.equal(response.status, 200);
    assert.equal(createCalls, 1);
    assert.deepEqual(recorded, [
      { connectionId: CONNECTION_ID, scope: "user", owner: FORGEJO_USER_SCOPE_OWNER, hookId: 99 },
    ]);
  });

  it("propagates a create failure without ever touching the old hook", async () => {
    const deleted: number[] = [];
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({}),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () =>
          Promise.resolve([
            {
              id: 9,
              url: "https://hub.example.test/api/integrations/forgejo/events/80000000-0000-4000-8000-000000000002",
              active: true,
              events: [...FORGEJO_HOOK_EVENTS],
            },
          ]),
        deleteHook: (_credentials, _target, hookId) => {
          deleted.push(hookId);
          return Promise.resolve();
        },
        createHook: () => Promise.reject(new Error("instance unreachable")),
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await subscribe(subscribeRequest({ scope: "user" }));

    assert.equal(response.status, 503);
    assert.deepEqual(deleted, []);
  });

  it("rolls the new hook back when recording it fails", async () => {
    const deleted: number[] = [];
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({ recordForgejoWebhook: () => Promise.reject(new Error("db down")) }),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () => Promise.resolve([]),
        createHook: () => Promise.resolve({ id: 77 }),
        deleteHook: (_credentials, _target, hookId) => {
          deleted.push(hookId);
          return Promise.resolve();
        },
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await subscribe(subscribeRequest({ scope: "user" }));

    assert.equal(response.status, 503);
    assert.deepEqual(deleted, [77]);
  });

  it("normalizes an organization's case so it lands on the same stored target either way", async () => {
    const recorded: RecordForgejoWebhookInput[] = [];
    const seenTargets: ForgejoHookTarget[] = [];
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({ recorded }),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: (_credentials, target) => {
          seenTargets.push(target);
          return Promise.resolve([]);
        },
        createHook: () => Promise.resolve({ id: 5 }),
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    await subscribe(subscribeRequest({ scope: "org", org: "Acme" }));

    assert.deepEqual(seenTargets, [{ scope: "org", org: "acme" }]);
    assert.deepEqual(recorded, [
      { connectionId: CONNECTION_ID, scope: "org", owner: "acme", hookId: 5 },
    ]);
  });

  it("answers a concurrent subscribe with 409 instead of creating a second hook", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listing = false;
    let createCalls = 0;
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({}),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: async () => {
          listing = true;
          await gate;
          return [];
        },
        createHook: () => {
          createCalls++;
          return Promise.resolve({ id: createCalls });
        },
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const first = subscribe(subscribeRequest({ scope: "user" }));
    await vi.waitFor(() => {
      if (!listing) throw new Error("first subscribe has not reached the instance yet");
    });
    const second = await subscribe(subscribeRequest({ scope: "user" }));

    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: "operation_in_progress" });
    release();
    assert.equal((await first).status, 200);
    assert.equal(createCalls, 1);
  });

  it("releases the lease when subscribe is done, so the next one runs", async () => {
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({}),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () => Promise.resolve([]),
        createHook: () => Promise.resolve({ id: 1 }),
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const first = await subscribe(subscribeRequest({ scope: "user" }));
    const second = await subscribe(subscribeRequest({ scope: "user" }));

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
  });

  it("releases the lease when the instance fails, too", async () => {
    let failing = true;
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({}),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () =>
          failing ? Promise.reject(new Error("instance unreachable")) : Promise.resolve([]),
        createHook: () => Promise.resolve({ id: 1 }),
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const failed = await subscribe(subscribeRequest({ scope: "user" }));
    failing = false;
    const retried = await subscribe(subscribeRequest({ scope: "user" }));

    assert.equal(failed.status, 503);
    assert.equal(retried.status, 200);
  });

  it("never reaches the instance while a disconnect holds the lease", async () => {
    let listCalls = 0;
    const database = fakeDatabase({});
    const subscribe = createForgejoSubscribeAction({
      database,
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () => {
          listCalls++;
          return Promise.resolve([]);
        },
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const disconnectLease = await database.claimForgejoHookLease(CONNECTION_ID, ORG_ID);
    assert.ok(disconnectLease);
    const response = await subscribe(subscribeRequest({ scope: "user" }));

    assert.equal(response.status, 409);
    assert.equal(listCalls, 0);
  });
});

describe("Forgejo hook cleanup, grouping by remote target", () => {
  const WEBHOOK_URL = `https://hub.example.test/api/integrations/forgejo/events/${CONNECTION_ID}`;
  const CREDENTIALS = { instanceBaseUrl: "https://git.example.test", accessToken: "shh" };

  it("lists and sweeps a shared target once, not once per row that tracked it", async () => {
    const deleted: number[] = [];
    let listCalls = 0;
    const api = fakeApi({
      deleteHook: (_credentials, _target, hookId) => {
        deleted.push(hookId);
        return Promise.resolve();
      },
      listHooks: () => {
        listCalls++;
        return Promise.resolve([
          { id: 1, url: WEBHOOK_URL, active: undefined, events: undefined },
          { id: 2, url: WEBHOOK_URL, active: undefined, events: undefined },
          // orphaned: nothing tracks it, but still points at hub's own url
          { id: 99, url: WEBHOOK_URL, active: undefined, events: undefined },
        ]);
      },
    });

    // two rows left over from a login rename, both resolve to the same user-scope target
    const hooks: ForgejoWebhookRecord[] = [
      { id: "row-1", connectionId: CONNECTION_ID, scope: "user", owner: "old-login", hookId: 1 },
      {
        id: "row-2",
        connectionId: CONNECTION_ID,
        scope: "user",
        owner: FORGEJO_USER_SCOPE_OWNER,
        hookId: 2,
      },
    ];

    await deleteConnectionHooksBestEffort(api, CREDENTIALS, WEBHOOK_URL, hooks);

    assert.equal(listCalls, 1);
    assert.equal(deleted.length, 3);
    assert.deepEqual(
      deleted.sort((a, b) => a - b),
      [1, 2, 99],
    );
  });

  it("keeps an org target's sweep separate from a user target's, even in the same call", async () => {
    const listedTargets: ForgejoHookTarget[] = [];
    const api = fakeApi({
      deleteHook: () => Promise.resolve(),
      listHooks: (_credentials, target) => {
        listedTargets.push(target);
        return Promise.resolve([]);
      },
    });

    const hooks: ForgejoWebhookRecord[] = [
      { id: "row-1", connectionId: CONNECTION_ID, scope: "user", owner: "trillian", hookId: 1 },
      { id: "row-2", connectionId: CONNECTION_ID, scope: "org", owner: "acme", hookId: 2 },
    ];

    await deleteConnectionHooksBestEffort(api, CREDENTIALS, WEBHOOK_URL, hooks);

    assert.equal(listedTargets.length, 2);
    assert.deepEqual(
      listedTargets.sort((a, b) => a.scope.localeCompare(b.scope)),
      [{ scope: "org", org: "acme" }, { scope: "user" }],
    );
  });
});

describe("Forgejo subscribe, permission mapping", () => {
  it("maps a 403 from the instance to hook_permission_denied, not a generic failure", async () => {
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({}),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () => Promise.reject(new ForgejoApiError(403, "forbidden")),
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await subscribe(subscribeRequest({ scope: "user" }));

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "hook_permission_denied" });
  });

  it("maps a 404 (org not found or not visible to the token) to its own code, not permission_denied", async () => {
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({}),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () => Promise.resolve([]),
        createHook: () => Promise.reject(new ForgejoApiError(404, "not found")),
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await subscribe(subscribeRequest({ scope: "org", org: "acme" }));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "hook_target_not_found" });
  });

  it("maps a 422 (instance rejected the hook itself) to its own code, carrying the reason", async () => {
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({}),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () => Promise.resolve([]),
        createHook: () =>
          Promise.reject(
            new ForgejoApiError(422, "forgejo request failed: 422: Invalid url", "Invalid url"),
          ),
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await subscribe(subscribeRequest({ scope: "user" }));

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "hook_rejected", reason: "Invalid url" });
  });

  it("does not map an unrelated instance failure to the permission code", async () => {
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({}),
      auth: fakeAuth(),
      api: fakeApi({
        listHooks: () => Promise.reject(new Error("instance unreachable")),
      }),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await subscribe(subscribeRequest({ scope: "user" }));

    assert.equal(response.status, 503);
    const body = z.object({ error: z.string() }).parse(await response.json());
    assert.notEqual(body.error, "hook_permission_denied");
  });

  it("refuses to subscribe a connection that belongs to another organization", async () => {
    const subscribe = createForgejoSubscribeAction({
      database: fakeDatabase({ organizationId: OTHER_ORG_ID }),
      auth: fakeAuth(),
      api: fakeApi({}),
      applicationBaseUrl: "https://hub.example.test",
    });

    const response = await subscribe(subscribeRequest({ scope: "user" }));

    assert.equal(response.status, 403);
  });
});

function subscribeRequest(body: { scope: "user" } | { scope: "org"; org: string }): Request {
  const url = new URL("https://hub.example.test/connections/subscribe");
  url.searchParams.set("organizationSlug", "acme");
  url.searchParams.set("connectionId", CONNECTION_ID);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

type ForgejoSubscribeDatabase = Pick<
  Database,
  | "resolveTenantRouteAccess"
  | "findForgejoConnection"
  | "recordForgejoWebhook"
  | "claimForgejoHookLease"
  | "releaseForgejoHookLease"
>;

function fakeDatabase(input: {
  organizationId?: string;
  recorded?: RecordForgejoWebhookInput[];
  recordForgejoWebhook?: Database["recordForgejoWebhook"];
  instanceFlavor?: ForgejoConnectionRecord["instanceFlavor"];
  instanceVersion?: string;
}): Database {
  const connection: ForgejoConnectionRecord = {
    id: CONNECTION_ID,
    organizationId: input.organizationId ?? ORG_ID,
    slug: "acme-forge",
    instanceBaseUrl: "https://git.example.test",
    instanceHost: "git.example.test",
    webhookSecret: "shh",
    accessToken: "forgejo-access-token",
    accountLogin: "trillian",
    accountId: 42,
    instanceFlavor: input.instanceFlavor ?? "forgejo",
    instanceVersion: input.instanceVersion ?? "16.0.5+gitea-1.22.0",
  };
  const partial: ForgejoSubscribeDatabase = {
    resolveTenantRouteAccess: (): Promise<TenantRouteAccess | undefined> =>
      Promise.resolve({
        organization: { id: ORG_ID, name: "Acme", slug: "acme" },
        membership: { id: "membership-1", role: "owner" },
      }),
    findForgejoConnection: (id: string) =>
      Promise.resolve(id === connection.id ? connection : undefined),
    recordForgejoWebhook:
      input.recordForgejoWebhook ??
      ((record) => {
        input.recorded?.push(record);
        return Promise.resolve({ id: "row-1", ...record });
      }),
    claimForgejoHookLease: (connectionId, organizationId) =>
      leases.claimForgejoHookLease(connectionId, organizationId),
    releaseForgejoHookLease: (connectionId, leaseId) =>
      leases.releaseForgejoHookLease(connectionId, leaseId),
  };
  // real lease semantics from the memory store, not stubbed
  const leases = createMemoryDatabase();
  leases.findForgejoConnection = partial.findForgejoConnection;
  const store = new Proxy(partial, {
    get(target, property: string) {
      if (property in target) return Reflect.get(target, property) as unknown;
      throw new Error(`forgejo subscribe should not need Database.${property}`);
    },
  });
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the proxy answers every other member by throwing, which no type can express
  return store as Database;
}

function fakeApi(overrides: Partial<ForgejoApiClient>): ForgejoApiClient {
  return {
    createIssueComment: () => Promise.reject(new Error("not used in this test")),
    readViewer: () => Promise.reject(new Error("not used in this test")),
    readVersion: () => Promise.reject(new Error("not used in this test")),
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
