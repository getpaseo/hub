import jwt from "jsonwebtoken";
import { z } from "zod";
import {
  CHAT_BOT_SCOPE,
  PUBSUB_SCOPE,
  GoogleAccessTokenError,
  GoogleServiceAccountValidationError,
  createGoogleAccessTokenSource,
  parseGoogleServiceAccountJson,
  type GoogleServiceAccountCredentials,
} from "../../providers/google-chat/auth.js";
import { GOOGLE_CHAT_API_BASE_URL } from "../../triggers/google-chat/client.js";
import {
  GOOGLE_PUBSUB_API_BASE_URL,
  isValidPubSubSubscriptionName,
  normalizePubSubSubscriptionName,
} from "../../triggers/google-chat/pubsub.js";
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
const discordTokenSchema = z.object({ access_token: z.string().min(1) });
const pubsubIamPermissionsSchema = z.object({ permissions: z.array(z.string()).optional() });
const PUBSUB_CONSUME_PERMISSION = "pubsub.subscriptions.consume";
const DEFAULT_TIMEOUT_MS = 8_000;
const DISCORD_API = "https://discord.com/api/v10";

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
      if (configuration.provider === "google-chat") {
        return verifyGoogleChat(configuration, request, now, timeoutMs);
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
    throw new ProviderVerificationError("credentialsRejected", undefined, {
      subject: "privateKey",
    });
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
    throw new ProviderVerificationError("credentialsRejected", response.status, {
      subject: "privateKey",
    });
  }
  rejectFailedResponse(response);
  const body = await safeJson(response);
  if (body === undefined) throw new ProviderVerificationError("invalidResponse", response.status);
  const parsed = githubIdentitySchema.safeParse(body);
  if (!parsed.success) throw new ProviderVerificationError("invalidResponse", response.status);
  // The key authenticated an App, just not the one the operator named. That is a different
  // problem from a key GitHub refused, and it gets a different answer.
  if (String(parsed.data.id) !== configuration.appId) {
    throw new ProviderVerificationError("credentialsRejected", undefined, {
      subject: "identityMismatch",
    });
  }
  return {
    provider: "github",
    id: String(parsed.data.id),
    name: parsed.data.name,
    ownerLogin: parsed.data.owner.login,
  };
}

/**
 * Two proofs, because Discord splits its credentials across two portal pages. The bot token
 * proves the bot and names the application; the client credentials grant proves the Client
 * Secret the connection flow will later need. Verifying only the first would let the surface
 * claim "Verified" for an application that cannot complete a single authorization.
 */
async function verifyDiscord(
  configuration: Extract<ProviderApplicationConfiguration, { provider: "discord" }>,
  request: typeof fetch,
  timeoutMs: number,
): Promise<ProviderApplicationIdentity> {
  const identity = await verifyDiscordBot(configuration, request, timeoutMs);
  await verifyDiscordClientSecret(configuration, request, timeoutMs);
  return identity;
}

async function verifyDiscordBot(
  configuration: Extract<ProviderApplicationConfiguration, { provider: "discord" }>,
  request: typeof fetch,
  timeoutMs: number,
): Promise<ProviderApplicationIdentity> {
  const response = await fixedRequest(
    request,
    `${DISCORD_API}/users/@me`,
    { headers: { authorization: `Bot ${configuration.botToken}` } },
    timeoutMs,
  );
  if (response.status === 401 || response.status === 403) {
    throw new ProviderVerificationError("credentialsRejected", response.status, {
      subject: "botToken",
    });
  }
  rejectFailedResponse(response);
  const body = await safeJson(response);
  if (body === undefined) throw new ProviderVerificationError("invalidResponse", response.status);
  const parsed = discordIdentitySchema.safeParse(body);
  if (!parsed.success) throw new ProviderVerificationError("invalidResponse", response.status);
  if (parsed.data.id !== configuration.applicationId) {
    throw new ProviderVerificationError("credentialsRejected", undefined, {
      subject: "identityMismatch",
    });
  }
  return { provider: "discord", id: parsed.data.id, name: parsed.data.username };
}

