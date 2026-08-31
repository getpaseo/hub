import type { QueryHandle, QueryRow } from "./runtime/index.js";
import type {
  ForgejoConnectionRecord,
  ForgejoInstanceRecord,
  ForgejoRepositoryHookRecord,
  ForgejoRepositoryRecord,
} from "./types.js";
import {
  ForgejoContractError,
  type ForgejoCredentialState,
  type ForgejoCredentialRecord,
  type ForgejoCredentialStatus,
  type ForgejoDirectory,
  type ForgejoExecutionCredentialRecord,
  type ForgejoStoredCredentialRecord,
  type ForgejoStoredExecutionCredentialRecord,
  type ForgejoWebhookSecretRecord,
} from "../providers/forgejo/instances.js";
import { FORGEJO_CREDENTIAL_ALG } from "../secrets/authenticated-envelope.js";

export function createSqlForgejoDirectory(runtime: QueryHandle): ForgejoDirectory {
  return {
    async insertInstance(record) {
      try {
        await runtime.query(
          `insert into forgejo_instances (
             id, canonical_origin, allow_private_network, external_identity, reported_version,
             status, approved_by_user_id, approved_at, last_health_at, last_health_error,
             created_at, updated_at
           ) values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)`,
          instanceValues(record),
        );
      } catch (error) {
        throw mapUnique(error, "forgejo_instances_canonical_origin_unique", "origin");
      }
    },
    async updateInstance(record) {
      await runtime.query(
        `update forgejo_instances
         set canonical_origin = $2, allow_private_network = $3, external_identity = $4::jsonb,
             reported_version = $5, status = $6, approved_by_user_id = $7, approved_at = $8,
             last_health_at = $9, last_health_error = $10, created_at = $11, updated_at = $12
         where id = $1`,
        instanceValues(record),
      );
    },
    async findInstanceById(id) {
      const rows = await runtime.query<InstanceRow>(`${INSTANCE_SELECT} where id = $1`, [id]);
      return mapInstance(rows.rows[0]);
    },
    async findInstanceByOrigin(origin) {
      const rows = await runtime.query<InstanceRow>(
        `${INSTANCE_SELECT} where canonical_origin = $1`,
        [origin],
      );
      return mapInstance(rows.rows[0]);
    },
    async listInstances() {
      const rows = await runtime.query<InstanceRow>(
        `${INSTANCE_SELECT} order by canonical_origin, id`,
      );
      return rows.rows.map((row) => mapInstance(row)!);
    },
    async insertConnection(record) {
      try {
        await runtime.query(
          `insert into forgejo_connections (
             id, organization_id, instance_id, slug, status, forgejo_user_id, forgejo_user_login,
             provider_application_id
           ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          connectionValues(record),
        );
      } catch (error) {
        throw mapUnique(error, undefined, "connection");
      }
    },
    async updateConnection(record) {
      await runtime.query(
        `update forgejo_connections
         set organization_id = $2, instance_id = $3, slug = $4, status = $5,
             forgejo_user_id = $6, forgejo_user_login = $7, provider_application_id = $8,
             updated_at = now()
         where id = $1`,
        connectionValues(record),
      );
    },
    async findConnectionById(id) {
      const rows = await runtime.query<ConnectionRow>(`${CONNECTION_SELECT} where id = $1`, [id]);
      return mapConnection(rows.rows[0]);
    },
    async listConnectionsForOrganization(organizationId) {
      const rows = await runtime.query<ConnectionRow>(
        `${CONNECTION_SELECT} where organization_id = $1 order by slug, id`,
        [organizationId],
      );
      return rows.rows.map((row) => mapConnection(row)!);
    },
    async insertCredential(record) {
      if (record.kind !== "connection") {
        throw new ForgejoContractError(
          "forgejo_scope_invalid",
          400,
          "only connection credentials may be persisted here",
        );
      }
      try {
        await runtime.query(
          `insert into forgejo_credentials (
             id, organization_id, connection_id, kind, alg, key_id, nonce, ciphertext,
             aad_version, scope_evidence, status
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
          [
            record.id,
            record.organizationId,
            record.connectionId,
            record.kind,
            record.alg,
            record.keyId,
            record.nonce,
            record.ciphertext,
            record.aadVersion,
            JSON.stringify(record.scopeEvidence),
            record.status,
          ],
        );
      } catch (error) {
        throw mapUnique(error, undefined, "credential");
      }
    },
    async findActiveConnectionCredential(connectionId) {
      const rows = await runtime.query<CredentialRow>(
        `${CREDENTIAL_SELECT} where connection_id = $1 and kind = 'connection' and status = 'active'`,
        [connectionId],
      );
      return mapConnectionCredential(rows.rows[0]);
    },
    async upsertRepository(record) {
      await runtime.query(
        `insert into forgejo_repositories (
           id, organization_id, connection_id, repository_id, full_name, owner_login, name,
           default_branch, html_url, enrolled, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         on conflict (connection_id, repository_id) do update set
           full_name = excluded.full_name,
           owner_login = excluded.owner_login,
           name = excluded.name,
           default_branch = excluded.default_branch,
           html_url = excluded.html_url,
           enrolled = excluded.enrolled,
           updated_at = now()`,
        [
          record.id,
          record.organizationId,
          record.connectionId,
          record.repositoryId,
          record.fullName,
          record.ownerLogin,
          record.name,
          record.defaultBranch,
          record.htmlUrl,
          record.enrolled,
        ],
      );
    },
    async listRepositoriesForConnection(connectionId) {
      const rows = await runtime.query<RepositoryRow>(
        `select id, organization_id, connection_id, repository_id, full_name, owner_login, name,
                default_branch, html_url, enrolled
         from forgejo_repositories
         where connection_id = $1
         order by full_name, id`,
        [connectionId],
      );
      return rows.rows.map(mapRepository);
    },
    async findActiveExecutionCredential(connectionId) {
      const rows = await runtime.query<CredentialRow>(
        `${CREDENTIAL_SELECT} where connection_id = $1 and kind = 'execution' and status = 'active'`,
        [connectionId],
      );
      return mapExecutionCredential(rows.rows[0]);
    },
    async insertExecutionCredential(record) {
      if (record.kind !== "execution") {
        throw new ForgejoContractError(
          "forgejo_scope_invalid",
          400,
          "only execution credentials may be persisted here",
        );
      }
      try {
        await insertStoredCredential(runtime, record);
      } catch (error) {
        throw mapUnique(error, undefined, "credential");
      }
    },
    async insertWebhookSecret(record) {
      if (record.kind !== "webhook_secret") {
        throw new ForgejoContractError(
          "forgejo_scope_invalid",
          400,
          "only webhook_secret credentials may be persisted here",
        );
      }
      try {
        await runtime.query(
          `insert into forgejo_credentials (
             id, organization_id, connection_id, kind, alg, key_id, nonce, ciphertext,
             aad_version, scope_evidence, status
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
          [
            record.id,
            record.organizationId,
            record.connectionId,
            record.kind,
            record.alg,
            record.keyId,
            record.nonce,
            record.ciphertext,
            record.aadVersion,
            JSON.stringify({}),
            record.status,
          ],
        );
      } catch (error) {
        throw mapUnique(error, undefined, "credential");
      }
    },
    async findActiveWebhookSecret(connectionId) {
      const rows = await runtime.query<CredentialRow>(
        `${CREDENTIAL_SELECT} where connection_id = $1 and kind = 'webhook_secret' and status = 'active'`,
        [connectionId],
      );
      return mapWebhookSecret(rows.rows[0]);
    },
    async listWebhookSecretsForConnection(connectionId) {
      const rows = await runtime.query<CredentialRow>(
        `${CREDENTIAL_SELECT} where connection_id = $1 and kind = 'webhook_secret' order by created_at, id`,
        [connectionId],
      );
      return rows.rows.flatMap((row) => {
        const secret = mapWebhookSecret(row);
        return secret === undefined ? [] : [secret];
      });
    },
    async listCredentialStatesForConnection(connectionId) {
      const rows = await runtime.query<CredentialRow>(
        `${CREDENTIAL_SELECT} where connection_id = $1 order by kind, created_at, id`,
        [connectionId],
      );
      return rows.rows.flatMap((row) => {
        const state = mapCredentialState(row);
        return state === undefined ? [] : [state];
      });
    },
    async replaceActiveCredential(input) {
      const values = credentialInsertValues(input.next);
      try {
        const result = await runtime.query<{ id: string }>(
          `with predecessor as (
             update forgejo_credentials
             set status = $2,
                 rotated_at = $3,
                 revoked_at = case when $2 = 'revoked' then $3 else revoked_at end
             where id = $1 and status = 'active'
             returning id
           )
           insert into forgejo_credentials (
             id, organization_id, connection_id, kind, alg, key_id, nonce, ciphertext,
             aad_version, scope_evidence, status, rotated_at
           )
           select $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15
           where ($1::uuid is null or exists (select 1 from predecessor))
           returning id`,
          [
            input.previousCredentialId,
            input.previousStatus,
            input.rotatedAt,
            ...values,
            input.next.rotatedAt ?? null,
          ],
        );
        if (result.rowCount === 0) {
          throw new ForgejoContractError(
            "forgejo_credential_unavailable",
            409,
            "Forgejo credential is unavailable",
          );
        }
      } catch (error) {
        if (error instanceof ForgejoContractError) throw error;
        throw mapUnique(error, undefined, "credential");
      }
    },
    async updateCredentialState(input) {
      const result = await runtime.query(
        `update forgejo_credentials
         set status = $2,
             rotated_at = coalesce($3, rotated_at),
             revoked_at = coalesce($4, revoked_at)
         where id = $1`,
        [input.credentialId, input.status, input.rotatedAt ?? null, input.revokedAt ?? null],
      );
      if (result.rowCount === 0) {
        throw new ForgejoContractError("not_found", 404, "Forgejo credential was not found");
      }
    },
    async upsertRepositoryHook(record) {
      await runtime.query(
        `insert into forgejo_repository_hooks (
           id, organization_id, connection_id, repository_id, forgejo_hook_id, callback_path,
           managed, status, last_verified_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (connection_id, repository_id) do update set
           forgejo_hook_id = excluded.forgejo_hook_id,
           callback_path = excluded.callback_path,
           managed = excluded.managed,
           status = excluded.status,
           last_verified_at = excluded.last_verified_at`,
        [
          record.id,
          record.organizationId,
          record.connectionId,
          record.repositoryId,
          record.forgejoHookId,
          record.callbackPath,
          record.managed,
          record.status,
          record.lastVerifiedAt,
        ],
      );
    },
    async findRepositoryHook(connectionId, repositoryId) {
      const rows = await runtime.query<HookRow>(
        `${HOOK_SELECT} where connection_id = $1 and repository_id = $2`,
        [connectionId, repositoryId],
      );
      return mapHook(rows.rows[0]);
    },
    async listRepositoryHooksForConnection(connectionId) {
      const rows = await runtime.query<HookRow>(
        `${HOOK_SELECT} where connection_id = $1 order by repository_id, id`,
        [connectionId],
      );
      return rows.rows.map((row) => mapHook(row)!);
    },
  };
}

const INSTANCE_SELECT = `select id, canonical_origin, allow_private_network, external_identity,
       reported_version, status, approved_by_user_id, approved_at, last_health_at,
       last_health_error, created_at, updated_at
 from forgejo_instances`;

const CONNECTION_SELECT = `select id, organization_id, instance_id, slug, status, forgejo_user_id,
       forgejo_user_login, provider_application_id
 from forgejo_connections`;

const CREDENTIAL_SELECT = `select id, organization_id, connection_id, kind, alg, key_id, nonce,
       ciphertext, aad_version, scope_evidence, status, created_at, rotated_at, revoked_at
 from forgejo_credentials`;

const HOOK_SELECT = `select id, organization_id, connection_id, repository_id, forgejo_hook_id,
       callback_path, managed, status, last_verified_at
 from forgejo_repository_hooks`;

interface InstanceRow extends QueryRow {
  id: string;
  canonical_origin: string;
  allow_private_network: boolean;
  external_identity: unknown;
  reported_version: string;
  status: ForgejoInstanceRecord["status"];
  approved_by_user_id: string | null;
  approved_at: Date | null;
  last_health_at: Date | null;
  last_health_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ConnectionRow extends QueryRow {
  id: string;
  organization_id: string;
  instance_id: string;
  slug: string;
  status: ForgejoConnectionRecord["status"];
  forgejo_user_id: number | string;
  forgejo_user_login: string;
  provider_application_id: string | null;
}

interface CredentialRow extends QueryRow {
  id: string;
  organization_id: string;
  connection_id: string;
  kind: string;
  alg: string;
  key_id: number;
  nonce: Buffer | Uint8Array;
  ciphertext: Buffer | Uint8Array;
  aad_version: number;
  scope_evidence: unknown;
  status: ForgejoCredentialStatus;
  created_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
}

interface RepositoryRow extends QueryRow {
  id: string;
  organization_id: string;
  connection_id: string;
  repository_id: number | string;
  full_name: string;
  owner_login: string;
  name: string;
  default_branch: string;
  html_url: string;
  enrolled: boolean;
}

interface HookRow extends QueryRow {
  id: string;
  organization_id: string;
  connection_id: string;
  repository_id: number | string;
  forgejo_hook_id: number | string | null;
  callback_path: string;
  managed: boolean;
  status: ForgejoRepositoryHookRecord["status"];
  last_verified_at: Date | null;
}

function instanceValues(record: ForgejoInstanceRecord): unknown[] {
  return [
    record.id,
    record.canonicalOrigin,
    record.allowPrivateNetwork,
    JSON.stringify(record.externalIdentity),
    record.reportedVersion,
    record.status,
    record.approvedByUserId,
    record.approvedAt,
    record.lastHealthAt,
    record.lastHealthError,
    record.createdAt,
    record.updatedAt,
  ];
}

function connectionValues(record: ForgejoConnectionRecord): unknown[] {
  return [
    record.id,
    record.organizationId,
    record.instanceId,
    record.slug,
    record.status,
    record.forgejoUserId,
    record.forgejoUserLogin,
    record.providerApplicationId,
  ];
}

function mapInstance(row: InstanceRow | undefined): ForgejoInstanceRecord | undefined {
  if (row === undefined) return undefined;
  return {
    id: row.id,
    canonicalOrigin: row.canonical_origin,
    allowPrivateNetwork: row.allow_private_network,
    externalIdentity: row.external_identity,
    reportedVersion: row.reported_version,
    status: row.status,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at,
    lastHealthAt: row.last_health_at,
    lastHealthError: row.last_health_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConnection(row: ConnectionRow | undefined): ForgejoConnectionRecord | undefined {
  if (row === undefined) return undefined;
  return {
    id: row.id,
    organizationId: row.organization_id,
    instanceId: row.instance_id,
    slug: row.slug,
    status: row.status,
    forgejoUserId: Number(row.forgejo_user_id),
    forgejoUserLogin: row.forgejo_user_login,
    providerApplicationId: row.provider_application_id,
  };
}

function mapConnectionCredential(
  row: CredentialRow | undefined,
): ForgejoCredentialRecord | undefined {
  if (row === undefined || row.kind !== "connection") return undefined;
  const evidence = jsonRecord(row.scope_evidence);
  const scopes = stringList(evidence["scopes"]);
  const repositoryIds = integerList(evidence["repositoryIds"]);
  return {
    id: row.id,
    organizationId: row.organization_id,
    connectionId: row.connection_id,
    kind: "connection",
    alg: row.alg,
    keyId: row.key_id,
    nonce: asBuffer(row.nonce),
    ciphertext: asBuffer(row.ciphertext),
    aadVersion: row.aad_version,
    scopeEvidence: { scopes, repositoryIds },
    status: row.status,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

function mapExecutionCredential(
  row: CredentialRow | undefined,
): ForgejoExecutionCredentialRecord | undefined {
  if (row === undefined || row.kind !== "execution") return undefined;
  const evidence = jsonRecord(row.scope_evidence);
  return {
    id: row.id,
    organizationId: row.organization_id,
    kind: "execution",
    status: row.status,
    envelope: {
      alg: FORGEJO_CREDENTIAL_ALG,
      keyId: row.key_id,
      nonce: asBuffer(row.nonce),
      ciphertext: asBuffer(row.ciphertext),
      aadVersion: 1,
    },
    scopeEvidence: {
      scopes: stringList(evidence["scopes"]),
      repositories: stringList(evidence["repositories"]),
    },
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

function mapWebhookSecret(row: CredentialRow | undefined): ForgejoWebhookSecretRecord | undefined {
  if (row === undefined || row.kind !== "webhook_secret") return undefined;
  return {
    id: row.id,
    organizationId: row.organization_id,
    connectionId: row.connection_id,
    kind: "webhook_secret",
    alg: row.alg,
    keyId: row.key_id,
    nonce: asBuffer(row.nonce),
    ciphertext: asBuffer(row.ciphertext),
    aadVersion: row.aad_version,
    status: row.status,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

function mapCredentialState(row: CredentialRow): ForgejoCredentialState | undefined {
  if (row.kind !== "connection" && row.kind !== "execution" && row.kind !== "webhook_secret") {
    return undefined;
  }
  return {
    id: row.id,
    connectionId: row.connection_id,
    kind: row.kind,
    keyId: row.key_id,
    status: row.status,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at,
  };
}

async function insertStoredCredential(
  runtime: QueryHandle,
  record: ForgejoStoredExecutionCredentialRecord,
): Promise<void> {
  const values = credentialInsertValues(record);
  await runtime.query(
    `insert into forgejo_credentials (
       id, organization_id, connection_id, kind, alg, key_id, nonce, ciphertext,
       aad_version, scope_evidence, status
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
    values,
  );
}

function credentialInsertValues(record: ForgejoStoredCredentialRecord): unknown[] {
  if (record.kind === "execution") {
    return [
      record.id,
      record.organizationId,
      record.connectionId,
      record.kind,
      record.envelope.alg,
      record.envelope.keyId,
      record.envelope.nonce,
      record.envelope.ciphertext,
      record.envelope.aadVersion,
      JSON.stringify(record.scopeEvidence),
      record.status,
    ];
  }
  return [
    record.id,
    record.organizationId,
    record.connectionId,
    record.kind,
    record.alg,
    record.keyId,
    record.nonce,
    record.ciphertext,
    record.aadVersion,
    JSON.stringify(record.kind === "connection" ? record.scopeEvidence : {}),
    record.status,
  ];
}

function mapHook(row: HookRow | undefined): ForgejoRepositoryHookRecord | undefined {
  if (row === undefined) return undefined;
  return {
    id: row.id,
    organizationId: row.organization_id,
    connectionId: row.connection_id,
    repositoryId: Number(row.repository_id),
    forgejoHookId: row.forgejo_hook_id === null ? null : Number(row.forgejo_hook_id),
    callbackPath: row.callback_path,
    managed: row.managed,
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
  };
}

function mapRepository(row: RepositoryRow): ForgejoRepositoryRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    connectionId: row.connection_id,
    repositoryId: Number(row.repository_id),
    fullName: row.full_name,
    ownerLogin: row.owner_login,
    name: row.name,
    defaultBranch: row.default_branch,
    htmlUrl: row.html_url,
    enrolled: row.enrolled,
  };
}

function mapUnique(error: unknown, constraint: string | undefined, kind: string): never {
  if (isUniqueViolation(error, constraint)) {
    if (kind === "origin") {
      throw new ForgejoContractError(
        "forgejo_origin_invalid",
        409,
        "Forgejo origin is already registered",
      );
    }
    throw new ForgejoContractError("forgejo_scope_invalid", 409, `Forgejo ${kind} already exists`);
  }
  throw error;
}

function isUniqueViolation(error: unknown, constraint: string | undefined): boolean {
  if (typeof error !== "object" || error === null) return false;
  const postgresError = error as { code?: unknown; constraint?: unknown };
  if (postgresError.code !== "23505") return false;
  return constraint === undefined || postgresError.constraint === constraint;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return [];
    items.push(entry);
  }
  return items;
}

function integerList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry)) return [];
    ids.push(entry);
  }
  return ids;
}

function asBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}
