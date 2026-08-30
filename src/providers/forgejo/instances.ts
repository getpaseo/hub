import { randomUUID } from "node:crypto";
import {
  ApprovedOriginError,
  assertResolvedAddressesAllowed,
  canonicalizeHttpsOrigin,
  nodeDnsResolver,
  rejectRedirectStatus,
  type CanonicalHttpsOrigin,
  type DnsResolver,
} from "../../http/approved-origin.js";
import type {
  ForgejoConnectionRecord,
  ForgejoInstanceRecord,
  ForgejoRepositoryRecord,
} from "../../db/types.js";
import {
  SecretEnvelopeError,
  type AuthenticatedEnvelope,
} from "../../secrets/authenticated-envelope.js";

export const FORGEJO_MINIMUM_VERSION = "16.0.3";
export const FORGEJO_PAT_MASK = "••••";

export type ForgejoTypedErrorCode =
  | "forgejo_origin_unapproved"
  | "forgejo_origin_invalid"
  | "forgejo_version_unsupported"
  | "forgejo_scope_invalid"
  | "forgejo_identity_mismatch"
  | "forgejo_credential_unavailable"
  | "forbidden"
  | "not_found";

export class ForgejoContractError extends Error {
  readonly code: ForgejoTypedErrorCode;
  readonly status: number;

  constructor(code: ForgejoTypedErrorCode, status: number, message: string) {
    super(message);
    this.name = "ForgejoContractError";
    this.code = code;
    this.status = status;
  }
}

export interface ForgejoAccess {
  userId: string;
  isInstanceOperator: boolean;
  organizationId: string | null;
  organizationRole: "owner" | "admin" | "member" | null;
}

export interface ForgejoAccessResolver {
  resolve(request: Request): Promise<ForgejoAccess>;
}

export interface ForgejoApiSettings {
  maxResponseItems: number;
  defaultPagingNum: number;
}

export interface ForgejoExternalIdentity {
  kind: "forgejo";
  version: string;
  capabilities: ForgejoApiSettings;
  fingerprint: string;
  uid: string | null;
}

export interface ForgejoCredentialRecord {
  id: string;
  organizationId: string;
  connectionId: string;
  kind: "connection";
  alg: string;
  keyId: number;
  nonce: Buffer;
  ciphertext: Buffer;
  aadVersion: number;
  scopeEvidence: {
    scopes: readonly string[];
    repositoryIds: readonly number[];
  };
  status: "active" | "rotating" | "revoked";
}

export interface ForgejoDirectory {
  insertInstance(record: ForgejoInstanceRecord): Promise<void>;
  updateInstance(record: ForgejoInstanceRecord): Promise<void>;
  findInstanceById(id: string): Promise<ForgejoInstanceRecord | undefined>;
  findInstanceByOrigin(origin: string): Promise<ForgejoInstanceRecord | undefined>;
  listInstances(): Promise<ForgejoInstanceRecord[]>;
  insertConnection(record: ForgejoConnectionRecord): Promise<void>;
  updateConnection(record: ForgejoConnectionRecord): Promise<void>;
  findConnectionById(id: string): Promise<ForgejoConnectionRecord | undefined>;
  listConnectionsForOrganization(organizationId: string): Promise<ForgejoConnectionRecord[]>;
  insertCredential(record: ForgejoCredentialRecord): Promise<void>;
  findActiveConnectionCredential(
    connectionId: string,
  ): Promise<ForgejoCredentialRecord | undefined>;
  upsertRepository(record: ForgejoRepositoryRecord): Promise<void>;
  listRepositoriesForConnection(connectionId: string): Promise<ForgejoRepositoryRecord[]>;
  findActiveExecutionCredential(
    connectionId: string,
  ): Promise<ForgejoExecutionCredentialRecord | undefined>;
}

export interface ForgejoExecutionCredentialRecord {
  id: string;
  organizationId: string;
  kind: "execution";
  status: "active" | "rotating" | "revoked";
  envelope: AuthenticatedEnvelope;
  scopeEvidence: {
    scopes: readonly string[];
    repositories: readonly string[];
  };
}

