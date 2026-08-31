import { randomUUID } from "node:crypto";
import type {
  ForgejoCollaboratorPermission,
  ForgejoConnectionClient,
  ForgejoRepositoryIdentity,
  ForgejoUserIdentity,
} from "./client.js";
import type {
  ForgejoConnectionRecord,
  ForgejoInstanceRecord,
  ForgejoRepositoryRecord,
} from "../../db/types.js";
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import {
  asJsonRecord,
  ForgejoContractError,
  FORGEJO_PAT_MASK,
  forgejoErrorResponse,
  forgejoJson,
  forgejoRequest,
  originFromInstance,
  publicInstance,
  readJsonObject,
  readString,
  requireOrganizationOwner,
  type ForgejoAccessResolver,
  type ForgejoDirectory,
  type ForgejoHttp,
} from "./instances.js";
import {
  enrollRepositories,
  listVisibleRepositories,
  persistVisibleRepositories,
  publicRepository,
} from "./repositories.js";
import { createForgejoLifecycle, type ForgejoLifecycle } from "./lifecycle.js";

export const ALLOWED_CONNECTION_SCOPES = [
  "read:issue",
  "write:issue",
  "read:repository",
  "write:repository",
] as const;

const FORBIDDEN_SCOPES = new Set(["read:user", "read:organization", "all"]);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type ConnectionScope = (typeof ALLOWED_CONNECTION_SCOPES)[number];

export interface CreateForgejoConnectionInput {
  instanceId: string;
  slug: string;
  claimedUsername: string;
  pat: string;
  scopes: readonly string[];
  limitedRepositoryIds: readonly number[] | "unscoped";
}

interface ForgejoConnectionsRequestOptions {
  access: ForgejoAccessResolver;
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
  onEnrolled?: (input: {
    connectionId: string;
    organizationId: string;
    repositories: ForgejoRepositoryRecord[];
  }) => Promise<void>;
  lifecycle?: ForgejoLifecycle;
  recovery?: {
    recoverCleanup: (input: {
      organizationId: string;
      connectionId: string;
      webhookAdminPat: string;
    }) => Promise<number>;
    healthForConnection: (connectionId: string) => Promise<
      readonly {
        workKind: string;
        status: string;
        typedCause: string | null;
        nextAttemptAt: string | null;
        remediation: string;
      }[]
    >;
  };
}

type ForgejoLifecycleRouteAction =
  | "impact"
  | "rotate_connection"
  | "revoke_connection"
  | "configure_execution"
  | "revoke_execution"
  | "rotate_webhook"
  | "disconnect";

export function maskForgejoPat(): typeof FORGEJO_PAT_MASK {
  return maskSecret();
}

export function validateConnectionCredential(input: {
  pat: string;
  scopes: readonly string[];
  limitedRepositoryIds: readonly number[] | "unscoped";
  oauth2?: boolean;
  password?: string;
}): { scopes: ConnectionScope[]; repositoryIds: readonly number[] } {
  if (input.oauth2 === true) {
    throw new ForgejoContractError("forgejo_scope_invalid", 400, "Forgejo OAuth2 is rejected");
  }
  if (input.password !== undefined) {
    throw new ForgejoContractError("forgejo_scope_invalid", 400, "Forgejo passwords are rejected");
  }
  if (input.pat.trim().length === 0 || /\s/u.test(input.pat)) {
    throw new ForgejoContractError("forgejo_scope_invalid", 400, "Forgejo PAT is invalid");
  }
  if (input.limitedRepositoryIds === "unscoped") {
    throw new ForgejoContractError(
      "forgejo_scope_invalid",
      400,
      "unscoped Forgejo tokens are rejected",
    );
  }
  for (const scope of input.scopes) {
    if (FORBIDDEN_SCOPES.has(scope) || !isAllowedScope(scope)) {
      throw new ForgejoContractError("forgejo_scope_invalid", 400, "Forgejo scope is invalid");
    }
  }
  const stored = storedScopes(input.scopes);
  if (!hasIssueScope(stored) || !hasRepositoryScope(stored)) {
    throw new ForgejoContractError("forgejo_scope_invalid", 400, "Forgejo scope is insufficient");
  }
  return { scopes: stored, repositoryIds: input.limitedRepositoryIds };
}

