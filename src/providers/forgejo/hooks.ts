import { randomBytes, randomUUID } from "node:crypto";
import {
  ApprovedOriginError,
  assertResolvedAddressesAllowed,
  rejectRedirectStatus,
  type CanonicalHttpsOrigin,
} from "../../http/approved-origin.js";
import type { ForgejoRepositoryHookRecord, ForgejoRepositoryRecord } from "../../db/types.js";
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import {
  handleForgejoIngress,
  type AcceptVerifiedForgejoDelivery,
} from "../../triggers/forgejo/webhook.js";
import {
  ForgejoContractError,
  forgejoErrorResponse,
  originFromInstance,
  readJsonObject,
  requireOrganizationOwner,
  type ForgejoAccessResolver,
  type ForgejoDirectory,
  type ForgejoHttp,
  type ForgejoWebhookSecretRecord,
} from "./instances.js";

export const FORGEJO_HOOK_EVENTS = [
  "push",
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
] as const;

export const FORGEJO_WEBHOOK_CALLBACK_PREFIX = "/api/integrations/forgejo/webhook";

export function forgejoWebhookCallbackPath(connectionId: string): string {
  return `${FORGEJO_WEBHOOK_CALLBACK_PREFIX}/${connectionId}`;
}

export function forgejoWebhookCallbackUrl(baseUrl: string, connectionId: string): string {
  return `${trimTrailingSlash(baseUrl)}${forgejoWebhookCallbackPath(connectionId)}`;
}

export async function handleForgejoWebhookRequest(
  request: Request,
  options: {
    access: ForgejoAccessResolver;
    directory: ForgejoDirectory;
    http: ForgejoHttp;
    secrets: SecretEncryptionKeySource;
    applicationBaseUrl: string;
    publicBaseUrl?: string;
    accept?: AcceptVerifiedForgejoDelivery;
  },
): Promise<Response> {
  const url = new URL(request.url);
  const ingress = /^\/webhook\/([^/]+)$/u.exec(url.pathname);
  if (ingress !== null && ingress[1] !== undefined) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    return handleForgejoIngress(request, ingress[1], {
      directory: options.directory,
      secrets: options.secrets,
      ...(options.accept === undefined ? {} : { accept: options.accept }),
    });
  }
  try {
    const access = await options.access.resolve(request);
    const organizationId = requireOrganizationOwner(access);
    const listed = /^\/connections\/([^/]+)\/hooks$/u.exec(url.pathname);
    if (listed === null || listed[1] === undefined) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const connectionId = listed[1];
    if (request.method === "GET") {
      return Response.json(
        await describeHooks({
          directory: options.directory,
          secrets: options.secrets,
          organizationId,
          connectionId,
          baseUrl: options.publicBaseUrl ?? options.applicationBaseUrl,
        }),
      );
    }
    if (request.method === "POST") {
      const body = await readJsonObject(request);
      const mode = body["mode"];
      if (mode === "manual") {
        return Response.json(
          await setupManualHooks({
            directory: options.directory,
            secrets: options.secrets,
            organizationId,
            connectionId,
            baseUrl: options.publicBaseUrl ?? options.applicationBaseUrl,
          }),
        );
      }
      if (mode === "automatic") {
        const adminPat = readAdminPat(body);
        return Response.json(
          await setupAutomaticHooks({
            directory: options.directory,
            http: options.http,
            secrets: options.secrets,
            organizationId,
            connectionId,
            adminPat,
            baseUrl: options.publicBaseUrl ?? options.applicationBaseUrl,
          }),
        );
      }
      throw new ForgejoContractError("forgejo_scope_invalid", 400, "hook setup mode is required");
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return forgejoErrorResponse(error);
  }
}

async function describeHooks(input: {
  directory: ForgejoDirectory;
  secrets: SecretEncryptionKeySource;
  organizationId: string;
  connectionId: string;
  baseUrl: string;
}): Promise<HookSetupView> {
  const connection = await requireOwnedConnection(input);
  const secret = await input.directory.findActiveWebhookSecret(connection.id);
  const hooks = await input.directory.listRepositoryHooksForConnection(connection.id);
  const repositories = await enrolledRepositories(input.directory, connection.id);
  return publicHookView({
    connectionId: connection.id,
    baseUrl: input.baseUrl,
    secret,
    hooks,
    repositories,
    plaintextSecret: undefined,
  });
}

