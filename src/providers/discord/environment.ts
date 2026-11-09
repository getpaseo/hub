import type { DiscordProviderApplicationConfiguration } from "./application-configuration.js";
export function readEnvironment(
  environment: Record<string, string | undefined>,
): DiscordProviderApplicationConfiguration | undefined {
  const applicationId = nonEmpty(environment["DISCORD_CLIENT_ID"]);
  const clientSecret = nonEmpty(environment["DISCORD_CLIENT_SECRET"]);
  const botToken = nonEmpty(environment["DISCORD_BOT_TOKEN"]);
  return applicationId === undefined || clientSecret === undefined || botToken === undefined
    ? undefined
    : { provider: "discord", applicationId, clientSecret, botToken };
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
