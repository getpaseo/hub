import { rejectRedirectStatus } from "../../http/approved-origin.js";
import {
  ForgejoAuthorityError,
  normalizeForgejoRepositoryName,
  type ForgejoPermissionLevel,
} from "../../config/forgejo-authority.js";
import type { ForgejoContentsClient, ForgejoIssuesClient } from "./client.js";

export interface ForgejoOutcomeGrant {
  repositories: readonly string[];
  contents: ForgejoPermissionLevel;
  issues: ForgejoPermissionLevel;
}

export interface ForgejoOutcomeClient extends ForgejoContentsClient, ForgejoIssuesClient {}

export interface CreateForgejoOutcomeClientOptions {
  origin: string;
  token: string;
  grant: ForgejoOutcomeGrant;
  fetch?: typeof fetch;
}

export function createForgejoOutcomeClient(
  options: CreateForgejoOutcomeClientOptions,
): ForgejoOutcomeClient {
  const origin = canonicalOrigin(options.origin);
  const request = options.fetch ?? fetch;
  return {
    async readFile(input) {
      assertRepositoryGranted(options.grant, input.owner, input.repo);
      assertContentsLevel(options.grant, "read");
      const path = `/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodePath(input.path)}`;
      const url = new URL(path, origin);
      if (input.ref !== undefined) url.searchParams.set("ref", input.ref);
      const response = await forgejoRequest(request, origin, options.token, url, { method: "GET" });
      if (response.status === 404) return undefined;
      const body = await readJson(response);
      return {
        sha: requiredString(body, "sha"),
        content: requiredString(body, "content"),
        encoding: requiredString(body, "encoding"),
      };
    },
    async createFile(input) {
      assertRepositoryGranted(options.grant, input.owner, input.repo);
      assertContentsLevel(options.grant, "write");
      const url = contentsUrl(origin, input.owner, input.repo, input.path);
      const response = await forgejoRequest(request, origin, options.token, url, {
        method: "POST",
        body: JSON.stringify({
          content: Buffer.from(input.content, "utf8").toString("base64"),
          message: input.message,
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.newBranch === undefined ? {} : { new_branch: input.newBranch }),
        }),
      });
      const body = await readJson(response);
      return { sha: contentSha(body) };
    },
    async updateFile(input) {
      assertRepositoryGranted(options.grant, input.owner, input.repo);
      assertContentsLevel(options.grant, "write");
      const url = contentsUrl(origin, input.owner, input.repo, input.path);
      const response = await forgejoRequest(request, origin, options.token, url, {
        method: "PUT",
        body: JSON.stringify({
          content: Buffer.from(input.content, "utf8").toString("base64"),
          message: input.message,
          sha: input.sha,
          ...(input.branch === undefined ? {} : { branch: input.branch }),
        }),
      });
      const body = await readJson(response);
      return { sha: contentSha(body) };
    },
    async createIssueComment(input) {
      assertRepositoryGranted(options.grant, input.owner, input.repo);
      assertIssuesLevel(options.grant, "write");
      const url = new URL(
        `/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${String(input.index)}/comments`,
        origin,
      );
      const response = await forgejoRequest(request, origin, options.token, url, {
        method: "POST",
        body: JSON.stringify({ body: input.body }),
      });
      const body = await readJson(response);
      return { id: requiredNumber(body, "id") };
    },
    async createIssueReaction(input) {
      assertRepositoryGranted(options.grant, input.owner, input.repo);
      assertIssuesLevel(options.grant, "write");
      const url = new URL(
        `/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/${String(input.index)}/reactions`,
        origin,
      );
      await forgejoRequest(request, origin, options.token, url, {
        method: "POST",
        body: JSON.stringify({ content: input.content }),
      });
    },
    async createCommentReaction(input) {
      assertRepositoryGranted(options.grant, input.owner, input.repo);
      assertIssuesLevel(options.grant, "write");
      const url = new URL(
        `/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/comments/${String(input.commentId)}/reactions`,
        origin,
      );
      await forgejoRequest(request, origin, options.token, url, {
        method: "POST",
        body: JSON.stringify({ content: input.content }),
      });
    },
  };
}

function canonicalOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ForgejoAuthorityError(
      "forgejo_connection_unavailable",
      "Forgejo instance origin is unavailable",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new ForgejoAuthorityError(
      "forgejo_connection_unavailable",
      "Forgejo instance origin must be https",
    );
  }
  return parsed.origin;
}

function contentsUrl(origin: string, owner: string, repo: string, path: string): URL {
  return new URL(
    `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`,
    origin,
  );
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function assertRepositoryGranted(grant: ForgejoOutcomeGrant, owner: string, repo: string): void {
  const fullName = `${owner}/${repo}`;
  const allowed = grant.repositories.some(
    (repository) =>
      normalizeForgejoRepositoryName(repository) === normalizeForgejoRepositoryName(fullName),
  );
  if (!allowed) {
    throw new ForgejoAuthorityError(
      "forgejo_repository_unenrolled",
      "Forgejo outcome repository is outside the granted authority",
    );
  }
}

function assertContentsLevel(grant: ForgejoOutcomeGrant, required: ForgejoPermissionLevel): void {
  if (required === "read") return;
  if (grant.contents !== "write") {
    throw new ForgejoAuthorityError(
      "forgejo_scope_invalid",
      "Forgejo contents write exceeds the granted step authority",
    );
  }
}

function assertIssuesLevel(grant: ForgejoOutcomeGrant, required: ForgejoPermissionLevel): void {
  if (required === "read") return;
  if (grant.issues !== "write") {
    throw new ForgejoAuthorityError(
      "forgejo_scope_invalid",
      "Forgejo issues write exceeds the granted step authority",
    );
  }
}

async function forgejoRequest(
  request: typeof fetch,
  origin: string,
  token: string,
  url: URL,
  init: { method: string; body?: string },
): Promise<Response> {
  if (url.origin !== origin) {
    throw new ForgejoAuthorityError(
      "forgejo_connection_unavailable",
      "Forgejo instance origin is unavailable",
    );
  }
  const response = await request(url, {
    method: init.method,
    redirect: "manual",
    headers: {
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      authorization: `token ${token}`,
    },
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  rejectRedirectStatus(response.status);
  if (response.ok) return response;
  throw outcomeStatusError(response.status);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return recordFromUnknown(await response.json());
}

function contentSha(body: Record<string, unknown>): string {
  const content = body["content"];
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    return requiredString(recordFromUnknown(content), "sha");
  }
  return requiredString(body, "sha");
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ForgejoAuthorityError(
      "forgejo_credential_unavailable",
      "Forgejo outcome response is invalid",
    );
  }
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return record;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ForgejoAuthorityError(
      "forgejo_credential_unavailable",
      "Forgejo outcome response is invalid",
    );
  }
  return value;
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ForgejoAuthorityError(
      "forgejo_credential_unavailable",
      "Forgejo outcome response is invalid",
    );
  }
  return value;
}

function outcomeStatusError(status: number): ForgejoAuthorityError {
  if (status === 401 || status === 403) {
    return new ForgejoAuthorityError(
      "forgejo_scope_invalid",
      "Forgejo outcome is denied by the execution credential",
    );
  }
  if (status === 404) {
    return new ForgejoAuthorityError(
      "forgejo_repository_unenrolled",
      "Forgejo outcome subject is unavailable",
    );
  }
  return new ForgejoAuthorityError(
    "forgejo_credential_unavailable",
    "Forgejo outcome request failed",
  );
}