export async function bindForgejoIdentity(input: {
  http: ForgejoHttp;
  instance: ForgejoInstanceRecord;
  token: string;
  claimedUsername: string;
  repositories: readonly ForgejoRepositoryIdentity[];
}): Promise<ForgejoUserIdentity> {
  const repository = input.repositories[0];
  if (repository === undefined) {
    throw new ForgejoContractError(
      "forgejo_identity_mismatch",
      400,
      "no visible repository is available to bind identity",
    );
  }
  const origin = originFromInstance(input.instance);
  const path = `/api/v1/repos/${encodeURIComponent(repository.ownerLogin)}/${encodeURIComponent(repository.name)}/collaborators/${encodeURIComponent(input.claimedUsername)}/permission`;
  const response = await forgejoRequest(input.http, origin, path, input.token);
  if (response.status === 403) {
    throw new ForgejoContractError(
      "forgejo_identity_mismatch",
      403,
      "claimed Forgejo username does not match the token",
    );
  }
  if (response.status !== 200) {
    throw new ForgejoContractError(
      "forgejo_identity_mismatch",
      400,
      "Forgejo identity could not be bound",
    );
  }
  const permission = parsePermission(await response.json());
  if (permission.user.login !== input.claimedUsername) {
    throw new ForgejoContractError(
      "forgejo_identity_mismatch",
      403,
      "claimed Forgejo username does not match the token",
    );
  }
  return permission.user;
}

export function createForgejoConnectionClient(input: {
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
}): ForgejoConnectionClient {
  return {
    async currentUser(connectionId) {
      const connection = await requireConnection(input.directory, connectionId);
      return { id: connection.forgejoUserId, login: connection.forgejoUserLogin };
    },
    async repositoryPermission(request) {
      const token = await connectionPat(input, request.connectionId);
      const instance = await requireInstanceForConnection(input.directory, request.connectionId);
      const origin = originFromInstance(instance);
      const path = `/api/v1/repos/${encodeURIComponent(request.owner)}/${encodeURIComponent(request.repo)}/collaborators/${encodeURIComponent(request.username)}/permission`;
      const body = await forgejoJson(input.http, origin, path, token);
      return parsePermission(body);
    },
    async listVisibleRepositories(connectionId) {
      const token = await connectionPat(input, connectionId);
      const instance = await requireInstanceForConnection(input.directory, connectionId);
      return listVisibleRepositories(input.http, instance, token);
    },
  };
}

export async function handleForgejoConnectionsRequest(
  request: Request,
  options: ForgejoConnectionsRequestOptions,
): Promise<Response> {
  try {
    const access = await options.access.resolve(request);
    const organizationId = requireOrganizationOwner(access);
    const url = new URL(request.url);
    const lifecycle =
      options.lifecycle ??
      createForgejoLifecycle({
        directory: options.directory,
        http: options.http,
        secrets: options.secrets,
      });
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/connections")) {
      return Response.json(await listOrganizationForgejo(organizationId, options.directory));
    }
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/connections")) {
      const created = await createOrganizationConnection(
        request,
        access.userId,
        organizationId,
        options,
      );
      return Response.json(created, { status: 201 });
    }
    const lifecycleResponse = await handleForgejoLifecycleRequest({
      request,
      pathname: url.pathname,
      organizationId,
      options,
      lifecycle,
    });
    if (lifecycleResponse !== undefined) return lifecycleResponse;
    const recover = /^\/connections\/([^/]+)\/recover-cleanup$/u.exec(url.pathname);
    if (request.method === "POST" && recover !== null && recover[1] !== undefined) {
      if (options.recovery === undefined) {
        throw new ForgejoContractError("not_found", 404, "Forgejo recovery is unavailable");
      }
      const body = await readJsonObject(request);
      const webhookAdminPat = readString(body, "webhookAdminPat");
      const processed = await options.recovery.recoverCleanup({
        organizationId,
        connectionId: recover[1],
        webhookAdminPat,
      });
      const health = await options.recovery.healthForConnection(recover[1]);
      return Response.json({ processed, health });
    }
    const enroll = /^\/connections\/([^/]+)\/enroll$/u.exec(url.pathname);
    if (request.method === "POST" && enroll !== null && enroll[1] !== undefined) {
      const body = await readJsonObject(request);
      const repositoryIds = readRepositoryIds(body);
      const enrolled = await enrollRepositories({
        directory: options.directory,
        http: options.http,
        secrets: options.secrets,
        organizationId,
        connectionId: enroll[1],
        repositoryIds,
        ...(options.onEnrolled === undefined ? {} : { onEnrolled: options.onEnrolled }),
      });
      return Response.json({
        connection: publicConnection(enrolled.connection),
        credential: { kind: "connection", secret: maskForgejoPat() },
        repositories: enrolled.repositories.map(publicRepository),
      });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return forgejoErrorResponse(error);
  }
}

