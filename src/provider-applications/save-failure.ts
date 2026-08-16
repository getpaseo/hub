import { respondError } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { ProviderApplicationError, type Provider } from "./index.js";

export function providerApplicationSaveFailure(
  provider: Provider,
  error: unknown,
  scrubValues: readonly string[] = [],
): ReturnType<typeof respondError> {
  const name = providerName(provider);
  const code = errorCode(error);
  const operation = "provider_application.verify_and_save";
  const gateway = discordGatewayDiagnostic(error);
  if (provider === "slack" && code === "httpsRequired") {
    return respondWithFailure(
      error,
      { operation, component: "provider_applications", provider },
      {
        fallback: `Slack requires a public HTTPS address. This Hub is at ${errorContext(error) ?? "an HTTP address"}. Open Hub at its public HTTPS address to set up Slack.`,
      },
      { kind: "validation", scrubValues },
    );
  }
  if (code === "managedByEnvironment") {
    return respondWithFailure(
      error,
      { operation, component: "provider_applications", provider },
      { fallback: `${name} is managed by this Hub's environment. Change its credentials there.` },
      { kind: "conflict", scrubValues },
    );
  }
  if (code === "configurationConflict") {
    return respondWithFailure(
      error,
      { operation, component: "provider_applications", provider },
      {
        fallback: `Someone else changed the ${name} app. Reload its current settings before saving again.`,
      },
      { kind: "conflict", scrubValues },
    );
  }
  if (code === "identityConflict") {
    const identity = errorContext(error) ?? name;
    return respondWithFailure(
      error,
      { operation, component: "provider_applications", provider },
      {
        fallback: `This Hub is connected to the ${name} App ${identity}. Remove its connections before setting up a different App.`,
      },
      { kind: "conflict", scrubValues },
    );
  }
  if (provider === "discord" && errorContext(error) === "discordGatewayDisallowedIntents") {
    return respondWithFailure(
      error,
      { operation, component: "provider_applications", provider },
      {
        fallback:
          "Discord requires Message Content Intent. Turn it on under Bot → Privileged Gateway Intents, save in Discord, then verify again.",
      },
      {
        kind: "permissionMissing",
        scrubValues,
        ...(gateway === undefined ? {} : { diagnostic: gateway }),
      },
    );
  }
  return respondWithFailure(
    error,
    { operation, component: "provider_applications", provider },
    {
      fallback: `Hub couldn't verify and save ${name}. Reload the app settings before saving again.`,
      forbidden: `Only the instance operator can change the ${name} app.`,
      credentialsRejected: credentialMessage(provider),
      permissionMissing: `${name} accepted the credentials, but the app is missing a required permission. Review the setup guide and grant every listed permission before verifying again.`,
      network: `Hub couldn't connect to ${name}. Check this server's network, DNS, and TLS access to ${providerHost(provider)}, then verify again.`,
      timeout: `${name} did not respond before verification timed out. Check this server's connection to ${providerHost(provider)}, then verify again.`,
      rateLimited: `${name} rate limited Hub. Wait a few minutes before verifying again.`,
      upstreamUnavailable: `${name} is unavailable or returned an invalid response. Check ${name}'s status page before verifying again.`,
      conflict: `The ${name} app changed while it was being saved. Reload its current settings before saving again.`,
      validation: `The ${name} app settings are invalid. Review every required field before saving again.`,
    },
    { scrubValues, ...(gateway === undefined ? {} : { diagnostic: gateway }) },
  );
}

export function providerHost(provider: Provider): string {
  if (provider === "github") return "api.github.com";
  if (provider === "slack") return "slack.com";
  return "discord.com";
}

export function providerName(provider: Provider): string {
  if (provider === "github") return "GitHub";
  if (provider === "slack") return "Slack";
  return "Discord";
}

function credentialMessage(provider: Provider): string {
  if (provider === "github") {
    return "GitHub didn't accept these credentials. Check the App ID and private key, then verify again.";
  }
  if (provider === "discord") {
    return "Discord didn't accept these credentials. Check the Application ID and bot token, then verify again.";
  }
  return "Slack didn't accept these app credentials. Check the App ID, client credentials, and signing secret before continuing.";
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof ProviderApplicationError) return error.code;
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function errorContext(error: unknown): string | undefined {
  if (error instanceof ProviderApplicationError) return error.safeContext;
  if (typeof error !== "object" || error === null) return undefined;
  const context: unknown = Reflect.get(error, "safeContext");
  return typeof context === "string" ? context : undefined;
}

function discordGatewayDiagnostic(
  error: unknown,
): { gatewayCloseCode: number; gatewayFailure: string } | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.name === "DiscordGatewayError") {
      const gatewayCloseCode: unknown = Reflect.get(current, "gatewayCloseCode");
      const gatewayFailure: unknown = Reflect.get(current, "gatewayFailure");
      return typeof gatewayCloseCode === "number" && typeof gatewayFailure === "string"
        ? { gatewayCloseCode, gatewayFailure }
        : undefined;
    }
    current = current.cause;
  }
  return undefined;
}
