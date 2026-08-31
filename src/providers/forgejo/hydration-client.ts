import {
  decryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import type { ForgejoHydrationClient } from "../../triggers/forgejo/hydration.js";
import {
  ForgejoContractError,
  forgejoRequest,
  originFromInstance,
  type ForgejoDirectory,
  type ForgejoHttp,
} from "./instances.js";

export function createForgejoHydrationClient(options: {
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
}): ForgejoHydrationClient {
  return {
    async listSubjects(input) {
      const resolved = await repository(options, input.connectionId, input.owner, input.repo);
      const type = input.kind === "issue" ? "issues" : "pulls";
      const indexes: number[] = [];
      for (let page = 1; ; page += 1) {
        const response = await forgejoRequest(
          options.http,
          resolved.origin,
          `/api/v1/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.name)}/issues?state=all&type=${type}&limit=50&page=${String(page)}`,
          resolved.token,
        );
        if (!response.ok) {
          throw new Error(`Forgejo issue list request failed (${String(response.status)})`);
        }
        const rows = readList(await response.json());
        for (const row of rows) {
          const index = subjectIndex(row);
          if (index !== undefined) indexes.push(index);
        }
        if (rows.length < 50) break;
      }
      return indexes;
    },
    async listTimeline(input) {
      const resolved = await repository(options, input.connectionId, input.owner, input.repo);
      const response = await forgejoRequest(
        options.http,
        resolved.origin,
        `/api/v1/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.name)}/issues/${String(input.index)}/timeline`,
        resolved.token,
      );
      if (!response.ok) {
        throw new Error(`Forgejo timeline request failed (${String(response.status)})`);
      }
      return readList(await response.json());
    },
    async listReviews(input) {
      const resolved = await repository(options, input.connectionId, input.owner, input.repo);
      const response = await forgejoRequest(
        options.http,
        resolved.origin,
        `/api/v1/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.name)}/pulls/${String(input.index)}/reviews`,
        resolved.token,
      );
      if (!response.ok) {
        throw new Error(`Forgejo reviews request failed (${String(response.status)})`);
      }
      return readList(await response.json());
    },
    async listReviewComments(input) {
      const resolved = await repository(options, input.connectionId, input.owner, input.repo);
      const response = await forgejoRequest(
        options.http,
        resolved.origin,
        `/api/v1/repos/${encodeURIComponent(resolved.owner)}/${encodeURIComponent(resolved.name)}/pulls/${String(input.index)}/reviews/${String(input.reviewId)}/comments`,
        resolved.token,
      );
      if (!response.ok) {
        throw new Error(`Forgejo review-comment request failed (${String(response.status)})`);
      }
      return readList(await response.json());
    },
  };
}

async function repository(
  options: {
    directory: ForgejoDirectory;
    secrets: SecretEncryptionKeySource;
  },
  connectionId: string,
  owner: string,
  repo: string,
) {
  const connection = await options.directory.findConnectionById(connectionId);
  if (connection === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo connection is unavailable");
  }
  const instance = await options.directory.findInstanceById(connection.instanceId);
  if (instance === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo instance is unavailable");
  }
  const credential = await options.directory.findActiveConnectionCredential(connectionId);
  if (credential === undefined) {
    throw new ForgejoContractError(
      "forgejo_credential_unavailable",
      409,
      "Forgejo connection credential is unavailable",
    );
  }
  return {
    origin: originFromInstance(instance),
    owner,
    name: repo,
    token: decryptSecret(
      options.secrets,
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
    ),
  };
}

function readList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function subjectIndex(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const number = value["number"];
  if (typeof number === "number" && Number.isFinite(number)) return number;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