export interface ForgejoHttp {
  fetch: typeof fetch;
  resolver: DnsResolver;
}

export interface InstanceProbe {
  version: string;
  capabilities: ForgejoApiSettings;
  identity: ForgejoExternalIdentity;
}

const MINIMUM = parseVersion(FORGEJO_MINIMUM_VERSION);

export function createMemoryForgejoDirectory(
  seed: {
    instances?: readonly ForgejoInstanceRecord[];
    connections?: readonly ForgejoConnectionRecord[];
    credentials?: readonly ForgejoCredentialRecord[];
    repositories?: readonly ForgejoRepositoryRecord[];
  } = {},
): ForgejoDirectory {
  const instances = new Map(seed.instances?.map((row) => [row.id, { ...row }]) ?? []);
  const connections = new Map(seed.connections?.map((row) => [row.id, { ...row }]) ?? []);
  const credentials = new Map(seed.credentials?.map((row) => [row.id, cloneCredential(row)]) ?? []);
  const repositories = new Map(seed.repositories?.map((row) => [row.id, { ...row }]) ?? []);
  return {
    async insertInstance(record) {
      if ([...instances.values()].some((row) => row.canonicalOrigin === record.canonicalOrigin)) {
        throw new ForgejoContractError(
          "forgejo_origin_invalid",
          409,
          "Forgejo origin is already registered",
        );
      }
      instances.set(record.id, { ...record });
    },
    async updateInstance(record) {
      instances.set(record.id, { ...record });
    },
    async findInstanceById(id) {
      const row = instances.get(id);
      return row === undefined ? undefined : { ...row };
    },
    async findInstanceByOrigin(origin) {
      const row = [...instances.values()].find((candidate) => candidate.canonicalOrigin === origin);
      return row === undefined ? undefined : { ...row };
    },
    async listInstances() {
      const rows: ForgejoInstanceRecord[] = [];
      for (const row of instances.values()) rows.push(cloneInstance(row));
      rows.sort((left, right) => left.canonicalOrigin.localeCompare(right.canonicalOrigin));
      return rows;
    },
    async insertConnection(record) {
      const duplicateSlug = [...connections.values()].some(
        (row) => row.organizationId === record.organizationId && row.slug === record.slug,
      );
      if (duplicateSlug) {
        throw new ForgejoContractError("forgejo_identity_mismatch", 409, "connection slug exists");
      }
      const duplicateBind = [...connections.values()].some(
        (row) =>
          row.organizationId === record.organizationId &&
          row.instanceId === record.instanceId &&
          row.forgejoUserId === record.forgejoUserId,
      );
      if (duplicateBind) {
        throw new ForgejoContractError(
          "forgejo_identity_mismatch",
          409,
          "Forgejo user is already bound on this instance",
        );
      }
      connections.set(record.id, { ...record });
    },
    async updateConnection(record) {
      connections.set(record.id, { ...record });
    },
    async findConnectionById(id) {
      const row = connections.get(id);
      return row === undefined ? undefined : { ...row };
    },
    async listConnectionsForOrganization(organizationId) {
      const rows: ForgejoConnectionRecord[] = [];
      for (const row of connections.values()) {
        if (row.organizationId === organizationId) rows.push(cloneConnection(row));
      }
      return rows;
    },
    async insertCredential(record) {
      if (record.kind !== "connection") {
        throw new ForgejoContractError(
          "forgejo_scope_invalid",
          400,
          "only connection credentials may be persisted here",
        );
      }
      credentials.set(record.id, cloneCredential(record));
    },
    async findActiveConnectionCredential(connectionId) {
      const row = [...credentials.values()].find(
        (candidate) =>
          candidate.connectionId === connectionId &&
          candidate.kind === "connection" &&
          candidate.status === "active",
      );
      return row === undefined ? undefined : cloneCredential(row);
    },
    async upsertRepository(record) {
      const existing = [...repositories.values()].find(
        (row) =>
          row.connectionId === record.connectionId && row.repositoryId === record.repositoryId,
      );
      if (existing === undefined) {
        repositories.set(record.id, { ...record });
        return;
      }
      repositories.set(existing.id, {
        ...existing,
        fullName: record.fullName,
        ownerLogin: record.ownerLogin,
        name: record.name,
        defaultBranch: record.defaultBranch,
        htmlUrl: record.htmlUrl,
        enrolled: record.enrolled,
      });
    },
    async listRepositoriesForConnection(connectionId) {
      const rows: ForgejoRepositoryRecord[] = [];
      for (const row of repositories.values()) {
        if (row.connectionId === connectionId) rows.push(cloneRepository(row));
      }
      return rows;
    },
    async findActiveExecutionCredential() {
      return undefined;
    },
  };
}

