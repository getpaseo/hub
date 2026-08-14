import jwt from "jsonwebtoken";
import { z } from "zod";
import type {
  ProviderApplicationConfiguration,
  ProviderApplicationIdentity,
  ProviderApplicationVerifier,
} from "../index.js";
import { ProviderVerificationError } from "../index.js";

const githubIdentitySchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
});
const discordIdentitySchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  bot: z.literal(true),
});
const DEFAULT_TIMEOUT_MS = 8_000;

/** @package */
export function createProviderApplicationVerifier(
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): ProviderApplicationVerifier {
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    verify(provider, configuration) {
      if (provider !== configuration.provider) {
        return Promise.reject(new ProviderVerificationError("credentialsRejected"));
      }
      if (configuration.provider === "github") {
        return verifyGitHub(configuration, request, now, timeoutMs);
      }
      if (configuration.provider === "discord") {
        return verifyDiscord(configuration, request, timeoutMs);
      }
      // Slack client credentials have no honest verification endpoint. They are verified only
      // by the OAuth installation callback, where the returned bot token is tested.
      return Promise.reject(new ProviderVerificationError("credentialsRejected"));
    },
  };
}

async function verifyGitHub(
  configuration: Extract<ProviderApplicationConfiguration, { provider: "github" }>,
  request: typeof fetch,
  now: () => number,
  timeoutMs: number,
): Promise<ProviderApplicationIdentity> {
  let token: string;
  try {
    const nowSeconds = Math.floor(now() / 1000);
    token = jwt.sign(
      { iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: configuration.appId },
      configuration.privateKey,
      { algorithm: "RS256" },
    );
  } catch {
    throw new ProviderVerificationError("credentialsRejected");
  }
  const response = await fixedRequest(
    request,
    "https://api.github.com/app",
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
    timeoutMs,
  );
  if (response.status === 401 || response.status === 403) {
    throw new ProviderVerificationError("credentialsRejected");
  }
  if (!response.ok) throw new ProviderVerificationError("unreachable");
  const parsed = githubIdentitySchema.safeParse(await safeJson(response));
  if (!parsed.success || String(parsed.data.id) !== configuration.appId) {
    throw new ProviderVerificationError("credentialsRejected");
  }
  return {
    provider: "github",
    id: String(parsed.data.id),
    name: parsed.data.name,
    ownerLogin: parsed.data.owner.login,
  };
}

async function verifyDiscord(
  configuration: Extract<ProviderApplicationConfiguration, { provider: "discord" }>,
  request: typeof fetch,
  timeoutMs: number,
): Promise<ProviderApplicationIdentity> {
  const response = await fixedRequest(
    request,
    "https://discord.com/api/v10/users/@me",
    { headers: { authorization: `Bot ${configuration.botToken}` } },
    timeoutMs,
  );
  if (response.status === 401 || response.status === 403) {
    throw new ProviderVerificationError("credentialsRejected");
  }
  if (!response.ok) throw new ProviderVerificationError("unreachable");
  const parsed = discordIdentitySchema.safeParse(await safeJson(response));
  if (!parsed.success || parsed.data.id !== configuration.applicationId) {
    throw new ProviderVerificationError("credentialsRejected");
  }
  return {
    provider: "discord",
    id: parsed.data.id,
    name: parsed.data.username,
  };
}

async function fixedRequest(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await request(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ProviderVerificationError("unreachable");
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
