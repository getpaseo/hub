import { z } from "zod";
import { ProviderVerificationError } from "../../provider-applications/index.js";
import { fixedRequest, rejectFailedResponse, safeJson } from "../verification.js";
import type {
  DiscordProviderApplicationConfiguration,
  DiscordProviderApplicationIdentity,
} from "./application-configuration.js";
const discordIdentitySchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  bot: z.literal(true),
});
const discordTokenSchema = z.object({ access_token: z.string().min(1) });
const DISCORD_API = "https://discord.com/api/v10";
/**
 * Two proofs, because Discord splits its credentials across two portal pages. The bot token
 * proves the bot and names the application; the client credentials grant proves the Client
 * Secret the connection flow will later need. Verifying only the first would let the surface
 * claim "Verified" for an application that cannot complete a single authorization.
 */
export async function verifyDiscord(
  configuration: DiscordProviderApplicationConfiguration,
  request: typeof fetch,
  timeoutMs: number,
): Promise<DiscordProviderApplicationIdentity> {
  const identity = await verifyDiscordBot(configuration, request, timeoutMs);
  await verifyDiscordClientSecret(configuration, request, timeoutMs);
  return identity;
}

export async function verifyDiscordBot(
  configuration: DiscordProviderApplicationConfiguration,
  request: typeof fetch,
  timeoutMs: number,
): Promise<DiscordProviderApplicationIdentity> {
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
export async function verifyDiscordClientSecret(
  configuration: DiscordProviderApplicationConfiguration,
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