async function handleForgejoLifecycleRequest(input: {
  request: Request;
  pathname: string;
  organizationId: string;
  options: ForgejoConnectionsRequestOptions;
  lifecycle: ForgejoLifecycle;
}): Promise<Response | undefined> {
  const route = forgejoLifecycleRoute(input.pathname);
  if (route === undefined) return undefined;
  if (route.action === "impact") {
    if (input.request.method !== "GET") return undefined;
    return Response.json(
      await input.lifecycle.previewDisconnect({
        organizationId: input.organizationId,
        connectionId: route.connectionId,
      }),
    );
  }
  if (input.request.method !== "POST") return undefined;
  switch (route.action) {
    case "rotate_connection":
      return rotateConnectionCredentialResponse(input, route.connectionId);
    case "revoke_connection":
      return Response.json({
        credential: await input.lifecycle.revokeConnectionCredential({
          organizationId: input.organizationId,
          connectionId: route.connectionId,
        }),
      });
    case "configure_execution":
      return configureExecutionCredentialResponse(input, route.connectionId);
    case "revoke_execution":
      return Response.json({
        credential: await input.lifecycle.revokeExecutionCredential({
          organizationId: input.organizationId,
          connectionId: route.connectionId,
        }),
      });
    case "rotate_webhook":
      return rotateWebhookSecretResponse(input, route.connectionId);
    case "disconnect":
      return disconnectConnectionResponse(input, route.connectionId);
    default:
      return undefined;
  }
}

async function rotateConnectionCredentialResponse(
  input: {
    request: Request;
    organizationId: string;
    options: ForgejoConnectionsRequestOptions;
    lifecycle: ForgejoLifecycle;
  },
  connectionId: string,
): Promise<Response> {
  const credential = await rotateOrganizationConnectionCredential({
    request: input.request,
    organizationId: input.organizationId,
    connectionId,
    directory: input.options.directory,
    http: input.options.http,
    lifecycle: input.lifecycle,
  });
  return Response.json({ credential });
}

async function configureExecutionCredentialResponse(
  input: { request: Request; organizationId: string; lifecycle: ForgejoLifecycle },
  connectionId: string,
): Promise<Response> {
  const body = await readJsonObject(input.request);
  return Response.json({
    credential: await input.lifecycle.configureExecutionCredential({
      organizationId: input.organizationId,
      connectionId,
      pat: readString(body, "pat"),
      scopes: readStringList(body["scopes"], "execution scopes are invalid"),
      repositories: readStringList(body["repositories"], "execution repositories are invalid"),
    }),
  });
}

async function rotateWebhookSecretResponse(
  input: { request: Request; organizationId: string; lifecycle: ForgejoLifecycle },
  connectionId: string,
): Promise<Response> {
  const body = await readJsonObject(input.request);
  return Response.json(
    await input.lifecycle.rotateWebhookSecret({
      organizationId: input.organizationId,
      connectionId,
      webhookAdminPat: readString(body, "webhookAdminPat"),
    }),
  );
}