export function requireInstanceOperator(access: ForgejoAccess): void {
  if (!access.isInstanceOperator) {
    throw new ForgejoContractError("forbidden", 403, "instance-operator access is required");
  }
}

export function requireOrganizationOwner(access: ForgejoAccess): string {
  if (access.organizationId === null || access.organizationRole !== "owner") {
    throw new ForgejoContractError("forbidden", 403, "organization owner access is required");
  }
  return access.organizationId;
}

export function compareForgejoVersion(version: string): number {
  const parsed = parseVersion(version);
  if (parsed === undefined || MINIMUM === undefined) return -1;
  if (parsed.major !== MINIMUM.major) return parsed.major - MINIMUM.major;
  if (parsed.minor !== MINIMUM.minor) return parsed.minor - MINIMUM.minor;
  return parsed.patch - MINIMUM.patch;
}

export function parseVersion(
  version: string,
): { major: number; minor: number; patch: number } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function requiredCapabilities(settings: unknown): ForgejoApiSettings {
  const body = asJsonRecord(
    settings,
    "forgejo_version_unsupported",
    "Forgejo API settings are missing",
    409,
  );
  return {
    maxResponseItems: capabilityNumber(body, "max_response_items"),
    defaultPagingNum: capabilityNumber(body, "default_paging_num"),
  };
}

export function identityFingerprint(
  identity: Omit<ForgejoExternalIdentity, "fingerprint">,
): string {
  const uid = identity.uid ?? "none";
  return `${identity.kind}|${identity.version}|${uid}|${String(identity.capabilities.maxResponseItems)}|${String(identity.capabilities.defaultPagingNum)}`;
}

export function resolveApprovedOrigin(
  raw: string,
  allowPrivateNetwork: boolean,
): CanonicalHttpsOrigin {
  try {
    return canonicalizeHttpsOrigin(raw, { allowPrivateNetwork });
  } catch (error) {
    throw mapOriginError(error);
  }
}

export async function probeForgejoInstance(
  origin: CanonicalHttpsOrigin,
  http: ForgejoHttp,
): Promise<InstanceProbe> {
  await assertOriginAllowed(origin, http.resolver);
  const versionBody = await forgejoJson(http, origin, "/api/v1/version");
  const version = readVersion(versionBody);
  if (compareForgejoVersion(version) < 0) {
    throw new ForgejoContractError(
      "forgejo_version_unsupported",
      409,
      `Forgejo ${version} is below ${FORGEJO_MINIMUM_VERSION}`,
    );
  }
  const settingsBody = await forgejoJson(http, origin, "/api/v1/settings/api");
  const capabilities = requiredCapabilities(settingsBody);
  const uid = readOptionalUid(versionBody);
  const identityBase = { kind: "forgejo" as const, version, capabilities, uid };
  return {
    version,
    capabilities,
    identity: { ...identityBase, fingerprint: identityFingerprint(identityBase) },
  };
}