async function setupManualHooks(input: {
  directory: ForgejoDirectory;
  secrets: SecretEncryptionKeySource;
  organizationId: string;
  connectionId: string;
  baseUrl: string;
}): Promise<HookSetupView> {
  const connection = await requireOwnedConnection(input);
  const ensured = await ensureWebhookSecret(input, connection.id, connection.organizationId);
  const callbackPath = forgejoWebhookCallbackPath(connection.id);
  const repositories = await enrolledRepositories(input.directory, connection.id);
  if (repositories.length === 0) {
    throw new ForgejoContractError(
      "forgejo_scope_invalid",
      400,
      "enroll repositories before hooks",
    );
  }
  const hooks: ForgejoRepositoryHookRecord[] = [];
  for (const repository of repositories) {
    hooks.push(
      await persistHook(input.directory, {
        organizationId: connection.organizationId,
        connectionId: connection.id,
        repositoryId: repository.repositoryId,
        forgejoHookId: null,
        callbackPath,
        managed: false,
        status: "manual_pending",
        lastVerifiedAt: null,
      }),
    );
  }
  return publicHookView({
    connectionId: connection.id,
    baseUrl: input.baseUrl,
    secret: ensured.record,
    hooks,
    repositories,
    plaintextSecret: ensured.plaintext,
  });
}

async function setupAutomaticHooks(input: {
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
  organizationId: string;
  connectionId: string;
  adminPat: string;
  baseUrl: string;
}): Promise<HookSetupView> {
  let adminPat: string | undefined = input.adminPat;
  try {
    const token = adminPat;
    if (token === undefined) {
      throw new ForgejoContractError("forgejo_scope_invalid", 400, "webhook-admin PAT is invalid");
    }
    const connection = await requireOwnedConnection(input);
    const instance = await input.directory.findInstanceById(connection.instanceId);
    if (instance === undefined) {
      throw new ForgejoContractError("not_found", 404, "Forgejo instance was not found");
    }
    const origin = originFromInstance(instance);
    const ensured = await ensureWebhookSecret(input, connection.id, connection.organizationId);
    const plaintextSecret = await webhookSecretPlaintext(
      input.secrets,
      ensured.record,
      ensured.plaintext,
    );
    const callbackPath = forgejoWebhookCallbackPath(connection.id);
    const callbackUrl = forgejoWebhookCallbackUrl(input.baseUrl, connection.id);
    const repositories = await enrolledRepositories(input.directory, connection.id);
    if (repositories.length === 0) {
      throw new ForgejoContractError(
        "forgejo_scope_invalid",
        400,
        "enroll repositories before hooks",
      );
    }
    const hooks: ForgejoRepositoryHookRecord[] = [];
    for (const repository of repositories) {
      const remote = await reconcileRemoteHook({
        http: input.http,
        origin,
        token,
        owner: repository.ownerLogin,
        repo: repository.name,
        callbackUrl,
        secret: plaintextSecret,
      });
      const verified = await testRemoteHook({
        http: input.http,
        origin,
        token,
        owner: repository.ownerLogin,
        repo: repository.name,
        hookId: remote.id,
      });
      hooks.push(
        await persistHook(input.directory, {
          organizationId: connection.organizationId,
          connectionId: connection.id,
          repositoryId: repository.repositoryId,
          forgejoHookId: remote.id,
          callbackPath,
          managed: true,
          status: verified ? "active" : "pending_verification",
          lastVerifiedAt: verified ? new Date() : null,
        }),
      );
    }
    return publicHookView({
      connectionId: connection.id,
      baseUrl: input.baseUrl,
      secret: ensured.record,
      hooks,
      repositories,
      plaintextSecret: ensured.plaintext,
    });
  } finally {
    adminPat = undefined;
  }
}

async function reconcileRemoteHook(input: {
  http: ForgejoHttp;
  origin: CanonicalHttpsOrigin;
  token: string;
  owner: string;
  repo: string;
  callbackUrl: string;
  secret: string;
}): Promise<{ id: number }> {
  const existing = await listRemoteHooks(input);
  const current = existing.find((hook) => hook.url === input.callbackUrl);
  const payload = {
    type: "forgejo",
    config: {
      url: input.callbackUrl,
      content_type: "json",
      secret: input.secret,
    },
    events: [...FORGEJO_HOOK_EVENTS],
    active: true,
  };
  if (current === undefined) {
    const created = await forgejoHookJson(
      input.http,
      input.origin,
      `/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/hooks`,
      input.token,
      { method: "POST", body: JSON.stringify(payload) },
    );
    return { id: readHookId(created) };
  }
  await forgejoHookJson(
    input.http,
    input.origin,
    `/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/hooks/${String(current.id)}`,
    input.token,
    { method: "PATCH", body: JSON.stringify(payload) },
  );
  return { id: current.id };
}