async function disconnectConnectionResponse(
  input: { request: Request; organizationId: string; lifecycle: ForgejoLifecycle },
  connectionId: string,
): Promise<Response> {
  const body = await readOptionalJsonObject(input.request);
  const webhookAdminPat = readOptionalWebhookAdminPat(body);
  const lifecycleInput: {
    organizationId: string;
    connectionId: string;
    webhookAdminPat?: string;
  } = { organizationId: input.organizationId, connectionId };
  if (webhookAdminPat !== undefined) lifecycleInput.webhookAdminPat = webhookAdminPat;
  const result = await input.lifecycle.disconnect(lifecycleInput);
  return Response.json(result, { status: result.cleanupStatus === "complete" ? 200 : 202 });
}

function forgejoLifecycleRoute(
  pathname: string,
): { connectionId: string; action: ForgejoLifecycleRouteAction } | undefined {
  const matched = /^\/connections\/([^/]+)\/(.+)$/u.exec(pathname);
  if (matched === null) return undefined;
  const connectionId = matched[1];
  const suffix = matched[2];
  if (connectionId === undefined || suffix === undefined) return undefined;
  const action = forgejoLifecycleAction(suffix);
  return action === undefined ? undefined : { connectionId, action };
}

function forgejoLifecycleAction(suffix: string): ForgejoLifecycleRouteAction | undefined {
  switch (suffix) {
    case "impact":
      return "impact";
    case "credentials/connection/rotate":
      return "rotate_connection";
    case "credentials/connection/revoke":
      return "revoke_connection";
    case "credentials/execution":
      return "configure_execution";
    case "credentials/execution/revoke":
      return "revoke_execution";
    case "credentials/webhook_secret/rotate":
      return "rotate_webhook";
    case "disconnect":
      return "disconnect";
    default:
      return undefined;
  }
}

export function forgejoConfigurationResourceItems(input: {
  connections: readonly ForgejoConnectionRecord[];
  originByInstanceId: ReadonlyMap<string, string>;
  enrolledFullNamesByConnectionId: ReadonlyMap<string, readonly string[]>;
}): {
  slug: string;
  instanceOrigin: string;
  userLogin: string;
  repositories: string[];
}[] {
  return input.connections.map((connection) => ({
    slug: connection.slug,
    instanceOrigin: input.originByInstanceId.get(connection.instanceId) ?? "",
    userLogin: connection.forgejoUserLogin,
    repositories: [...(input.enrolledFullNamesByConnectionId.get(connection.id) ?? [])],
  }));
}

export function publicConnection(connection: ForgejoConnectionRecord): {
  id: string;
  organizationId: string;
  instanceId: string;
  slug: string;
  status: ForgejoConnectionRecord["status"];
  forgejoUserId: number;
  forgejoUserLogin: string;
  credential: { kind: "connection"; secret: typeof FORGEJO_PAT_MASK };
} {
  return {
    id: connection.id,
    organizationId: connection.organizationId,
    instanceId: connection.instanceId,
    slug: connection.slug,
    status: connection.status,
    forgejoUserId: connection.forgejoUserId,
    forgejoUserLogin: connection.forgejoUserLogin,
    credential: { kind: "connection", secret: maskForgejoPat() },
  };
}

