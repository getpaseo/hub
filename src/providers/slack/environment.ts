import type { SlackProviderApplicationConfiguration } from "./application-configuration.js";
export function readEnvironment(
  environment: Record<string, string | undefined>,
): SlackProviderApplicationConfiguration | undefined {
  const transport = nonEmpty(environment["SLACK_TRANSPORT"]);
  const appId = nonEmpty(environment["SLACK_APP_ID"]);
  const appToken = nonEmpty(environment["SLACK_APP_TOKEN"]);
  const clientId = nonEmpty(environment["SLACK_CLIENT_ID"]);
  const clientSecret = nonEmpty(environment["SLACK_CLIENT_SECRET"]);
  const signingSecret = nonEmpty(environment["SLACK_SIGNING_SECRET"]);
  const supplied = [transport, appId, appToken, clientId, clientSecret, signingSecret].some(
    (value) => value !== undefined,
  );
  if (!supplied) return undefined;

  const socketComplete =
    appId !== undefined &&
    appToken !== undefined &&
    clientId === undefined &&
    clientSecret === undefined &&
    signingSecret === undefined;
  if (transport === "socket" && socketComplete) {
    return { provider: "slack", transport, appId, appToken };
  }
  if (transport === "socket") {
    throw new Error(
      "Slack environment configuration for Socket Mode requires exactly SLACK_TRANSPORT=socket, SLACK_APP_ID, and SLACK_APP_TOKEN.",
    );
  }

  if (transport !== undefined && transport !== "webhook") {
    throw new Error("Slack environment configuration has an unknown SLACK_TRANSPORT value.");
  }
  if (
    appId !== undefined &&
    appToken === undefined &&
    clientId !== undefined &&
    clientSecret !== undefined &&
    signingSecret !== undefined
  ) {
    return {
      provider: "slack",
      transport: "webhook",
      appId,
      clientId,
      clientSecret,
      signingSecret,
    };
  }
  throw new Error(
    "Slack environment configuration for Webhooks requires SLACK_APP_ID, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_SIGNING_SECRET.",
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
