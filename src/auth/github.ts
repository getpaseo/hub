import { readFile } from "node:fs/promises";
import jwt from "jsonwebtoken";
import { Octokit } from "octokit";
import { z } from "zod";
import { logger } from "../logger.js";
import { GitHubInstallationSchema } from "./github-events.js";
import type { GitHubInstallation } from "./github-events.js";

interface InstallationTokenCacheEntry {
  expiresAt: number;
  token: string;
}

const InstallationTokenResponseSchema = z
  .object({
    token: z.string(),
    expires_at: z.string(),
  })
  .passthrough();

export interface GitHubAuth {
  getInstallation(installationId: number): Promise<GitHubInstallation | undefined>;
  getInstallationToken(installationId: number): Promise<string>;
  mintInstallationToken(installationId: number): Promise<string>;
  createInstallationOctokit(installationId: number): Promise<Octokit>;
}

export interface GitHubExecutionTokenAuth {
  mintExecutionToken(input: { installationId: number; repository: string }): Promise<string>;
  revokeInstallationToken(token: string): Promise<void>;
}

interface CreateGitHubAuthOptions {
  appId?: string;
  privateKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export function createGitHubAuth(
  options: CreateGitHubAuthOptions = {},
): GitHubAuth & GitHubExecutionTokenAuth {
  const installationTokenCache = new Map<number, InstallationTokenCacheEntry>();
  let cachedPrivateKey: string | null = null;
  const now = options.now ?? Date.now;

  async function getInstallation(installationId: number): Promise<GitHubInstallation | undefined> {
    const octokit = await getAppOctokit();
    try {
      const response = await octokit.request("GET /app/installations/{installation_id}", {
        installation_id: installationId,
      });
      return GitHubInstallationSchema.parse(response.data);
    } catch (error) {
      if (hasHttpStatus(error, 404)) return undefined;
      throw error;
    }
  }

  async function getInstallationToken(installationId: number): Promise<string> {
    const cachedEntry = installationTokenCache.get(installationId);
    const refreshWindowMs = 60_000;

    if (cachedEntry !== undefined && cachedEntry.expiresAt - refreshWindowMs > now()) {
      return cachedEntry.token;
    }

    const data = await requestInstallationToken(installationId);

    installationTokenCache.set(installationId, {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    });

    logger.debug({ installationId, expiresAt: data.expires_at }, "refreshed installation token");

    return data.token;
  }

  async function mintInstallationToken(installationId: number): Promise<string> {
    const data = await requestInstallationToken(installationId);
    logger.debug({ installationId, expiresAt: data.expires_at }, "minted installation token");
    return data.token;
  }

  async function mintExecutionToken(input: {
    installationId: number;
    repository: string;
  }): Promise<string> {
    const octokit = await getAppOctokit();
    const response = await octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: input.installationId,
        repositories: [repositoryName(input.repository)],
        permissions: {
          contents: "write",
          pull_requests: "write",
          issues: "write",
        },
      },
    );
    const data = InstallationTokenResponseSchema.parse(response.data);
    logger.debug(
      { installationId: input.installationId, expiresAt: data.expires_at },
      "minted execution installation token",
    );
    return data.token;
  }

  async function revokeInstallationToken(token: string): Promise<void> {
    const octokit = new Octokit({
      auth: token,
      ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
    });
    await octokit.request("DELETE /installation/token");
  }

  async function requestInstallationToken(installationId: number) {
    const octokit = await getAppOctokit();
    const response = await octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationId,
      },
    );
    return InstallationTokenResponseSchema.parse(response.data);
  }

  async function createInstallationOctokit(installationId: number): Promise<Octokit> {
    const token = await getInstallationToken(installationId);

    return new Octokit({ auth: token });
  }

  async function getAppOctokit(): Promise<Octokit> {
    const jwtToken = await createAppJwt();

    return new Octokit({
      auth: jwtToken,
      ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
    });
  }

  async function createAppJwt(): Promise<string> {
    const appId = options.appId ?? getAppId();
    const privateKey = await getPrivateKey();
    const nowSeconds = Math.floor(now() / 1000);

    return jwt.sign(
      {
        iat: nowSeconds - 60,
        exp: nowSeconds + 10 * 60,
        iss: appId,
      },
      privateKey,
      {
        algorithm: "RS256",
      },
    );
  }

  async function getPrivateKey(): Promise<string> {
    if (cachedPrivateKey !== null) {
      return cachedPrivateKey;
    }

    const inlineKey = options.privateKey ?? process.env["GITHUB_APP_PRIVATE_KEY"];

    if (inlineKey !== undefined && inlineKey.length > 0) {
      cachedPrivateKey = inlineKey;
      return cachedPrivateKey;
    }

    cachedPrivateKey = await readFile(getPrivateKeyPath(), "utf8");

    return cachedPrivateKey;
  }

  return {
    getInstallation,
    getInstallationToken,
    mintInstallationToken,
    mintExecutionToken,
    revokeInstallationToken,
    createInstallationOctokit,
  };
}

function repositoryName(repository: string): string {
  const parts = repository.split("/");
  const name = parts.length === 2 ? parts[1] : undefined;
  if (name === undefined || name.length === 0)
    throw new Error(`invalid GitHub repository: ${repository}`);
  return name;
}

function hasHttpStatus(error: unknown, status: number): boolean {
  if (error === null || typeof error !== "object") return false;
  return Reflect.get(error, "status") === status;
}

function getAppId(): string {
  const appId = process.env["GITHUB_APP_ID"];

  if (appId === undefined || appId.length === 0) {
    throw new Error("GITHUB_APP_ID is required");
  }

  return appId;
}

function getPrivateKeyPath(): string {
  const privateKeyPath = process.env["GITHUB_APP_PRIVATE_KEY_PATH"];

  if (privateKeyPath === undefined || privateKeyPath.length === 0) {
    throw new Error("GITHUB_APP_PRIVATE_KEY_PATH is required");
  }

  return privateKeyPath;
}