async function createOrganizationConnection(
  request: Request,
  userId: string,
  organizationId: string,
  options: {
    directory: ForgejoDirectory;
    http: ForgejoHttp;
    secrets: SecretEncryptionKeySource;
  },
): Promise<{
  connection: ReturnType<typeof publicConnection>;
  credential: { kind: "connection"; secret: typeof FORGEJO_PAT_MASK };
  visibleRepositories: ReturnType<typeof publicRepository>[];
}> {
  const body = await readJsonObject(request);
  rejectDisallowedCredentialFields(body);
  const parsed = parseCreateBody(body);
  const validated = validateConnectionCredential({
    pat: parsed.pat,
    scopes: parsed.scopes,
    limitedRepositoryIds: parsed.limitedRepositoryIds,
    oauth2: parsed.oauth2,
    ...(parsed.password === undefined ? {} : { password: parsed.password }),
  });
  const instance = await options.directory.findInstanceById(parsed.instanceId);
  if (instance === undefined || instance.status !== "active") {
    throw new ForgejoContractError(
      "forgejo_origin_unapproved",
      400,
      "organization owners may connect only to an approved Forgejo instance",
    );
  }
  const visible = await listVisibleRepositories(options.http, instance, parsed.pat);
  const identity = await bindForgejoIdentity({
    http: options.http,
    instance,
    token: parsed.pat,
    claimedUsername: parsed.claimedUsername,
    repositories: visible,
  });
  const connectionId = randomUUID();
  const credentialId = randomUUID();
  const envelope = encryptSecret(options.secrets, {
    plaintext: parsed.pat,
    organizationId,
    credentialId,
    kind: "connection",
  });
  const connection: ForgejoConnectionRecord = {
    id: connectionId,
    organizationId,
    instanceId: instance.id,
    slug: parsed.slug,
    status: "active",
    forgejoUserId: identity.id,
    forgejoUserLogin: identity.login,
    providerApplicationId: null,
  };
  await options.directory.insertConnection(connection);
  await options.directory.insertCredential({
    id: credentialId,
    organizationId,
    connectionId,
    kind: "connection",
    alg: envelope.alg,
    keyId: envelope.keyId,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    aadVersion: envelope.aadVersion,
    scopeEvidence: { scopes: validated.scopes, repositoryIds: [...validated.repositoryIds] },
    status: "active",
  });
  const persisted = await persistVisibleRepositories(
    options.directory,
    organizationId,
    connectionId,
    visible,
  );
  return {
    connection: publicConnection(connection),
    credential: { kind: "connection", secret: maskForgejoPat() },
    visibleRepositories: persisted.map(publicRepository),
  };
}

async function rotateOrganizationConnectionCredential(input: {
  request: Request;
  organizationId: string;
  connectionId: string;
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  lifecycle: ForgejoLifecycle;
}) {
  const body = await readJsonObject(input.request);
  rejectDisallowedCredentialFields(body);
  const parsed = parseConnectionCredentialBody(body);
  const validated = validateConnectionCredential({
    pat: parsed.pat,
    scopes: parsed.scopes,
    limitedRepositoryIds: parsed.limitedRepositoryIds,
    oauth2: parsed.oauth2,
    ...(parsed.password === undefined ? {} : { password: parsed.password }),
  });
  const connection = await requireOwnedConnection(input.directory, input);
  if (connection.status === "disconnected") {
    throw new ForgejoContractError(
      "forgejo_credential_unavailable",
      409,
      "Forgejo connection is unavailable",
    );
  }
  const instance = await input.directory.findInstanceById(connection.instanceId);
  if (instance === undefined || instance.status !== "active") {
    throw new ForgejoContractError(
      "forgejo_origin_unapproved",
      409,
      "Forgejo instance is unavailable",
    );
  }
  const visible = await listVisibleRepositories(input.http, instance, parsed.pat);
  const identity = await bindForgejoIdentity({
    http: input.http,
    instance,
    token: parsed.pat,
    claimedUsername: connection.forgejoUserLogin,
    repositories: visible,
  });
  if (identity.id !== connection.forgejoUserId || identity.login !== connection.forgejoUserLogin) {
    throw new ForgejoContractError(
      "forgejo_identity_mismatch",
      403,
      "rotated Forgejo PAT does not match the connected identity",
    );
  }
  const enrolled = (await input.directory.listRepositoriesForConnection(connection.id)).filter(
    (repository) => repository.enrolled,
  );
  const visibleIds = new Set(visible.map((repository) => repository.id));
  const declaredIds = new Set(validated.repositoryIds);
  for (const repository of enrolled) {
    if (!visibleIds.has(repository.repositoryId) || !declaredIds.has(repository.repositoryId)) {
      throw new ForgejoContractError(
        "forgejo_scope_invalid",
        400,
        "rotated Forgejo PAT must retain every enrolled repository",
      );
    }
  }
  return input.lifecycle.rotateConnectionCredential({
    organizationId: connection.organizationId,
    connectionId: connection.id,
    pat: parsed.pat,
    scopes: validated.scopes,
    repositoryIds: validated.repositoryIds,
  });
}