export async function forgejoJson(
  http: ForgejoHttp,
  origin: CanonicalHttpsOrigin,
  path: string,
  token?: string,
): Promise<unknown> {
  const response = await forgejoRequest(http, origin, path, token);
  if (response.status === 401 || response.status === 403) {
    throw new ForgejoContractError(
      "forgejo_identity_mismatch",
      response.status,
      "Forgejo rejected the credential",
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ForgejoContractError(
      "forgejo_origin_unapproved",
      502,
      "Forgejo API was not reachable",
    );
  }
  return response.json();
}

export async function forgejoRequest(
  http: ForgejoHttp,
  origin: CanonicalHttpsOrigin,
  path: string,
  token?: string,
): Promise<Response> {
  await assertOriginAllowed(origin, http.resolver);
  const headers = new Headers({ accept: "application/json" });
  if (token !== undefined) headers.set("authorization", `token ${token}`);
  const response = await http.fetch(new URL(path, `${origin.origin}/`).toString(), {
    method: "GET",
    headers,
    redirect: "manual",
  });
  try {
    rejectRedirectStatus(response.status);
  } catch (error) {
    throw mapOriginError(error);
  }
  return response;
}

export function originFromInstance(instance: ForgejoInstanceRecord): CanonicalHttpsOrigin {
  return canonicalizeHttpsOrigin(instance.canonicalOrigin, {
    allowPrivateNetwork: instance.allowPrivateNetwork,
  });
}

export function publicInstance(instance: ForgejoInstanceRecord): {
  id: string;
  canonicalOrigin: string;
  reportedVersion: string;
  status: ForgejoInstanceRecord["status"];
  allowPrivateNetwork: boolean;
  lastHealthError: string | null;
} {
  return {
    id: instance.id,
    canonicalOrigin: instance.canonicalOrigin,
    reportedVersion: instance.reportedVersion,
    status: instance.status,
    allowPrivateNetwork: instance.allowPrivateNetwork,
    lastHealthError: instance.lastHealthError,
  };
}

export function envelopeFromCredential(record: ForgejoCredentialRecord): AuthenticatedEnvelope {
  return {
    alg: "aes-256-gcm",
    keyId: record.keyId,
    nonce: record.nonce,
    ciphertext: record.ciphertext,
    aadVersion: 1,
  };
}

export async function handleForgejoInstancesRequest(
  request: Request,
  options: {
    access: ForgejoAccessResolver;
    directory: ForgejoDirectory;
    http: ForgejoHttp;
  },
): Promise<Response> {
  try {
    const access = await options.access.resolve(request);
    requireInstanceOperator(access);
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/instances")) {
      const instances = await options.directory.listInstances();
      return Response.json({ instances: instances.map(publicInstance) });
    }
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/instances")) {
      const instance = await approveInstance(request, access.userId, options);
      return Response.json({ instance: publicInstance(instance) }, { status: 201 });
    }
    const verify = /^\/instances\/([^/]+)\/verify$/u.exec(url.pathname);
    if (request.method === "POST" && verify !== null && verify[1] !== undefined) {
      const instance = await verifyExistingInstance(verify[1], options);
      return Response.json({ instance: publicInstance(instance) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return forgejoErrorResponse(error);
  }
}

export function forgejoErrorResponse(error: unknown): Response {
  if (error instanceof ForgejoContractError) {
    return Response.json({ error: error.code }, { status: error.status });
  }
  if (error instanceof ApprovedOriginError) {
    return Response.json(
      { error: originCode(error.code) },
      { status: error.code === "private_network_forbidden" ? 400 : 400 },
    );
  }
  if (error instanceof SecretEnvelopeError) {
    return Response.json({ error: "forgejo_credential_unavailable" }, { status: 409 });
  }
  return Response.json({ error: "forgejo_origin_unapproved" }, { status: 500 });
}

export function createDefaultForgejoHttp(fetchImpl: typeof fetch = fetch): ForgejoHttp {
  return { fetch: fetchImpl, resolver: nodeDnsResolver() };
}

async function approveInstance(
  request: Request,
  userId: string,
  options: { directory: ForgejoDirectory; http: ForgejoHttp },
): Promise<ForgejoInstanceRecord> {
  const body = await readJsonObject(request);
  const originRaw = readString(body, "origin");
  const allowPrivateNetwork = body["allowPrivateNetwork"] === true;
  const origin = resolveApprovedOrigin(originRaw, allowPrivateNetwork);
  const existing = await options.directory.findInstanceByOrigin(origin.origin);
  const now = new Date();
  try {
    const probe = await probeForgejoInstance(origin, options.http);
    const record = instanceRecord({
      existing,
      origin,
      probe,
      userId,
      now,
      status: "active",
      lastHealthError: null,
    });
    if (existing === undefined) await options.directory.insertInstance(record);
    else await options.directory.updateInstance(record);
    return record;
  } catch (error) {
    const failed = failedInstance({ existing, origin, userId, now, error });
    if (existing === undefined) await options.directory.insertInstance(failed);
    else await options.directory.updateInstance(failed);
    throw error;
  }
}

async function verifyExistingInstance(
  instanceId: string,
  options: { directory: ForgejoDirectory; http: ForgejoHttp },
): Promise<ForgejoInstanceRecord> {
  const existing = await options.directory.findInstanceById(instanceId);
  if (existing === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo instance was not found");
  }
  const origin = originFromInstance(existing);
  const now = new Date();
  try {
    const probe = await probeForgejoInstance(origin, options.http);
    const drifted = identityDrifted(existing, probe.identity);
    const record: ForgejoInstanceRecord = {
      ...existing,
      reportedVersion: probe.version,
      externalIdentity: probe.identity,
      status: drifted ? "identity_drifted" : "active",
      lastHealthAt: now,
      lastHealthError: drifted ? "Forgejo instance identity drifted" : null,
      updatedAt: now,
    };
    await options.directory.updateInstance(record);
    return record;
  } catch (error) {
    const failed = failedInstance({
      existing,
      origin,
      userId: existing.approvedByUserId ?? "unknown",
      now,
      error,
    });
    await options.directory.updateInstance(failed);
    throw error;
  }
}

function identityDrifted(existing: ForgejoInstanceRecord, next: ForgejoExternalIdentity): boolean {
  const previous = existing.externalIdentity;
  if (previous === null || typeof previous !== "object") return false;
  const uid = (previous as { uid?: unknown }).uid;
  if (typeof uid === "string" && uid.length > 0 && next.uid !== null && uid !== next.uid) {
    return true;
  }
  const previousKind = (previous as { kind?: unknown }).kind;
  return previousKind !== undefined && previousKind !== "forgejo";
}

function instanceRecord(input: {
  existing: ForgejoInstanceRecord | undefined;
  origin: CanonicalHttpsOrigin;
  probe: InstanceProbe;
  userId: string;
  now: Date;
  status: ForgejoInstanceRecord["status"];
  lastHealthError: string | null;
}): ForgejoInstanceRecord {
  return {
    id: input.existing?.id ?? randomUUID(),
    canonicalOrigin: input.origin.origin,
    allowPrivateNetwork: input.origin.allowPrivateNetwork,
    externalIdentity: input.probe.identity,
    reportedVersion: input.probe.version,
    status: input.status,
    approvedByUserId: input.userId,
    approvedAt: input.now,
    lastHealthAt: input.now,
    lastHealthError: input.lastHealthError,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
  };
}

function failedInstance(input: {
  existing: ForgejoInstanceRecord | undefined;
  origin: CanonicalHttpsOrigin;
  userId: string;
  now: Date;
  error: unknown;
}): ForgejoInstanceRecord {
  const status = failureStatus(input.error);
  const previousIdentity = input.existing?.externalIdentity ?? {
    kind: "forgejo",
    version: "unknown",
    capabilities: { maxResponseItems: 0, defaultPagingNum: 0 },
    fingerprint: "unknown",
    uid: null,
  };
  return {
    id: input.existing?.id ?? randomUUID(),
    canonicalOrigin: input.origin.origin,
    allowPrivateNetwork: input.origin.allowPrivateNetwork,
    externalIdentity: previousIdentity,
    reportedVersion: input.existing?.reportedVersion ?? "unknown",
    status,
    approvedByUserId: input.existing?.approvedByUserId ?? input.userId,
    approvedAt: input.existing?.approvedAt ?? null,
    lastHealthAt: input.now,
    lastHealthError: failureMessage(input.error),
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
  };
}

function failureStatus(error: unknown): ForgejoInstanceRecord["status"] {
  if (error instanceof ForgejoContractError && error.code === "forgejo_version_unsupported") {
    return "incompatible";
  }
  if (error instanceof ForgejoContractError && error.code === "forgejo_identity_mismatch") {
    return "identity_drifted";
  }
  return "unreachable";
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Forgejo instance verification failed";
}

function readOptionalUid(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const uid = (body as { uid?: unknown }).uid;
  return typeof uid === "string" && uid.length > 0 ? uid : null;
}

function readVersion(body: unknown): string {
  if (body === null || typeof body !== "object") {
    throw new ForgejoContractError(
      "forgejo_version_unsupported",
      409,
      "Forgejo version response is invalid",
    );
  }
  const version = (body as { version?: unknown }).version;
  if (typeof version !== "string" || parseVersion(version) === undefined) {
    throw new ForgejoContractError(
      "forgejo_version_unsupported",
      409,
      "Forgejo version response is invalid",
    );
  }
  return version;
}

function capabilityNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ForgejoContractError(
      "forgejo_version_unsupported",
      409,
      `Forgejo capability ${key} is missing`,
    );
  }
  return value;
}