/**
 * Discord's documented client credentials grant, the one exchange that can answer "is this
 * Client Secret real?" without a user present. It mints a bearer token for the app owner, so
 * the token is revoked immediately — a check should not leave credentials lying around. Team
 * applications are limited to `identify`, which is why that is the scope asked for.
 */
async function verifyDiscordClientSecret(
  configuration: Extract<ProviderApplicationConfiguration, { provider: "discord" }>,
  request: typeof fetch,
  timeoutMs: number,
): Promise<void> {
  const authorization = `Basic ${Buffer.from(
    `${configuration.applicationId}:${configuration.clientSecret}`,
  ).toString("base64")}`;
  const response = await fixedRequest(
    request,
    `${DISCORD_API}/oauth2/token`,
    {
      method: "POST",
      headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: "identify",
      }).toString(),
    },
    timeoutMs,
  );
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new ProviderVerificationError("credentialsRejected", response.status, {
      subject: "clientSecret",
    });
  }
  rejectFailedResponse(response);
  const body = await safeJson(response);
  if (body === undefined) throw new ProviderVerificationError("invalidResponse", response.status);
  const parsed = discordTokenSchema.safeParse(body);
  if (!parsed.success) throw new ProviderVerificationError("invalidResponse", response.status);
  await revokeDiscordToken(request, authorization, parsed.data.access_token, timeoutMs);
}