async function listOrganizationForgejo(organizationId: string, directory: ForgejoDirectory) {
  const [connections, instances] = await Promise.all([
    directory.listConnectionsForOrganization(organizationId),
    directory.listInstances(),
  ]);
  const approved = instances.filter((instance) => instance.status === "active").map(publicInstance);
  const detailed = [];
  for (const connection of connections) {
    const repositories = await directory.listRepositoriesForConnection(connection.id);
    const publicRow = publicConnection(connection);
    detailed.push({
      id: publicRow.id,
      organizationId: publicRow.organizationId,
      instanceId: publicRow.instanceId,
      slug: publicRow.slug,
      status: publicRow.status,
      forgejoUserId: publicRow.forgejoUserId,
      forgejoUserLogin: publicRow.forgejoUserLogin,
      credential: publicRow.credential,
      repositories: repositories.map(publicRepository),
    });
  }
  return { approvedInstances: approved, connections: detailed };
}

async function connectionPat(
  input: { directory: ForgejoDirectory; secrets: SecretEncryptionKeySource },
  connectionId: string,
): Promise<string> {
  const credential = await input.directory.findActiveConnectionCredential(connectionId);
  if (credential === undefined) {
    throw new ForgejoContractError(
      "forgejo_credential_unavailable",
      409,
      "Forgejo connection credential is unavailable",
    );
  }
  return decryptSecret(
    input.secrets,
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

async function requireConnection(
  directory: ForgejoDirectory,
  connectionId: string,
): Promise<ForgejoConnectionRecord> {
  const connection = await directory.findConnectionById(connectionId);
  if (connection === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo connection was not found");
  }
  return connection;
}

async function requireInstanceForConnection(
  directory: ForgejoDirectory,
  connectionId: string,
): Promise<ForgejoInstanceRecord> {
  const connection = await requireConnection(directory, connectionId);
  const instance = await directory.findInstanceById(connection.instanceId);
  if (instance === undefined || instance.status !== "active") {
    throw new ForgejoContractError(
      "forgejo_origin_unapproved",
      400,
      "Forgejo instance is not approved",
    );
  }
  return instance;
}

function parseCreateBody(body: Record<string, unknown>): CreateForgejoConnectionInput & {
  oauth2: boolean;
  password: string | undefined;
} {
  const slug = readString(body, "slug");
  if (!SLUG_PATTERN.test(slug)) {
    throw new ForgejoContractError("forgejo_origin_invalid", 400, "connection slug is invalid");
  }
  const scopesValue = body["scopes"];
  if (!Array.isArray(scopesValue) || scopesValue.some((entry) => typeof entry !== "string")) {
    throw new ForgejoContractError("forgejo_scope_invalid", 400, "Forgejo scopes are invalid");
  }
  return {
    instanceId: readString(body, "instanceId"),
    slug,
    claimedUsername: readString(body, "claimedUsername"),
    pat: readString(body, "pat"),
    scopes: scopesValue,
    limitedRepositoryIds: parseLimitedRepositoryIds(body["repositories"]),
    oauth2: body["oauth2"] === true || body["grantType"] === "oauth2",
    password: typeof body["password"] === "string" ? body["password"] : undefined,
  };
}

function parseConnectionCredentialBody(body: Record<string, unknown>): Pick<
  CreateForgejoConnectionInput,
  "pat" | "scopes" | "limitedRepositoryIds"
> & {
  oauth2: boolean;
  password: string | undefined;
} {
  const scopes = readStringList(body["scopes"], "Forgejo scopes are invalid");
  return {
    pat: readString(body, "pat"),
    scopes,
    limitedRepositoryIds: parseLimitedRepositoryIds(body["repositories"]),
    oauth2: body["oauth2"] === true || body["grantType"] === "oauth2",
    password: typeof body["password"] === "string" ? body["password"] : undefined,
  };
}

function parseLimitedRepositoryIds(value: unknown): readonly number[] | "unscoped" {
  if (value === null) return "unscoped";
  if (value === undefined) return [];
  return readIntegerList(value, "repository list is invalid");
}

function readRepositoryIds(body: Record<string, unknown>): number[] {
  return readIntegerList(body["repositoryIds"], "repositoryIds are invalid");
}

function readIntegerList(value: unknown, message: string): number[] {
  if (!Array.isArray(value)) {
    throw new ForgejoContractError("forgejo_scope_invalid", 400, message);
  }
  const ids: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry)) {
      throw new ForgejoContractError("forgejo_scope_invalid", 400, message);
    }
    ids.push(entry);
  }
  return ids;
}