async function assertOriginAllowed(
  origin: CanonicalHttpsOrigin,
  resolver: DnsResolver,
): Promise<void> {
  try {
    await assertResolvedAddressesAllowed(origin, resolver);
  } catch (error) {
    throw mapOriginError(error);
  }
}

function mapOriginError(error: unknown): ForgejoContractError {
  if (error instanceof ApprovedOriginError) {
    return new ForgejoContractError(originCode(error.code), 400, error.message);
  }
  if (error instanceof ForgejoContractError) return error;
  return new ForgejoContractError("forgejo_origin_invalid", 400, "Forgejo origin is invalid");
}

function originCode(
  code: ApprovedOriginError["code"],
): Extract<ForgejoTypedErrorCode, "forgejo_origin_invalid" | "forgejo_origin_unapproved"> {
  if (code === "invalid_url" || code === "not_https" || code === "userinfo_present") {
    return "forgejo_origin_invalid";
  }
  if (code === "non_origin_components") return "forgejo_origin_invalid";
  return "forgejo_origin_unapproved";
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  return asJsonRecord(
    await request.json(),
    "forgejo_origin_invalid",
    "request body must be an object",
  );
}

export function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ForgejoContractError("forgejo_origin_invalid", 400, `${key} is required`);
  }
  return value.trim();
}

