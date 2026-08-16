import { readFile } from "node:fs/promises";
import type { Provider, ProviderApplicationConfiguration } from "../index.js";

/** @package */
export async function readProviderApplicationEnvironment(
  environment: Record<string, string | undefined>,
): Promise<Partial<Record<Provider, ProviderApplicationConfiguration>>> {
  const github = await githubEnvironment(environment);
  const slack = slackEnvironment(environment);
  const discord = discordEnvironment(environment);
  return {
    ...(github === undefined ? {} : { github }),
    ...(slack === undefined ? {} : { slack }),
    ...(discord === undefined ? {} : { discord }),
  };
}

async function githubEnvironment(
  environment: Record<string, string | undefined>,
): Promise<ProviderApplicationConfiguration | undefined> {
  const appId = nonEmpty(environment["GITHUB_APP_ID"]);
  const appSlug = nonEmpty(environment["GITHUB_APP_SLUG"]);
  const clientId = nonEmpty(environment["GITHUB_APP_CLIENT_ID"]);
  const clientSecret = nonEmpty(environment["GITHUB_APP_CLIENT_SECRET"]);
  const webhookSecret = nonEmpty(environment["GITHUB_WEBHOOK_SECRET"]);
  const inlinePrivateKey = nonEmpty(environment["GITHUB_APP_PRIVATE_KEY"]);
  const privateKeyPath = nonEmpty(environment["GITHUB_APP_PRIVATE_KEY_PATH"]);
  if (
    appId === undefined ||
    appSlug === undefined ||
    clientId === undefined ||
    clientSecret === undefined ||
    webhookSecret === undefined ||
    (inlinePrivateKey === undefined && privateKeyPath === undefined)
  ) {
    return undefined;
  }
  const privateKey =
    inlinePrivateKey ??
    (privateKeyPath === undefined ? undefined : await readFile(privateKeyPath, "utf8"));
  if (privateKey === undefined || privateKey.length === 0) return undefined;
  return {
    provider: "github",
    appId,
    appSlug,
    clientId,
    clientSecret,
    privateKey,
    webhookSecret,
  };
}

function slackEnvironment(
  environment: Record<string, string | undefined>,
): ProviderApplicationConfiguration | undefined {
  const appId = nonEmpty(environment["SLACK_APP_ID"]);
  const clientId = nonEmpty(environment["SLACK_CLIENT_ID"]);
  const clientSecret = nonEmpty(environment["SLACK_CLIENT_SECRET"]);
  const signingSecret = nonEmpty(environment["SLACK_SIGNING_SECRET"]);
  return appId === undefined ||
    clientId === undefined ||
    clientSecret === undefined ||
    signingSecret === undefined
    ? undefined
    : { provider: "slack", appId, clientId, clientSecret, signingSecret };
}

function discordEnvironment(
  environment: Record<string, string | undefined>,
): ProviderApplicationConfiguration | undefined {
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