function readStringList(value: unknown, message: string): string[] {
  if (!Array.isArray(value)) {
    throw new ForgejoContractError("forgejo_scope_invalid", 400, message);
  }
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new ForgejoContractError("forgejo_scope_invalid", 400, message);
    }
    strings.push(entry.trim());
  }
  return strings;
}

async function readOptionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.trim().length === 0) return {};
  try {
    return asJsonRecord(
      JSON.parse(raw),
      "forgejo_origin_invalid",
      "request body must be an object",
    );
  } catch (error) {
    if (error instanceof ForgejoContractError) throw error;
    throw new ForgejoContractError(
      "forgejo_origin_invalid",
      400,
      "request body must be valid JSON",
    );
  }
}

function readOptionalWebhookAdminPat(body: Record<string, unknown>): string | undefined {
  const value = body["webhookAdminPat"];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || /\s/u.test(value)) {
    throw new ForgejoContractError("forgejo_scope_invalid", 400, "webhook-admin PAT is invalid");
  }
  return value;
}

async function requireOwnedConnection(
  directory: ForgejoDirectory,
  input: { organizationId: string; connectionId: string },
): Promise<ForgejoConnectionRecord> {
  const connection = await directory.findConnectionById(input.connectionId);
  if (connection === undefined || connection.organizationId !== input.organizationId) {
    throw new ForgejoContractError("not_found", 404, "Forgejo connection was not found");
  }
  return connection;
}

function rejectDisallowedCredentialFields(body: Record<string, unknown>): void {
  if ("executionPat" in body || "webhookAdminPat" in body || "webhook_admin" in body) {
    throw new ForgejoContractError(
      "forgejo_scope_invalid",
      400,
      "execution and webhook-admin PATs are not accepted here",
    );
  }
}

function isAllowedScope(value: string): value is ConnectionScope {
  return (ALLOWED_CONNECTION_SCOPES as readonly string[]).includes(value);
}

function storedScopes(scopes: readonly string[]): ConnectionScope[] {
  const issue: ConnectionScope = scopes.includes("write:issue") ? "write:issue" : "read:issue";
  const repository: ConnectionScope = scopes.includes("write:repository")
    ? "write:repository"
    : "read:repository";
  const stored: ConnectionScope[] = [];
  if (scopes.includes("read:issue") || scopes.includes("write:issue")) stored.push(issue);
  if (scopes.includes("read:repository") || scopes.includes("write:repository")) {
    stored.push(repository);
  }
  return stored;
}

function hasIssueScope(scopes: readonly ConnectionScope[]): boolean {
  return scopes.includes("read:issue") || scopes.includes("write:issue");
}

function hasRepositoryScope(scopes: readonly ConnectionScope[]): boolean {
  return scopes.includes("read:repository") || scopes.includes("write:repository");
}

function parsePermission(body: unknown): ForgejoCollaboratorPermission {
  const parsed = asJsonRecord(body, "forgejo_identity_mismatch", "permission response is invalid");
  const user = asJsonRecord(
    parsed["user"],
    "forgejo_identity_mismatch",
    "permission response is invalid",
  );
  const id = user["id"];
  const login = user["login"];
  if (typeof id !== "number" || typeof login !== "string") {
    throw new ForgejoContractError(
      "forgejo_identity_mismatch",
      400,
      "permission response is invalid",
    );
  }
  return {
    permission: typeof parsed["permission"] === "string" ? parsed["permission"] : "read",
    roleName: typeof parsed["role_name"] === "string" ? parsed["role_name"] : "read",
    user: { id, login },
  };
}
