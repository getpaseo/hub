import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import {
  encryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import { field, record } from "./contract-test-read.js";
import { loadForgejoContractFixtures } from "./fake-server.js";
import {
  createMemoryForgejoDirectory,
  type ForgejoDirectory,
  type ForgejoHttp,
} from "./instances.js";
import { createForgejoRecoveryCoordinator, createForgejoRecoverySource } from "./recovery.js";
import {
  FORGEJO_HEALTH_INTERVAL_MS,
  FORGEJO_RETRY_INITIAL_MS,
  createMemoryForgejoRecoveryStore,
  forgejoWorkIdentity,
} from "./recovery-store.js";

const ORGANIZATION_ID = "org-1";
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const START = new Date("2026-08-31T00:00:00.000Z");

describe("Forgejo health recovery", () => {
  it("retries transient instance failures on the frozen backoff and succeeds once", async () => {
    const clock = fakeClock();
    const fixtures = await loadForgejoContractFixtures();
    let remainingFailures = 2;
    const http = fixtureHttp(fixtures, {
      beforeVersion: () => {
        if (remainingFailures === 0) return undefined;
        remainingFailures -= 1;
        return new Response("unavailable", { status: 503 });
      },
    });
    const directory = seededDirectory();
    const store = createMemoryForgejoRecoveryStore();
    const coordinator = createForgejoRecoveryCoordinator({
      directory,
      store,
      http,
      secrets: testSecrets(),
      clock,
      owner: "t13",
    });
    assert.equal(await coordinator.tick(), 1);
    const first = await store.find(
      "instance_health",
      forgejoWorkIdentity("instance_health", INSTANCE_ID),
    );
    assert.equal(first?.status, "retry_scheduled");
    assert.equal(first?.attemptCount, 1);
    assert.equal(first?.typedCause, "forgejo_origin_unapproved");
    clock.advance(FORGEJO_RETRY_INITIAL_MS);
    assert.equal(await coordinator.tick(), 1);
    clock.advance(FORGEJO_RETRY_INITIAL_MS * 2);
    assert.equal(await coordinator.tick(), 1);
    const recovered = await store.find(
      "instance_health",
      forgejoWorkIdentity("instance_health", INSTANCE_ID),
    );
    assert.equal(recovered?.status, "succeeded");
    assert.equal(recovered?.attemptCount, 0);
    assert.equal((await directory.findInstanceById(INSTANCE_ID))?.status, "active");
    const health = await coordinator.healthForInstance(INSTANCE_ID);
    assert.equal(health[0]?.remediation, "healthy");
    assert.equal(
      health[0]?.nextAttemptAt,
      new Date(clock.now().getTime() + FORGEJO_HEALTH_INTERVAL_MS).toISOString(),
    );
  });

  it("fails closed on 401 and does not auto-reactivate a contract-invalid instance", async () => {
    const clock = fakeClock();
    const fixtures = await loadForgejoContractFixtures();
    const http = fixtureHttp(fixtures, {
      beforeVersion: () => new Response("unauthorized", { status: 401 }),
    });
    const directory = seededDirectory();
    const store = createMemoryForgejoRecoveryStore();
    const coordinator = createForgejoRecoveryCoordinator({
      directory,
      store,
      http,
      secrets: testSecrets(),
      clock,
      owner: "t13",
    });
    assert.equal(await coordinator.tick(), 1);
    const work = await store.find(
      "instance_health",
      forgejoWorkIdentity("instance_health", INSTANCE_ID),
    );
    assert.equal(work?.status, "failed_permanent");
    assert.equal(work?.typedCause, "forgejo_identity_mismatch");
    clock.advance(FORGEJO_HEALTH_INTERVAL_MS);
    assert.equal(await coordinator.tick(), 0);
    assert.equal((await directory.findInstanceById(INSTANCE_ID))?.status, "identity_drifted");
  });

  it("ticks scheduled recovery on start and the frozen health interval without an operator request", async () => {
    let ticks = 0;
    let scheduled: (() => void) | undefined;
    const source = createForgejoRecoverySource({
      recovery: {
        tick: async () => {
          ticks += 1;
          return 0;
        },
      },
      intervalMs: FORGEJO_HEALTH_INTERVAL_MS,
      scheduleInterval: (run, ms) => {
        assert.equal(ms, FORGEJO_HEALTH_INTERVAL_MS);
        scheduled = run;
        return () => {
          scheduled = undefined;
        };
      },
    });
    await source.start(async () => {});
    assert.equal(ticks, 1);
    assert.equal(typeof scheduled, "function");
    scheduled?.();
    await Promise.resolve();
    assert.equal(ticks, 2);
    await source.stop();
    assert.equal(scheduled, undefined);
  });

  it("allows only one active claim and reclaims an expired lease", async () => {
    const store = createMemoryForgejoRecoveryStore();
    const now = START;
    await store.ensure({
      organizationId: null,
      workKind: "instance_health",
      workIdentity: forgejoWorkIdentity("instance_health", INSTANCE_ID),
      scope: { instanceId: INSTANCE_ID },
      now,
    });
    const first = await store.claimNext({ owner: "owner-a", now, leaseMs: 1_000 });
    const second = await store.claimNext({ owner: "owner-b", now, leaseMs: 1_000 });
    assert.equal(first?.claimedBy, "owner-a");
    assert.equal(second, undefined);
    const expired = await store.claimNext({
      owner: "owner-b",
      now: new Date(now.getTime() + 1_001),
      leaseMs: 1_000,
    });
    assert.equal(expired?.claimedBy, "owner-b");
  });

  it("redelivers an abandoned receipt without a second ACK identity", async () => {
    const clock = fakeClock();
    const database = createMemoryDatabase();
    const directory = database.forgejoDirectory();
    await directory.insertInstance(activeInstance());
    const secrets = testSecrets();
    await seedConnection(directory, secrets);
    const accepted = await database.acceptForgejoEvent({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
      repositoryId: 1,
      deliveryId: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      source: "forgejo.issues",
      payload: {
        headers: {
          "x-forgejo-delivery": "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "x-forgejo-event": "issues",
          "x-forgejo-event-type": "opened",
        },
        raw: "{}",
      },
      receivedAt: START,
      provider: "forgejo",
      bodySha256: "ab".repeat(32),
    });
    assert.equal(accepted.status, "accepted");
    const receiptId = accepted.receiptId;
    const handoffs: string[] = [];
    const coordinator = createForgejoRecoveryCoordinator({
      directory,
      store: database.forgejoRecovery(),
      http: unreachableHttp(),
      secrets,
      clock,
      owner: "t13",
      receipts: {
        listAbandoned: () => database.listAbandonedForgejoReceipts(),
        markDispatched: (id) => database.markForgejoReceiptDispatched(id),
      },
      dispatch: async ({ receiptId: id }) => {
        handoffs.push(id);
      },
    });
    assert.ok((await coordinator.tick()) >= 1);
    assert.deepEqual(handoffs, [receiptId]);
    assert.equal(await coordinator.tick(), 0);
    assert.deepEqual(handoffs, [receiptId]);
    const stored = await database.findProviderEventReceiptById(receiptId);
    assert.deepEqual(stored?.acceptedRoutes, []);
  });

  it("does not auto-retry remote cleanup until a one-time admin PAT is supplied", async () => {
    const clock = fakeClock();
    const directory = seededDirectory();
    const secrets = testSecrets();
    await seedConnection(directory, secrets, { disconnected: true, cleanupFailed: true });
    const store = createMemoryForgejoRecoveryStore();
    const deletes: string[] = [];
    const http: ForgejoHttp = {
      resolver: { resolve: async () => ["203.0.113.10"] },
      fetch: async (input, init) => {
        const url = requestUrl(input);
        const method = typeof init?.method === "string" ? init.method : "GET";
        if (method === "DELETE") deletes.push(url.pathname);
        if (url.pathname === "/api/v1/version") {
          return Response.json({ version: "16.0.3+gitea-1.22.0" });
        }
        if (url.pathname === "/api/v1/settings/api") {
          return Response.json({ max_response_items: 50, default_paging_num: 30 });
        }
        return new Response(null, { status: 204 });
      },
    };
    const coordinator = createForgejoRecoveryCoordinator({
      directory,
      store,
      http,
      secrets,
      clock,
      owner: "t13",
    });
    assert.ok((await coordinator.tick()) >= 1);
    assert.equal(deletes.length, 0);
    assert.equal(
      (await store.find("remote_cleanup", forgejoWorkIdentity("remote_cleanup", "hook-1")))?.status,
      "ready",
    );
    assert.equal(
      await coordinator.recoverCleanup({
        organizationId: ORGANIZATION_ID,
        connectionId: CONNECTION_ID,
        webhookAdminPat: "webhook-admin-pat-test-only",
      }),
      1,
    );
    assert.equal(
      deletes.some((path) => path.includes("/hooks/")),
      true,
    );
    assert.equal((await directory.findRepositoryHook(CONNECTION_ID, 1))?.status, "unconfigured");
  });
});

function seededDirectory(): ForgejoDirectory {
  return createMemoryForgejoDirectory({
    instances: [activeInstance()],
  });
}

function activeInstance() {
  return {
    id: INSTANCE_ID,
    canonicalOrigin: "https://forgejo.example.test",
    allowPrivateNetwork: false,
    externalIdentity: {
      kind: "forgejo",
      version: "16.0.3+gitea-1.22.0",
      fingerprint: "",
      uid: null,
      capabilities: { maxResponseItems: 50, defaultPagingNum: 30 },
    },
    reportedVersion: "16.0.3+gitea-1.22.0",
    status: "active" as const,
    approvedByUserId: "operator-1",
    approvedAt: START,
    lastHealthAt: START,
    lastHealthError: null,
    createdAt: START,
    updatedAt: START,
  };
}

async function seedConnection(
  directory: ForgejoDirectory,
  secrets: SecretEncryptionKeySource,
  options: { disconnected?: boolean; cleanupFailed?: boolean } = {},
): Promise<void> {
  await directory.insertConnection({
    id: CONNECTION_ID,
    organizationId: ORGANIZATION_ID,
    instanceId: INSTANCE_ID,
    slug: "forgejo",
    status: options.disconnected === true ? "disconnected" : "active",
    forgejoUserId: 7,
    forgejoUserLogin: "forgejo-user",
    providerApplicationId: null,
  });
  const id = "33333333-3333-4333-8333-333333333333";
  const envelope = encryptSecret(secrets, {
    plaintext: "connection-pat-test-only",
    organizationId: ORGANIZATION_ID,
    credentialId: id,
    kind: "connection",
  });
  await directory.insertCredential({
    id,
    organizationId: ORGANIZATION_ID,
    connectionId: CONNECTION_ID,
    kind: "connection",
    alg: envelope.alg,
    keyId: envelope.keyId,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    aadVersion: envelope.aadVersion,
    scopeEvidence: { scopes: ["read:issue"], repositoryIds: [1] },
    status: options.disconnected === true ? "revoked" : "active",
  });
  await directory.upsertRepository({
    id: "repository-1",
    organizationId: ORGANIZATION_ID,
    connectionId: CONNECTION_ID,
    repositoryId: 1,
    fullName: "owner/repository-1",
    ownerLogin: "owner",
    name: "repository-1",
    defaultBranch: "main",
    htmlUrl: "https://forgejo.example.test/owner/repository-1",
    enrolled: true,
  });
  if (options.cleanupFailed === true) {
    await directory.upsertRepositoryHook({
      id: "hook-1",
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
      repositoryId: 1,
      forgejoHookId: 88,
      callbackPath: `/api/integrations/forgejo/webhook/${CONNECTION_ID}`,
      managed: true,
      status: "cleanup_failed",
      lastVerifiedAt: START,
    });
  }
}

function fakeClock() {
  let current = START.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function fixtureHttp(
  fixtures: Awaited<ReturnType<typeof loadForgejoContractFixtures>>,
  options: { beforeVersion?: () => Response | undefined } = {},
): ForgejoHttp {
  const capability = record(fixtures.hydration["apiCapability"], "apiCapability");
  const version = record(field(capability, "version"), "version");
  const settings = record(field(capability, "settings"), "settings");
  return {
    resolver: { resolve: async () => ["203.0.113.10"] },
    fetch: async (input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/v1/version") {
        const blocked = options.beforeVersion?.();
        if (blocked !== undefined) return blocked;
        return Response.json(version);
      }
      if (url.pathname === "/api/v1/settings/api") return Response.json(settings);
      if (url.pathname.startsWith("/api/v1/repos/")) {
        return Response.json({ id: 1, full_name: "owner/repository-1" });
      }
      throw new Error(`unexpected Forgejo path ${url.pathname}`);
    },
  };
}

function unreachableHttp(): ForgejoHttp {
  return {
    resolver: { resolve: async () => ["203.0.113.10"] },
    fetch: async () => new Response("no", { status: 503 }),
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  throw new Error("unsupported fetch input");
}

function testSecrets(): SecretEncryptionKeySource {
  const current = { keyId: 1, key: Buffer.alloc(32, 7) };
  return {
    current: () => current,
    byId: (id) => (id === current.keyId ? current : undefined),
  };
}
