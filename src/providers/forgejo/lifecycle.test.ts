import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "vitest";
import type {
  ForgejoConnectionRecord,
  ForgejoInstanceRecord,
  ForgejoRepositoryHookRecord,
  ForgejoRepositoryRecord,
} from "../../db/types.js";
import {
  decryptSecret,
  encryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import { handleForgejoIngress } from "../../triggers/forgejo/webhook.js";
import { handleForgejoConnectionsRequest } from "./connections.js";
import {
  createMemoryForgejoDirectory,
  ForgejoContractError,
  type ForgejoCredentialRecord,
  type ForgejoDirectory,
  type ForgejoHttp,
  type ForgejoWebhookSecretRecord,
} from "./instances.js";
import {
  createForgejoLifecycle,
  type ForgejoLifecycle,
  type ForgejoLifecycleImpactSource,
} from "./lifecycle.js";

const ORGANIZATION_ID = "org-1";
const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const INSTANCE_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-31T12:00:00.000Z");
const CONNECTION_PAT = "connection-pat-test-only";
const ROTATED_CONNECTION_PAT = "connection-pat-rotated-test-only";
const EXECUTION_PAT = "execution-pat-test-only";
const WEBHOOK_SECRET = "webhook-secret-test-only";
const WEBHOOK_ADMIN_PAT = "webhook-admin-pat-test-only";

describe("Forgejo credential lifecycle", () => {
  it("rotates and revokes connection, execution, and webhook authority independently", async () => {
    const world = createLifecycleWorld();
    const rotatedConnection = await handleForgejoConnectionsRequest(
      jsonRequest(`https://hub.test/connections/${CONNECTION_ID}/credentials/connection/rotate`, {
        pat: ROTATED_CONNECTION_PAT,
        scopes: ["read:issue", "read:repository"],
        repositories: [1],
      }),
      connectionRequestOptions(world),
    );
    assert.equal(rotatedConnection.status, 200);
    const rotatedConnectionBody: unknown = await rotatedConnection.json();
    assert.equal(await activeConnectionPat(world), ROTATED_CONNECTION_PAT);
    assert.equal(await activeWebhookSecret(world), WEBHOOK_SECRET);
    assert.equal(await world.directory.findActiveExecutionCredential(CONNECTION_ID), undefined);
    assertNoSecretLeak(rotatedConnectionBody, [
      CONNECTION_PAT,
      ROTATED_CONNECTION_PAT,
      WEBHOOK_SECRET,
    ]);

    const configured = await handleForgejoConnectionsRequest(
      jsonRequest(`https://hub.test/connections/${CONNECTION_ID}/credentials/execution`, {
        pat: EXECUTION_PAT,
        scopes: ["read:issue", "read:repository"],
        repositories: ["owner/repository-1"],
      }),
      connectionRequestOptions(world),
    );
    assert.equal(configured.status, 200);
    const configuredBody: unknown = await configured.json();
    assertNoSecretLeak(configuredBody, [CONNECTION_PAT, ROTATED_CONNECTION_PAT, EXECUTION_PAT]);
    assert.equal(await activeExecutionPat(world), EXECUTION_PAT);
    assert.equal(await activeConnectionPat(world), ROTATED_CONNECTION_PAT);
    assert.equal(await activeWebhookSecret(world), WEBHOOK_SECRET);

    const revoked = await handleForgejoConnectionsRequest(
      jsonRequest(`https://hub.test/connections/${CONNECTION_ID}/credentials/execution/revoke`, {}),
      connectionRequestOptions(world),
    );
    assert.equal(revoked.status, 200);
    const revokedBody: unknown = await revoked.json();
    assertNoSecretLeak(revokedBody, [CONNECTION_PAT, ROTATED_CONNECTION_PAT, EXECUTION_PAT]);
    assert.equal(await world.directory.findActiveExecutionCredential(CONNECTION_ID), undefined);
    assert.equal(await activeConnectionPat(world), ROTATED_CONNECTION_PAT);
    assert.equal(await activeWebhookSecret(world), WEBHOOK_SECRET);

    const rotatedWebhook = await handleForgejoConnectionsRequest(
      jsonRequest(
        `https://hub.test/connections/${CONNECTION_ID}/credentials/webhook_secret/rotate`,
        {
          webhookAdminPat: WEBHOOK_ADMIN_PAT,
        },
      ),
      connectionRequestOptions(world),
    );
    assert.equal(rotatedWebhook.status, 200);
    const rotatedWebhookBody: unknown = await rotatedWebhook.json();
    const nextWebhookSecret = await activeWebhookSecret(world);
    assert.notEqual(nextWebhookSecret, WEBHOOK_SECRET);
    assert.equal(await activeConnectionPat(world), ROTATED_CONNECTION_PAT);
    assert.equal(await world.directory.findActiveExecutionCredential(CONNECTION_ID), undefined);
    assertNoSecretLeak(rotatedWebhookBody, [
      CONNECTION_PAT,
      ROTATED_CONNECTION_PAT,
      EXECUTION_PAT,
      WEBHOOK_ADMIN_PAT,
      WEBHOOK_SECRET,
      nextWebhookSecret,
    ]);

    const revokedConnection = await handleForgejoConnectionsRequest(
      jsonRequest(
        `https://hub.test/connections/${CONNECTION_ID}/credentials/connection/revoke`,
        {},
      ),
      connectionRequestOptions(world),
    );
    assert.equal(revokedConnection.status, 200);
    const revokedConnectionBody: unknown = await revokedConnection.json();
    assert.equal(await world.directory.findActiveConnectionCredential(CONNECTION_ID), undefined);
    assert.equal(await activeWebhookSecret(world), nextWebhookSecret);
    assertNoSecretLeak(revokedConnectionBody, [
      CONNECTION_PAT,
      ROTATED_CONNECTION_PAT,
      EXECUTION_PAT,
      WEBHOOK_SECRET,
      nextWebhookSecret,
    ]);
  });

  it("fails closed when a credential is missing, revoked, or outside the enrolled boundary", async () => {
    const withoutConnectionCredential = createLifecycleWorld({
      includeConnectionCredential: false,
    });
    await assert.rejects(
      () =>
        withoutConnectionCredential.lifecycle.rotateConnectionCredential({
          organizationId: ORGANIZATION_ID,
          connectionId: CONNECTION_ID,
          pat: ROTATED_CONNECTION_PAT,
          scopes: ["read:issue", "read:repository"],
          repositoryIds: [1],
        }),
      hasForgejoCode("forgejo_credential_unavailable"),
    );

    const withoutWebhookSecret = createLifecycleWorld({ includeWebhookSecret: false });
    await assert.rejects(
      () =>
        withoutWebhookSecret.lifecycle.rotateWebhookSecret({
          organizationId: ORGANIZATION_ID,
          connectionId: CONNECTION_ID,
          webhookAdminPat: WEBHOOK_ADMIN_PAT,
        }),
      hasForgejoCode("forgejo_credential_unavailable"),
    );

    const unavailableInstance = createLifecycleWorld();
    const instance = await unavailableInstance.directory.findInstanceById(INSTANCE_ID);
    if (instance === undefined) throw new Error("Forgejo instance is missing");
    await unavailableInstance.directory.updateInstance({ ...instance, status: "unreachable" });
    await assert.rejects(
      () =>
        unavailableInstance.lifecycle.rotateWebhookSecret({
          organizationId: ORGANIZATION_ID,
          connectionId: CONNECTION_ID,
          webhookAdminPat: WEBHOOK_ADMIN_PAT,
        }),
      hasForgejoCode("forgejo_origin_unapproved"),
    );
    assert.deepEqual(
      (await unavailableInstance.directory.listWebhookSecretsForConnection(CONNECTION_ID)).map(
        (secret) => secret.status,
      ),
      ["active"],
    );

    const world = createLifecycleWorld();
    await assert.rejects(
      () =>
        world.lifecycle.configureExecutionCredential({
          organizationId: ORGANIZATION_ID,
          connectionId: CONNECTION_ID,
          pat: EXECUTION_PAT,
          scopes: ["read:issue", "read:repository"],
          repositories: ["owner/not-enrolled"],
        }),
      hasForgejoCode("forgejo_scope_invalid"),
    );
    await assert.rejects(
      () =>
        world.lifecycle.revokeExecutionCredential({
          organizationId: ORGANIZATION_ID,
          connectionId: CONNECTION_ID,
        }),
      hasForgejoCode("forgejo_credential_unavailable"),
    );

    await world.lifecycle.disconnect({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
    });
    await assert.rejects(
      () =>
        world.lifecycle.configureExecutionCredential({
          organizationId: ORGANIZATION_ID,
          connectionId: CONNECTION_ID,
          pat: EXECUTION_PAT,
          scopes: ["read:issue", "read:repository"],
          repositories: ["owner/repository-1"],
        }),
      hasForgejoCode("forgejo_credential_unavailable"),
    );
  });

  it("accepts active and rotating webhook secrets during overlap, then cuts over", async () => {
    const world = createLifecycleWorld({ hookVerificationSucceeds: false });
    const overlap = await world.lifecycle.rotateWebhookSecret({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
      webhookAdminPat: WEBHOOK_ADMIN_PAT,
    });
    assert.equal(overlap.cutover, "pending");
    const nextWebhookSecret = await activeWebhookSecret(world);
    assert.notEqual(nextWebhookSecret, WEBHOOK_SECRET);
    assert.equal(await ingressStatus(world, WEBHOOK_SECRET), 200);
    assert.equal(await ingressStatus(world, nextWebhookSecret), 200);

    world.remote.hookVerificationSucceeds = true;
    const cutover = await world.lifecycle.rotateWebhookSecret({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
      webhookAdminPat: WEBHOOK_ADMIN_PAT,
    });
    assert.equal(cutover.cutover, "complete");
    assert.equal(await ingressStatus(world, WEBHOOK_SECRET), 401);
    assert.equal(await ingressStatus(world, nextWebhookSecret), 200);
    const states = await world.directory.listWebhookSecretsForConnection(CONNECTION_ID);
    assert.equal(states.filter((state) => state.status === "active").length, 1);
    assert.equal(states.filter((state) => state.status === "rotating").length, 0);
    assert.equal(states.filter((state) => state.status === "revoked").length, 1);
  });

  it("projects deterministic impact and retains retryable cleanup when Forgejo is unavailable", async () => {
    const impactSource: ForgejoLifecycleImpactSource = {
      async describe() {
        return {
          configurationSources: [
            { projectId: "project-a", repositoryId: 2, activeRevisionId: "revision-a" },
          ],
          activeRevisions: [{ projectId: "project-a", revisionId: "revision-a" }],
          triggerRoutes: [
            { projectId: "project-a", repositoryId: 2, configurationRevisionId: "revision-a" },
            { projectId: "project-b", repositoryId: 7, configurationRevisionId: "revision-b" },
          ],
          work: {
            queued: [
              {
                projectId: "project-a",
                configurationRevisionId: "revision-a",
                triggerRunId: "trigger-a",
                stepRunId: "step-queued",
              },
            ],
            inFlight: [
              {
                projectId: "project-b",
                configurationRevisionId: "revision-b",
                triggerRunId: "trigger-b",
                stepRunId: "step-running",
              },
            ],
            queuedEffect: "revalidates_before_execution",
            inFlightEffect: "already_minted_authority_is_not_recalled",
          },
        };
      },
    };
    const world = createLifecycleWorld({
      repositoryIds: [2, 7, 9],
      manualRepositoryIds: [9],
      impactSource,
    });
    await world.lifecycle.configureExecutionCredential({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
      pat: EXECUTION_PAT,
      scopes: ["read:issue", "read:repository"],
      repositories: ["owner/repository-2", "owner/repository-7", "owner/repository-9"],
    });
    const repositoriesBeforeDisconnect =
      await world.directory.listRepositoriesForConnection(CONNECTION_ID);
    const impact = await world.lifecycle.previewDisconnect({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
    });
    assert.deepEqual(
      impact.repositories.map((repository) => repository.repositoryId),
      [2, 7, 9],
    );
    assert.deepEqual(
      impact.hooks.map((hook) => ({ repositoryId: hook.repositoryId, managed: hook.managed })),
      [
        { repositoryId: 2, managed: true },
        { repositoryId: 7, managed: true },
        { repositoryId: 9, managed: false },
      ],
    );
    assert.deepEqual(impact.configurationSources, [
      { projectId: "project-a", repositoryId: 2, activeRevisionId: "revision-a" },
    ]);
    assert.deepEqual(impact.activeRevisions, [
      { projectId: "project-a", revisionId: "revision-a" },
    ]);
    assert.equal(impact.triggerRoutes.length, 2);
    assert.deepEqual(
      impact.hydrationSignals.map((signal) => signal.repositoryId),
      [2, 7, 9],
    );
    assert.equal(impact.work.queued[0]?.stepRunId, "step-queued");
    assert.equal(impact.work.inFlight[0]?.stepRunId, "step-running");
    assert.equal(impact.futureExecution, "blocked");

    world.remote.failedDeleteRepositories.add(7);
    const firstDisconnect = await world.lifecycle.disconnect({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
      webhookAdminPat: WEBHOOK_ADMIN_PAT,
    });
    assert.equal(firstDisconnect.cleanupStatus, "REMOTE_CLEANUP_PENDING");
    assert.deepEqual(firstDisconnect.cleanup, [
      { repositoryId: 2, fullName: "owner/repository-2", managed: true, result: "removed" },
      { repositoryId: 7, fullName: "owner/repository-7", managed: true, result: "pending" },
      {
        repositoryId: 9,
        fullName: "owner/repository-9",
        managed: false,
        result: "preserved_manual",
      },
    ]);
    assert.equal((await world.directory.findConnectionById(CONNECTION_ID))?.status, "disconnected");
    assert.equal(
      (await world.directory.listCredentialStatesForConnection(CONNECTION_ID)).every(
        (state) => state.status === "revoked",
      ),
      true,
    );
    assert.deepEqual(
      await world.directory.listRepositoriesForConnection(CONNECTION_ID),
      repositoriesBeforeDisconnect,
    );
    assert.equal(
      (await world.directory.findRepositoryHook(CONNECTION_ID, 2))?.status,
      "unconfigured",
    );
    assert.equal(
      (await world.directory.findRepositoryHook(CONNECTION_ID, 7))?.status,
      "cleanup_failed",
    );
    assert.equal(
      (await world.directory.findRepositoryHook(CONNECTION_ID, 9))?.status,
      "manual_pending",
    );
    assert.deepEqual(deleteRepositoryIds(world.remote.calls), [2, 7]);

    world.remote.failedDeleteRepositories.clear();
    const deletesBeforeRetry = world.remote.calls.filter((call) => call.method === "DELETE").length;
    const retry = await world.lifecycle.disconnect({
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
      webhookAdminPat: WEBHOOK_ADMIN_PAT,
    });
    assert.equal(retry.cleanupStatus, "complete");
    assert.deepEqual(
      retry.cleanup.map((entry) => entry.result),
      ["removed", "removed", "preserved_manual"],
    );
    assert.deepEqual(deleteRepositoryIds(world.remote.calls.slice(deletesBeforeRetry)), [7]);
    assert.equal(
      (await world.directory.findRepositoryHook(CONNECTION_ID, 7))?.status,
      "unconfigured",
    );
  });
});

interface LifecycleWorld {
  directory: ForgejoDirectory;
  lifecycle: ForgejoLifecycle;
  secrets: SecretEncryptionKeySource;
  remote: RemoteState;
}

interface RemoteCall {
  method: string;
  pathname: string;
}

interface RemoteState {
  calls: RemoteCall[];
  failedDeleteRepositories: Set<number>;
  hookVerificationSucceeds: boolean;
}

function createLifecycleWorld(
  input: {
    repositoryIds?: readonly number[];
    manualRepositoryIds?: readonly number[];
    includeConnectionCredential?: boolean;
    includeWebhookSecret?: boolean;
    hookVerificationSucceeds?: boolean;
    impactSource?: ForgejoLifecycleImpactSource;
  } = {},
): LifecycleWorld {
  const repositoryIds = input.repositoryIds ?? [1];
  const manualRepositoryIds = new Set(input.manualRepositoryIds ?? []);
  const secrets = testSecrets();
  const connection: ForgejoConnectionRecord = {
    id: CONNECTION_ID,
    organizationId: ORGANIZATION_ID,
    instanceId: INSTANCE_ID,
    slug: "forgejo",
    status: "active",
    forgejoUserId: 7,
    forgejoUserLogin: "forgejo-user",
    providerApplicationId: null,
  };
  const instance: ForgejoInstanceRecord = {
    id: INSTANCE_ID,
    canonicalOrigin: "https://forgejo.example.test",
    allowPrivateNetwork: false,
    externalIdentity: { kind: "forgejo" },
    reportedVersion: "16.0.3",
    status: "active",
    approvedByUserId: "operator-1",
    approvedAt: NOW,
    lastHealthAt: NOW,
    lastHealthError: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const repositories: ForgejoRepositoryRecord[] = repositoryIds.map((repositoryId) => ({
    id: `repository-${String(repositoryId)}`,
    organizationId: ORGANIZATION_ID,
    connectionId: CONNECTION_ID,
    repositoryId,
    fullName: repositoryFullName(repositoryId),
    ownerLogin: "owner",
    name: `repository-${String(repositoryId)}`,
    defaultBranch: "main",
    htmlUrl: `https://forgejo.example.test/owner/repository-${String(repositoryId)}`,
    enrolled: true,
  }));
  const hooks: ForgejoRepositoryHookRecord[] = repositoryIds.map((repositoryId) => {
    const manual = manualRepositoryIds.has(repositoryId);
    return {
      id: `hook-${String(repositoryId)}`,
      organizationId: ORGANIZATION_ID,
      connectionId: CONNECTION_ID,
      repositoryId,
      forgejoHookId: manual ? null : remoteHookId(repositoryId),
      callbackPath: `/api/integrations/forgejo/webhook/${CONNECTION_ID}`,
      managed: !manual,
      status: manual ? "manual_pending" : "active",
      lastVerifiedAt: manual ? null : NOW,
    };
  });
  const credentials: ForgejoCredentialRecord[] = [];
  if (input.includeConnectionCredential !== false) {
    credentials.push(storedConnectionCredential(secrets, CONNECTION_PAT));
  }
  const webhookSecrets: ForgejoWebhookSecretRecord[] = [];
  if (input.includeWebhookSecret !== false) {
    webhookSecrets.push(storedWebhookSecret(secrets, WEBHOOK_SECRET));
  }
  const directory = createMemoryForgejoDirectory({
    instances: [instance],
    connections: [connection],
    credentials,
    repositories,
    webhookSecrets,
    hooks,
  });
  const remote: RemoteState = {
    calls: [],
    failedDeleteRepositories: new Set(),
    hookVerificationSucceeds: input.hookVerificationSucceeds ?? true,
  };
  const http = hookHttp(remote);
  return {
    directory,
    lifecycle: createForgejoLifecycle({
      directory,
      http,
      secrets,
      ...(input.impactSource === undefined ? {} : { impactSource: input.impactSource }),
      now: () => NOW,
    }),
    secrets,
    remote,
  };
}

function storedConnectionCredential(
  secrets: SecretEncryptionKeySource,
  plaintext: string,
): ForgejoCredentialRecord {
  const id = "33333333-3333-4333-8333-333333333333";
  const envelope = encryptSecret(secrets, {
    plaintext,
    organizationId: ORGANIZATION_ID,
    credentialId: id,
    kind: "connection",
  });
  return {
    id,
    organizationId: ORGANIZATION_ID,
    connectionId: CONNECTION_ID,
    kind: "connection",
    ...envelope,
    scopeEvidence: { scopes: ["read:issue", "read:repository"], repositoryIds: [1] },
    status: "active",
    createdAt: NOW,
    rotatedAt: null,
    revokedAt: null,
  };
}

function storedWebhookSecret(
  secrets: SecretEncryptionKeySource,
  plaintext: string,
): ForgejoWebhookSecretRecord {
  const id = "44444444-4444-4444-8444-444444444444";
  const envelope = encryptSecret(secrets, {
    plaintext,
    organizationId: ORGANIZATION_ID,
    credentialId: id,
    kind: "webhook_secret",
  });
  return {
    id,
    organizationId: ORGANIZATION_ID,
    connectionId: CONNECTION_ID,
    kind: "webhook_secret",
    ...envelope,
    status: "active",
    createdAt: NOW,
    rotatedAt: null,
    revokedAt: null,
  };
}

function hookHttp(remote: RemoteState): ForgejoHttp {
  return {
    resolver: { resolve: async () => ["203.0.113.10"] },
    fetch: async (input, init) => {
      const url = requestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      remote.calls.push({ method, pathname: url.pathname });
      if (url.pathname === "/api/v1/repos/search") {
        return new Response(
          JSON.stringify({
            ok: true,
            data: [
              {
                id: 1,
                owner: { login: "owner" },
                name: "repository-1",
                full_name: "owner/repository-1",
                default_branch: "main",
                html_url: "https://forgejo.example.test/owner/repository-1",
              },
            ],
          }),
          { headers: { "content-type": "application/json", "x-total-count": "1" } },
        );
      }
      if (url.pathname.includes("/collaborators/")) {
        return Response.json({
          permission: "admin",
          role_name: "owner",
          user: { id: 7, login: "forgejo-user" },
        });
      }
      const repositoryId = repositoryIdFromHookPath(url.pathname);
      if (repositoryId === undefined) return Response.json({ error: "not_found" }, { status: 404 });
      if (method === "GET") {
        return Response.json([
          {
            id: remoteHookId(repositoryId),
            config: {
              url: `https://hub.test/api/integrations/forgejo/webhook/${CONNECTION_ID}`,
            },
          },
        ]);
      }
      if (method === "PATCH") return Response.json({ id: remoteHookId(repositoryId) });
      if (method === "POST" && url.pathname.endsWith("/tests")) {
        return remote.hookVerificationSucceeds
          ? new Response(null, { status: 204 })
          : Response.json({ status: "pending" });
      }
      if (method === "DELETE") {
        return remote.failedDeleteRepositories.has(repositoryId)
          ? Response.json({ message: "unavailable" }, { status: 503 })
          : new Response(null, { status: 204 });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  };
}

function connectionRequestOptions(world: LifecycleWorld) {
  return {
    access: {
      resolve: async () => ({
        userId: "owner-1",
        isInstanceOperator: false,
        organizationId: ORGANIZATION_ID,
        organizationRole: "owner" as const,
      }),
    },
    directory: world.directory,
    http: hookHttp(world.remote),
    secrets: world.secrets,
    lifecycle: world.lifecycle,
  };
}

async function activeConnectionPat(world: LifecycleWorld): Promise<string> {
  const credential = await world.directory.findActiveConnectionCredential(CONNECTION_ID);
  if (credential === undefined) throw new Error("connection credential is missing");
  return decryptSecret(
    world.secrets,
    {
      alg: "aes-256-gcm",
      keyId: credential.keyId,
      nonce: credential.nonce,
      ciphertext: credential.ciphertext,
      aadVersion: 1,
    },
    {
      organizationId: credential.organizationId,
      credentialId: credential.id,
      kind: "connection",
    },
  );
}

async function activeExecutionPat(world: LifecycleWorld): Promise<string> {
  const credential = await world.directory.findActiveExecutionCredential(CONNECTION_ID);
  if (credential === undefined) throw new Error("execution credential is missing");
  return decryptSecret(world.secrets, credential.envelope, {
    organizationId: credential.organizationId,
    credentialId: credential.id,
    kind: "execution",
  });
}

async function activeWebhookSecret(world: LifecycleWorld): Promise<string> {
  const credential = await world.directory.findActiveWebhookSecret(CONNECTION_ID);
  if (credential === undefined) throw new Error("webhook secret is missing");
  return decryptSecret(
    world.secrets,
    {
      alg: "aes-256-gcm",
      keyId: credential.keyId,
      nonce: credential.nonce,
      ciphertext: credential.ciphertext,
      aadVersion: 1,
    },
    {
      organizationId: credential.organizationId,
      credentialId: credential.id,
      kind: "webhook_secret",
    },
  );
}

async function ingressStatus(world: LifecycleWorld, secret: string): Promise<number> {
  const body = JSON.stringify({ repository: { id: 1 } });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const response = await handleForgejoIngress(
    new Request(`https://hub.test/webhook/${CONNECTION_ID}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forgejo-delivery": "55555555-5555-4555-8555-555555555555",
        "x-forgejo-event": "issues",
        "x-forgejo-event-type": "issues",
        "x-forgejo-signature": signature,
      },
      body,
    }),
    CONNECTION_ID,
    {
      directory: world.directory,
      secrets: world.secrets,
      accept: async () => ({ status: "accepted" }),
      now: () => NOW,
    },
  );
  return response.status;
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  throw new Error("unsupported fetch input");
}

function repositoryIdFromHookPath(pathname: string): number | undefined {
  const match = /\/repository-(\d+)\/hooks/u.exec(pathname);
  if (match?.[1] === undefined) return undefined;
  const repositoryId = Number(match[1]);
  return Number.isInteger(repositoryId) ? repositoryId : undefined;
}

function remoteHookId(repositoryId: number): number {
  return 1_000 + repositoryId;
}

function repositoryFullName(repositoryId: number): string {
  return `owner/repository-${String(repositoryId)}`;
}

function deleteRepositoryIds(calls: readonly RemoteCall[]): number[] {
  const ids: number[] = [];
  for (const call of calls) {
    if (call.method !== "DELETE") continue;
    const repositoryId = repositoryIdFromHookPath(call.pathname);
    if (repositoryId !== undefined) ids.push(repositoryId);
  }
  return ids;
}

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function hasForgejoCode(code: ForgejoContractError["code"]) {
  return (error: unknown) => error instanceof ForgejoContractError && error.code === code;
}

function assertNoSecretLeak(value: unknown, values: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const secret of values) assert.equal(serialized.includes(secret), false);
}

function testSecrets(): SecretEncryptionKeySource {
  const current = { keyId: 1, key: Buffer.alloc(32, 7) };
  return {
    current: () => current,
    byId: (id) => (id === current.keyId ? current : undefined),
  };
}
