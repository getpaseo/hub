import type { LinearProviderApplicationConfiguration } from "./application-configuration.js";
export function readEnvironment(
  environment: Record<string, string | undefined>,
): LinearProviderApplicationConfiguration | undefined {
  const clientId = nonEmpty(environment["LINEAR_CLIENT_ID"]);
  const clientSecret = nonEmpty(environment["LINEAR_CLIENT_SECRET"]);
  const webhookSecret = nonEmpty(environment["LINEAR_WEBHOOK_SECRET"]);
  if (clientId === undefined && clientSecret === undefined && webhookSecret === undefined) {
    return undefined;
  }
  if (clientId === undefined || clientSecret === undefined || webhookSecret === undefined) {
    throw new Error(
      "Linear environment configuration requires LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, and LINEAR_WEBHOOK_SECRET.",
    );
  }
  return { provider: "linear", clientId, clientSecret, webhookSecret };
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
