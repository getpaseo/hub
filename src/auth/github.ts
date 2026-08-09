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

export interface GitHubAppBotIdentity {
  id: number;
  login: string;
}

export interface GitHubInstallationAccessToken {
  token: string;
  expiresAt: number;
}

export type GitHubAppPermissionLevel = "read" | "write" | "admin";

const InstallationTokenResponseSchema = z
  .object({
    token: z.string(),
    expires_at: z.string(),
  })
  .passthrough();
const GitHubAppBotIdentitySchema = z.object({ id: z.number().int().positive(), login: z.string() });

export interface GitHubAuth {
  getInstallation(installationId: number): Promise<GitHubInstallation | undefined>;
  getInstallationToken(installationId: number): Promise<string>;
  mintInstallationToken(installationId: number): Promise<string>;
  mintInstallationAccessToken(input: {
    installationId: number;
    repositories: readonly string[];
    permissions: Readonly<Record<string, GitHubAppPermissionLevel>>;
  }): Promise<GitHubInstallationAccessToken>;
  getAppBotIdentity(appSlug: string): Promise<GitHubAppBotIdentity>;
  revokeInstallationToken(token: string): Promise<void>;
  createInstallationOctokit(installationId: number): Promise<Octokit>;
}

interface CreateGitHubAuthOptions {
  appId?: string;
  privateKey?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export function createGitHubAuth(options: CreateGitHubAuthOptions = {}): GitHubAuth {
  const installationTokenCache = new Map<number, InstallationTokenCacheEntry>();
  const appBotIdentityCache = new Map<string, Promise<GitHubAppBotIdentity>>();
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

  async function mintInstallationAccessToken(input: {
    installationId: number;
    repositories: readonly string[];
    permissions: Readonly<Record<string, GitHubAppPermissionLevel>>;
  }): Promise<GitHubInstallationAccessToken> {
    const data = await requestInstallationToken(input.installationId, {
      repositories: input.repositories.map(repositoryName),
      permissions: { ...input.permissions },
    });
    logger.debug(
      { installationId: input.installationId, expiresAt: data.expires_at },
      "minted scoped installation token",
    );
    return { token: data.token, expiresAt: new Date(data.expires_at).getTime() };
  }

  async function revokeInstallationToken(token: string): Promise<void> {
    const octokit = new Octokit({
      auth: token,
      ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
    });
    await octokit.request("DELETE /installation/token");
  }

  async function getAppBotIdentity(appSlug: string): Promise<GitHubAppBotIdentity> {
    const cached = appBotIdentityCache.get(appSlug);
    if (cached !== undefined) return cached;
    const pending = (async () => {
      const octokit = await getAppOctokit();
      const response = await octokit.request("GET /users/{username}", {
        username: `${appSlug}[bot]`,
      });
      return GitHubAppBotIdentitySchema.parse(response.data);
    })();
    appBotIdentityCache.set(appSlug, pending);
    try {
      return await pending;
    } catch (error) {
      if (appBotIdentityCache.get(appSlug) === pending) appBotIdentityCache.delete(appSlug);
      throw error;
    }
  }

  async function requestInstallationToken(
    installationId: number,
    restrictions?: {
      repositories: readonly string[];
      permissions: Readonly<Record<string, GitHubAppPermissionLevel>>;
    },
  ) {
    const octokit = await getAppOctokit();
    const response = await octokit.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationId,
        ...(restrictions === undefined
          ? {}
          : {
              repositories: [...restrictions.repositories],
              permissions: { ...restrictions.permissions },
            }),
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
    mintInstallationAccessToken,
    getAppBotIdentity,
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
