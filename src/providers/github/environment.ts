import { readFile } from "node:fs/promises";
import type { GitHubProviderApplicationConfiguration } from "./application-configuration.js";
export async function readEnvironment(
  environment: Record<string, string | undefined>,
): Promise<GitHubProviderApplicationConfiguration | undefined> {
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

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
