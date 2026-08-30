import { randomUUID } from "node:crypto";
import type { ForgejoRepositoryIdentity } from "./client.js";
import type {
  ForgejoConnectionRecord,
  ForgejoInstanceRecord,
  ForgejoRepositoryRecord,
} from "../../db/types.js";
import {
  decryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import {
  asJsonRecord,
  ForgejoContractError,
  forgejoErrorResponse,
  forgejoRequest,
  originFromInstance,
  readJsonObject,
  requireOrganizationOwner,
  type ForgejoAccessResolver,
  type ForgejoDirectory,
  type ForgejoHttp,
} from "./instances.js";

export function publicRepository(repository: ForgejoRepositoryRecord): {
  id: string;
  connectionId: string;
  repositoryId: number;
  fullName: string;
  ownerLogin: string;
  name: string;
  defaultBranch: string;
  htmlUrl: string;
  enrolled: boolean;
} {
  return {
    id: repository.id,
    connectionId: repository.connectionId,
    repositoryId: repository.repositoryId,
    fullName: repository.fullName,
    ownerLogin: repository.ownerLogin,
    name: repository.name,
    defaultBranch: repository.defaultBranch,
    htmlUrl: repository.htmlUrl,
    enrolled: repository.enrolled,
  };
}

export async function listVisibleRepositories(
  http: ForgejoHttp,
  instance: ForgejoInstanceRecord,
  token: string,
): Promise<ForgejoRepositoryIdentity[]> {
  const origin = originFromInstance(instance);
  const collected: ForgejoRepositoryIdentity[] = [];
  let path: string | undefined = "/api/v1/repos/search?limit=50";
  while (path !== undefined) {
    const response = await forgejoRequest(http, origin, path, token);
    if (response.status !== 200) {
      throw new ForgejoContractError(
        "forgejo_identity_mismatch",
        400,
        "visible repositories could not be enumerated",
      );
    }
    collected.push(...parseSearchPage(await response.json()));
    path = nextPath(response.headers.get("link"), origin.origin);
  }
  return collected;
}

export async function persistVisibleRepositories(
  directory: ForgejoDirectory,
  organizationId: string,
  connectionId: string,
  visible: readonly ForgejoRepositoryIdentity[],
): Promise<ForgejoRepositoryRecord[]> {
  const existing = await directory.listRepositoriesForConnection(connectionId);
  const enrolledByForgejoId = new Map(
    existing.filter((row) => row.enrolled).map((row) => [row.repositoryId, row]),
  );
  const records: ForgejoRepositoryRecord[] = [];
  for (const repository of visible) {
    const previous = enrolledByForgejoId.get(repository.id);
    const record: ForgejoRepositoryRecord = {
      id: previous?.id ?? randomUUID(),
      organizationId,
      connectionId,
      repositoryId: repository.id,
      fullName: repository.fullName,
      ownerLogin: repository.ownerLogin,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
      htmlUrl: repository.htmlUrl,
      enrolled: previous?.enrolled ?? false,
    };
    await directory.upsertRepository(record);
    records.push(record);
  }
  return records;
}

export async function enrollRepositories(input: {
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
  organizationId: string;
  connectionId: string;
  repositoryIds: readonly number[];
}): Promise<{ connection: ForgejoConnectionRecord; repositories: ForgejoRepositoryRecord[] }> {
  const connection = await input.directory.findConnectionById(input.connectionId);
  if (connection === undefined || connection.organizationId !== input.organizationId) {
    throw new ForgejoContractError("not_found", 404, "Forgejo connection was not found");
  }
  if (connection.status !== "active") {
    throw new ForgejoContractError(
      "forgejo_credential_unavailable",
      409,
      "Forgejo connection is not active",
    );
  }
  const instance = await input.directory.findInstanceById(connection.instanceId);
  if (instance === undefined || instance.status !== "active") {
    throw new ForgejoContractError(
      "forgejo_origin_unapproved",
      400,
      "Forgejo instance is not approved",
    );
  }
  const credential = await input.directory.findActiveConnectionCredential(connection.id);
  if (credential === undefined) {
    throw new ForgejoContractError(
      "forgejo_credential_unavailable",
      409,
      "Forgejo connection credential is unavailable",
    );
  }
  const token = decryptSecret(
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
  const visible = await listVisibleRepositories(input.http, instance, token);
  const visibleIds = new Set(visible.map((repository) => repository.id));
  for (const repositoryId of input.repositoryIds) {
    if (!visibleIds.has(repositoryId)) {
      throw new ForgejoContractError(
        "forgejo_scope_invalid",
        400,
        "enrollment must be a subset of visible repositories",
      );
    }
  }
  const enrolled = new Set(input.repositoryIds);
  await persistVisibleRepositories(input.directory, input.organizationId, connection.id, visible);
  const current = await input.directory.listRepositoriesForConnection(connection.id);
  for (const repository of current) {
    await input.directory.upsertRepository({
      ...repository,
      enrolled: enrolled.has(repository.repositoryId),
    });
  }
  return {
    connection,
    repositories: await input.directory.listRepositoriesForConnection(connection.id),
  };
}

export async function handleForgejoRepositoriesRequest(
  request: Request,
  options: {
    access: ForgejoAccessResolver;
    directory: ForgejoDirectory;
    http: ForgejoHttp;
    secrets: SecretEncryptionKeySource;
  },
): Promise<Response> {
  try {
    const access = await options.access.resolve(request);
    const organizationId = requireOrganizationOwner(access);
    const url = new URL(request.url);
    const list = /^\/connections\/([^/]+)\/repositories$/u.exec(url.pathname);
    if (request.method === "GET" && list !== null && list[1] !== undefined) {
      const connection = await options.directory.findConnectionById(list[1]);
      if (connection === undefined || connection.organizationId !== organizationId) {
        throw new ForgejoContractError("not_found", 404, "Forgejo connection was not found");
      }
      const repositories = await options.directory.listRepositoriesForConnection(connection.id);
      return Response.json({ repositories: repositories.map(publicRepository) });
    }
    const enroll = /^\/connections\/([^/]+)\/repositories$/u.exec(url.pathname);
    if (request.method === "POST" && enroll !== null && enroll[1] !== undefined) {
      const body = await readJsonObject(request);
      const repositoryIds = body["repositoryIds"];
      if (
        !Array.isArray(repositoryIds) ||
        repositoryIds.some((entry) => typeof entry !== "number" || !Number.isInteger(entry))
      ) {
        throw new ForgejoContractError("forgejo_scope_invalid", 400, "repositoryIds are invalid");
      }
      const enrolled = await enrollRepositories({
        directory: options.directory,
        http: options.http,
        secrets: options.secrets,
        organizationId,
        connectionId: enroll[1],
        repositoryIds,
      });
      return Response.json({ repositories: enrolled.repositories.map(publicRepository) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return forgejoErrorResponse(error);
  }
}

function parseSearchPage(body: unknown): ForgejoRepositoryIdentity[] {
  const rows = searchRows(body);
  return rows.map(parseRepositoryIdentity);
}

function searchRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body === null || typeof body !== "object") {
    throw new ForgejoContractError("forgejo_identity_mismatch", 400, "search response is invalid");
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new ForgejoContractError("forgejo_identity_mismatch", 400, "search response is invalid");
  }
  return data;
}

function parseRepositoryIdentity(value: unknown): ForgejoRepositoryIdentity {
  const record = asJsonRecord(value, "forgejo_identity_mismatch", "repository response is invalid");
  const ownerLogin = repositoryOwnerLogin(record["owner"]);
  const id = record["id"];
  const name = record["name"];
  const fullName = record["full_name"];
  const defaultBranch = record["default_branch"];
  const htmlUrl = record["html_url"];
  if (
    typeof id !== "number" ||
    typeof name !== "string" ||
    typeof fullName !== "string" ||
    typeof defaultBranch !== "string" ||
    typeof htmlUrl !== "string" ||
    ownerLogin === undefined
  ) {
    throw new ForgejoContractError(
      "forgejo_identity_mismatch",
      400,
      "repository response is invalid",
    );
  }
  return { id, ownerLogin, name, fullName, defaultBranch, htmlUrl };
}

function repositoryOwnerLogin(owner: unknown): string | undefined {
  if (typeof owner === "string") return owner;
  if (owner === null || typeof owner !== "object") return undefined;
  const login = (owner as { login?: unknown }).login;
  return typeof login === "string" ? login : undefined;
}

function nextPath(linkHeader: string | null, origin: string): string | undefined {
  if (linkHeader === null || linkHeader.length === 0) return undefined;
  for (const part of linkHeader.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/u.exec(part);
    if (match === null || match[1] === undefined) continue;
    const next = new URL(match[1], origin);
    if (next.origin !== origin) {
      throw new ForgejoContractError(
        "forgejo_origin_unapproved",
        400,
        "pagination left the approved origin",
      );
    }
    return `${next.pathname}${next.search}`;
  }
  return undefined;
}