async function testRemoteHook(input: {
  http: ForgejoHttp;
  origin: CanonicalHttpsOrigin;
  token: string;
  owner: string;
  repo: string;
  hookId: number;
}): Promise<boolean> {
  const response = await forgejoHookRequest(
    input.http,
    input.origin,
    `/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/hooks/${String(input.hookId)}/tests`,
    input.token,
    { method: "POST" },
  );
  return response.status === 204;
}

async function listRemoteHooks(input: {
  http: ForgejoHttp;
  origin: CanonicalHttpsOrigin;
  token: string;
  owner: string;
  repo: string;
}): Promise<{ id: number; url: string }[]> {
  const body = await forgejoHookJson(
    input.http,
    input.origin,
    `/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/hooks`,
    input.token,
  );
  if (!Array.isArray(body)) return [];
  const items: unknown[] = [];
  for (const item of body) items.push(item);
  const hooks: { id: number; url: string }[] = [];
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) row[key] = value;
    const id = row["id"];
    const configValue = row["config"];
    const url =
      typeof configValue === "object" && configValue !== null && !Array.isArray(configValue)
        ? objectField(configValue, "url")
        : undefined;
    if (typeof id === "number" && Number.isInteger(id) && typeof url === "string") {
      hooks.push({ id, url });
    }
  }
  return hooks;
}

function objectField(value: object, key: string): unknown {
  const row: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) row[entryKey] = entryValue;
  return row[key];
}

async function forgejoHookJson(
  http: ForgejoHttp,
  origin: CanonicalHttpsOrigin,
  path: string,
  token: string,
  init: { method?: string; body?: string } = {},
): Promise<unknown> {
  const response = await forgejoHookRequest(http, origin, path, token, init);
  if (response.status === 204) return undefined;
  return response.json();
}

