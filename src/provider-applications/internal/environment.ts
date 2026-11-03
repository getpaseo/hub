import { readFile } from "node:fs/promises";
import { normalizePubSubSubscriptionName } from "../../triggers/google-chat/pubsub.js";
import type { Provider, ProviderApplicationConfiguration } from "../index.js";

/** @package */
export async function readProviderApplicationEnvironment(
  environment: Record<string, string | undefined>,
): Promise<Partial<Record<Provider, ProviderApplicationConfiguration>>> {
  const github = await githubEnvironment(environment);
  const slack = slackEnvironment(environment);
  const discord = discordEnvironment(environment);
  const googleChat = await googleChatEnvironment(environment);
  const linear = linearEnvironment(environment);
  return {
    ...(github === undefined ? {} : { github }),
    ...(slack === undefined ? {} : { slack }),
    ...(discord === undefined ? {} : { discord }),
    ...(googleChat === undefined ? {} : { "google-chat": googleChat }),
    ...(linear === undefined ? {} : { linear }),
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

async function googleChatEnvironment(
  environment: Record<string, string | undefined>,
): Promise<ProviderApplicationConfiguration | undefined> {
  const transport = nonEmpty(environment["GOOGLE_CHAT_TRANSPORT"]);
  const projectId = nonEmpty(environment["GOOGLE_CHAT_PROJECT_ID"]);
  const appName = nonEmpty(environment["GOOGLE_CHAT_APP_NAME"]);
  const inlineCredentials = nonEmpty(environment["GOOGLE_CHAT_SERVICE_ACCOUNT_JSON"]);
  const credentialsPath = nonEmpty(environment["GOOGLE_CHAT_SERVICE_ACCOUNT_PATH"]);
  const subscription = nonEmpty(environment["GOOGLE_CHAT_PUBSUB_SUBSCRIPTION"]);
  const audience = nonEmpty(environment["GOOGLE_CHAT_WEBHOOK_AUDIENCE"]);
  const supplied = [
    transport,
    projectId,
    appName,
    inlineCredentials,
    credentialsPath,
    subscription,
    audience,
  ].some((value) => value !== undefined);
  if (!supplied) return undefined;

  const serviceAccountJson = await readServiceAccountJson(inlineCredentials, credentialsPath);
  return buildGoogleChatEnvironment({
    transport,
    projectId,
    appName,
    serviceAccountJson,
    subscription,
    audience,
  });
}

async function readServiceAccountJson(
  inlineCredentials: string | undefined,
  credentialsPath: string | undefined,
): Promise<string | undefined> {
  const value =
    inlineCredentials ??
    (credentialsPath === undefined ? undefined : await readFile(credentialsPath, "utf8"));
  return nonEmpty(value);
}

function buildGoogleChatEnvironment(input: {
  transport: string | undefined;
  projectId: string | undefined;
  appName: string | undefined;
  serviceAccountJson: string | undefined;
  subscription: string | undefined;
  audience: string | undefined;
}): ProviderApplicationConfiguration {
  const { transport, projectId, appName, serviceAccountJson, subscription, audience } = input;
  const resolvedTransport = transport ?? "pubsub";
  if (resolvedTransport !== "pubsub" && resolvedTransport !== "webhook") {
    throw new Error(
      "Google Chat environment configuration has an unknown GOOGLE_CHAT_TRANSPORT value.",
    );
  }
  if (projectId === undefined || appName === undefined || serviceAccountJson === undefined) {
    throw new Error(
      "Google Chat environment configuration requires GOOGLE_CHAT_PROJECT_ID, GOOGLE_CHAT_APP_NAME, and GOOGLE_CHAT_SERVICE_ACCOUNT_JSON (or GOOGLE_CHAT_SERVICE_ACCOUNT_PATH).",
    );
  }
  if (resolvedTransport === "pubsub") {
    if (subscription === undefined || audience !== undefined) {
      throw new Error(
        "Google Chat environment configuration for Pub/Sub requires GOOGLE_CHAT_PUBSUB_SUBSCRIPTION and must not set GOOGLE_CHAT_WEBHOOK_AUDIENCE.",
      );
    }
    return {
      provider: "google-chat",
      transport: "pubsub",
      projectId,
      appName,
      serviceAccountJson,
      subscription: normalizePubSubSubscriptionName(projectId, subscription),
    };
  }
  if (subscription !== undefined) {
    throw new Error(
      "Google Chat environment configuration for HTTP webhooks must not set GOOGLE_CHAT_PUBSUB_SUBSCRIPTION.",
    );
  }
  return {
    provider: "google-chat",
    transport: "webhook",
    projectId,
    appName,
    serviceAccountJson,
    ...(audience === undefined ? {} : { audience }),
  };
}

function linearEnvironment(
  environment: Record<string, string | undefined>,
): ProviderApplicationConfiguration | undefined {
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