/** Best effort. The secret is already proven; a token Discord will expire anyway is not a failure. */
async function revokeDiscordToken(
  request: typeof fetch,
  authorization: string,
  token: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await request(`${DISCORD_API}/oauth2/token/revoke`, {
      method: "POST",
      headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return;
  }
}

async function verifyGoogleChat(
  configuration: Extract<ProviderApplicationConfiguration, { provider: "google-chat" }>,
  request: typeof fetch,
  now: () => number,
  timeoutMs: number,
): Promise<ProviderApplicationIdentity> {
  let credentials: GoogleServiceAccountCredentials;
  try {
    credentials = parseGoogleServiceAccountJson(configuration.serviceAccountJson);
  } catch (cause) {
    throw new ProviderVerificationError("credentialsRejected", undefined, {
      subject: "serviceAccountJson",
      cause,
    });
  }
  if (credentials.projectId !== configuration.projectId) {
    throw new ProviderVerificationError("credentialsRejected", undefined, {
      subject: "identityMismatch",
    });
  }
  await verifyGoogleChatBotAccess(credentials, request, now, timeoutMs);
  if (configuration.transport === "pubsub") {
    await verifyGoogleChatPubSubAccess(
      credentials,
      configuration.subscription,
      request,
      now,
      timeoutMs,
    );
  }
  return {
    provider: "google-chat",
    id: configuration.projectId,
    name: configuration.appName,
    clientEmail: credentials.clientEmail,
  };
}

async function verifyGoogleChatBotAccess(
  credentials: GoogleServiceAccountCredentials,
  request: typeof fetch,
  now: () => number,
  timeoutMs: number,
): Promise<void> {
  const token = await mintGoogleToken(credentials, [CHAT_BOT_SCOPE], request, now, timeoutMs);
  const response = await fixedRequest(
    request,
    `${GOOGLE_CHAT_API_BASE_URL}/v1/spaces?pageSize=1`,
    { headers: { authorization: `Bearer ${token}` } },
    timeoutMs,
  );
  if (response.status === 401) {
    throw new ProviderVerificationError("credentialsRejected", response.status, {
      subject: "serviceAccountJson",
    });
  }
  if (response.status === 403) {
    throw new ProviderVerificationError("permissionMissing", response.status, {
      subject: "serviceAccountJson",
    });
  }
  rejectFailedResponse(response);
}

async function verifyGoogleChatPubSubAccess(
  credentials: GoogleServiceAccountCredentials,
  subscription: string,
  request: typeof fetch,
  now: () => number,
  timeoutMs: number,
): Promise<void> {
  const normalized = normalizePubSubSubscriptionName(credentials.projectId, subscription);
  if (!isValidPubSubSubscriptionName(normalized)) {
    throw new ProviderVerificationError("credentialsRejected", undefined, {
      subject: "pubsubSubscription",
    });
  }
  const token = await mintGoogleToken(credentials, [PUBSUB_SCOPE], request, now, timeoutMs);
  const response = await fixedRequest(
    request,
    `${GOOGLE_PUBSUB_API_BASE_URL}/v1/${normalized}:testIamPermissions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ permissions: [PUBSUB_CONSUME_PERMISSION] }),
    },
    timeoutMs,
  );
  if (response.status === 401) {
    throw new ProviderVerificationError("credentialsRejected", response.status, {
      subject: "serviceAccountJson",
    });
  }
  if (response.status === 403 || response.status === 404) {
    throw new ProviderVerificationError("permissionMissing", response.status, {
      subject: "pubsubSubscription",
    });
  }
  rejectFailedResponse(response);
  const body = await safeJson(response);
  if (body === undefined) throw new ProviderVerificationError("invalidResponse", response.status);
  const parsed = pubsubIamPermissionsSchema.safeParse(body);
  if (!parsed.success) throw new ProviderVerificationError("invalidResponse", response.status);
  if (!(parsed.data.permissions ?? []).includes(PUBSUB_CONSUME_PERMISSION)) {
    throw new ProviderVerificationError("permissionMissing", response.status, {
      subject: "pubsubSubscription",
    });
  }
}

async function mintGoogleToken(
  credentials: GoogleServiceAccountCredentials,
  scopes: readonly string[],
  request: typeof fetch,
  now: () => number,
  timeoutMs: number,
): Promise<string> {
  try {
    const source = createGoogleAccessTokenSource({
      credentials,
      scopes,
      now,
      fetch: (input, init) => fixedRequest(request, requestUrlString(input), init ?? {}, timeoutMs),
    });
    return await source.getAccessToken();
  } catch (error) {
    if (error instanceof GoogleServiceAccountValidationError) {
      throw new ProviderVerificationError("credentialsRejected", undefined, {
        subject: "serviceAccountJson",
        cause: error,
      });
    }
    if (error instanceof GoogleAccessTokenError) {
      if (error.cause instanceof ProviderVerificationError) {
        throw error.cause;
      }
      if (
        error.status === 400 ||
        error.status === 401 ||
        error.status === 403 ||
        error.code === "credentialsRejected"
      ) {
        throw new ProviderVerificationError("credentialsRejected", error.status, {
          subject: "serviceAccountJson",
          cause: error,
        });
      }
      if (error.status === 429) {
        throw new ProviderVerificationError("rateLimited", error.status, { cause: error });
      }
      throw new ProviderVerificationError("upstreamUnavailable", error.status, { cause: error });
    }
    throw error;
  }
}

function requestUrlString(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function fixedRequest(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await request(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timeout =
      error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    throw new ProviderVerificationError(timeout ? "timeout" : "network", undefined, {
      cause: safeTransportCause(error),
    });
  }
}

function safeTransportCause(error: unknown): Error {
  if (!(error instanceof Error)) return new Error("provider transport failed");
  const diagnostic = new Error("provider transport failed");
  diagnostic.name = error.name;
  const frames = error.stack?.split("\n").slice(1).join("\n");
  if (frames !== undefined && frames.length > 0) {
    diagnostic.stack = `${diagnostic.name}: ${diagnostic.message}\n${frames}`;
  }
  const code: unknown = Reflect.get(error, "code");
  if (typeof code === "string" && /^[A-Z0-9_]+$/u.test(code)) {
    Object.assign(diagnostic, { code });
  }
  return diagnostic;
}

function rejectFailedResponse(response: Response): void {
  if (response.ok) return;
  if (response.status === 429) throw new ProviderVerificationError("rateLimited", response.status);
  throw new ProviderVerificationError("upstreamUnavailable", response.status);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