async function forgejoHookRequest(
  http: ForgejoHttp,
  origin: CanonicalHttpsOrigin,
  path: string,
  token: string,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  try {
    await assertResolvedAddressesAllowed(origin, http.resolver);
  } catch (error) {
    if (error instanceof ApprovedOriginError) {
      throw new ForgejoContractError("forgejo_origin_unapproved", 400, error.message);
    }
    throw error;
  }
  const headers = new Headers({ accept: "application/json" });
  headers.set("authorization", `token ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await http.fetch(new URL(path, `${origin.origin}/`).toString(), {
    method: init.method ?? "GET",
    headers,
    redirect: "manual",
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  try {
    rejectRedirectStatus(response.status);
  } catch (error) {
    if (error instanceof ApprovedOriginError) {
      throw new ForgejoContractError("forgejo_origin_unapproved", 400, error.message);
    }
    throw error;
  }
  if (response.status === 401 || response.status === 403) {
    throw new ForgejoContractError(
      "forgejo_identity_mismatch",
      response.status,
      "Forgejo rejected the credential",
    );
  }
  if (response.status !== 204 && (response.status < 200 || response.status >= 300)) {
    throw new ForgejoContractError(
      "forgejo_origin_unapproved",
      502,
      "Forgejo API was not reachable",
    );
  }
  return response;
}

async function ensureWebhookSecret(
  input: { directory: ForgejoDirectory; secrets: SecretEncryptionKeySource },
  connectionId: string,
  organizationId: string,
): Promise<{ record: ForgejoWebhookSecretRecord; plaintext: string | undefined }> {
  const existing = await input.directory.findActiveWebhookSecret(connectionId);
  if (existing !== undefined) return { record: existing, plaintext: undefined };
  const id = randomUUID();
  const plaintext = randomBytes(32).toString("hex");
  const envelope = encryptSecret(input.secrets, {
    plaintext,
    organizationId,
    credentialId: id,
    kind: "webhook_secret",
  });
  const record: ForgejoWebhookSecretRecord = {
    id,
    organizationId,
    connectionId,
    kind: "webhook_secret",
    alg: envelope.alg,
    keyId: envelope.keyId,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    aadVersion: envelope.aadVersion,
    status: "active",
  };
  await input.directory.insertWebhookSecret(record);
  return { record, plaintext };
}

async function webhookSecretPlaintext(
  secrets: SecretEncryptionKeySource,
  record: ForgejoWebhookSecretRecord,
  generated: string | undefined,
): Promise<string> {
  if (generated !== undefined) return generated;
  return decryptSecret(
    secrets,
    {
      alg: "aes-256-gcm",
      keyId: record.keyId,
      nonce: record.nonce,
      ciphertext: record.ciphertext,
      aadVersion: 1,
    },
    {
      organizationId: record.organizationId,
      credentialId: record.id,
      kind: "webhook_secret",
    },
  );
}

async function persistHook(
  directory: ForgejoDirectory,
  record: Omit<ForgejoRepositoryHookRecord, "id"> & { id?: string },
): Promise<ForgejoRepositoryHookRecord> {
  const existing = await directory.findRepositoryHook(record.connectionId, record.repositoryId);
  const stored: ForgejoRepositoryHookRecord = {
    id: existing?.id ?? record.id ?? randomUUID(),
    organizationId: record.organizationId,
    connectionId: record.connectionId,
    repositoryId: record.repositoryId,
    forgejoHookId: record.forgejoHookId,
    callbackPath: record.callbackPath,
    managed: record.managed,
    status: record.status,
    lastVerifiedAt: record.lastVerifiedAt,
  };
  await directory.upsertRepositoryHook(stored);
  return stored;
}

async function requireOwnedConnection(input: {
  directory: ForgejoDirectory;
  organizationId: string;
  connectionId: string;
}) {
  const connection = await input.directory.findConnectionById(input.connectionId);
  if (connection === undefined || connection.organizationId !== input.organizationId) {
    throw new ForgejoContractError("not_found", 404, "Forgejo connection was not found");
  }
  if (connection.status === "disconnected") {
    throw new ForgejoContractError("forbidden", 403, "Forgejo connection is disconnected");
  }
  return connection;
}

async function enrolledRepositories(
  directory: ForgejoDirectory,
  connectionId: string,
): Promise<ForgejoRepositoryRecord[]> {
  return (await directory.listRepositoriesForConnection(connectionId)).filter(
    (row) => row.enrolled,
  );
}

function publicHookView(input: {
  connectionId: string;
  baseUrl: string;
  secret: ForgejoWebhookSecretRecord | undefined;
  hooks: readonly ForgejoRepositoryHookRecord[];
  repositories: readonly ForgejoRepositoryRecord[];
  plaintextSecret: string | undefined;
}): HookSetupView {
  const byRepository = new Map(input.hooks.map((hook) => [hook.repositoryId, hook]));
  return {
    connectionId: input.connectionId,
    callbackUrl: forgejoWebhookCallbackUrl(input.baseUrl, input.connectionId),
    events: [...FORGEJO_HOOK_EVENTS],
    credential: {
      kind: "webhook_secret",
      secret: input.plaintextSecret ?? maskSecret(),
    },
    hooks: input.repositories.map((repository) => {
      const hook = byRepository.get(repository.repositoryId);
      return {
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        htmlUrl: repository.htmlUrl,
        managed: hook?.managed ?? false,
        status: hook?.status ?? "unconfigured",
      };
    }),
  };
}

function readAdminPat(body: Record<string, unknown>): string {
  const value = body["adminPat"];
  if (typeof value !== "string" || value.trim().length === 0 || /\s/u.test(value)) {
    throw new ForgejoContractError("forgejo_scope_invalid", 400, "webhook-admin PAT is invalid");
  }
  return value;
}

function readHookId(body: unknown): number {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ForgejoContractError(
      "forgejo_origin_unapproved",
      502,
      "Forgejo API was not reachable",
    );
  }
  const id = objectField(body, "id");
  if (typeof id !== "number" || !Number.isInteger(id)) {
    throw new ForgejoContractError(
      "forgejo_origin_unapproved",
      502,
      "Forgejo API was not reachable",
    );
  }
  return id;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

interface HookSetupView {
  connectionId: string;
  callbackUrl: string;
  events: string[];
  credential: { kind: "webhook_secret"; secret: string };
  hooks: {
    repositoryId: number;
    fullName: string;
    htmlUrl: string;
    managed: boolean;
    status: ForgejoRepositoryHookRecord["status"];
  }[];
}