function cloneInstance(row: ForgejoInstanceRecord): ForgejoInstanceRecord {
  return {
    id: row.id,
    canonicalOrigin: row.canonicalOrigin,
    allowPrivateNetwork: row.allowPrivateNetwork,
    externalIdentity: row.externalIdentity,
    reportedVersion: row.reportedVersion,
    status: row.status,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
    lastHealthAt: row.lastHealthAt,
    lastHealthError: row.lastHealthError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function cloneConnection(row: ForgejoConnectionRecord): ForgejoConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    instanceId: row.instanceId,
    slug: row.slug,
    status: row.status,
    forgejoUserId: row.forgejoUserId,
    forgejoUserLogin: row.forgejoUserLogin,
    providerApplicationId: row.providerApplicationId,
  };
}

function cloneRepository(row: ForgejoRepositoryRecord): ForgejoRepositoryRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    repositoryId: row.repositoryId,
    fullName: row.fullName,
    ownerLogin: row.ownerLogin,
    name: row.name,
    defaultBranch: row.defaultBranch,
    htmlUrl: row.htmlUrl,
    enrolled: row.enrolled,
  };
}

export function asJsonRecord(
  value: unknown,
  code: ForgejoTypedErrorCode,
  message: string,
  status = 400,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ForgejoContractError(code, status, message);
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = entry;
  return result;
}

function cloneCredential(record: ForgejoCredentialRecord): ForgejoCredentialRecord {
  return {
    id: record.id,
    organizationId: record.organizationId,
    connectionId: record.connectionId,
    kind: record.kind,
    alg: record.alg,
    keyId: record.keyId,
    nonce: Buffer.from(record.nonce),
    ciphertext: Buffer.from(record.ciphertext),
    aadVersion: record.aadVersion,
    scopeEvidence: {
      scopes: [...record.scopeEvidence.scopes],
      repositoryIds: [...record.scopeEvidence.repositoryIds],
    },
    status: record.status,
  };
}
