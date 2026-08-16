import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { getApplication } from "../server/runtime.js";
import {
  ProviderApplicationError,
  type Provider,
  type ProviderApplicationConfiguration,
  type ProviderApplicationOverview,
  type ProviderApplicationSaveResult,
} from "./index.js";

const providerSchema = z.enum(["github", "slack", "discord"]);
const surfaceSchema = z.enum(["appSetup", "apps"]).optional();
const expectedVersionSchema = z.number().int().positive().optional();
const configurationSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("github"),
    appId: z.string().trim().min(1),
    appSlug: z.string().trim().min(1),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().min(1),
    privateKey: z.string().min(1),
    webhookSecret: z.string().min(1),
    expectedVersion: expectedVersionSchema,
    surface: surfaceSchema,
  }),
  z.object({
    provider: z.literal("slack"),
    appId: z.string().trim().min(1),
    clientId: z.string().trim().min(1),
    clientSecret: z.string().min(1),
    signingSecret: z.string().min(1),
    expectedVersion: expectedVersionSchema,
    surface: surfaceSchema,
  }),
  z.object({
    provider: z.literal("discord"),
    applicationId: z.string().trim().min(1),
    clientSecret: z.string().min(1),
    botToken: z.string().min(1),
    expectedVersion: expectedVersionSchema,
    surface: surfaceSchema,
  }),
]);
const connectionSchema = z.object({
  provider: providerSchema,
  organizationId: z.string().min(1),
  surface: surfaceSchema,
});

export const providerApplicationsOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<ProviderApplicationOverview>> => {
    try {
      const capability = (await getApplication()).providerApplications;
      if (capability === null) throw new Error("unavailable");
      return respondOk(await capability.overview(getRequest()));
    } catch (error) {
      return respondWithFailure(
        error,
        { operation: "provider_application.overview", component: "provider_applications" },
        {
          fallback:
            "Hub couldn't load your apps. Reload the page and use the reference if the problem continues.",
        },
      );
    }
  },
);

export const verifyAndSaveProviderApplication = createServerFn({ method: "POST" })
  .validator(configurationSchema)
  .handler(async ({ data }): Promise<Result<ProviderApplicationSaveResult>> => {
    try {
      const capability = (await getApplication()).providerApplications;
      if (capability === null) throw new Error("unavailable");
      return respondOk(
        await capability.verifyAndSave(
          getRequest(),
          data.provider,
          normalizedConfiguration(data),
          data.surface,
        ),
      );
    } catch (error) {
      return saveFailure(data.provider, error);
    }
  });

export const beginProviderConnection = createServerFn({ method: "POST" })
  .validator(connectionSchema)
  .handler(async ({ data }): Promise<Result<{ url: string }>> => {
    try {
      const capability = (await getApplication()).providerApplications;
      if (capability === null) throw new Error("unavailable");
      return respondOk(
        await capability.beginConnection(
          getRequest(),
          data.provider,
          data.organizationId,
          data.surface,
        ),
      );
    } catch (error) {
      const name = providerName(data.provider);
      return respondWithFailure(
        error,
        {
          operation: "provider_application.begin_connection",
          component: "provider_applications",
          provider: data.provider,
        },
        {
          fallback: `Hub couldn't start the ${name} connection. Reload the app status before starting it again.`,
          forbidden: `You don't have permission to connect ${name}.`,
          conflict: `${name} changed while this connection was starting. Reload the app status and start again.`,
          network: `Hub couldn't connect to ${name}. Check this server's network, DNS, and TLS access to ${providerHost(data.provider)}, then start again.`,
          timeout: `${name} did not respond before the connection timed out. Check provider status and start again.`,
          rateLimited: `${name} rate limited Hub. Wait a few minutes before starting the connection again.`,
          upstreamUnavailable: `${name} is unavailable right now. Check ${name}'s status page before starting the connection again.`,
        },
      );
    }
  });

function saveFailure(provider: Provider, error: unknown): ReturnType<typeof respondError> {
  const name = providerName(provider);
  const code = errorCode(error);
  const operation = "provider_application.verify_and_save";
  if (provider === "slack" && code === "httpsRequired") {
    return respondWithFailure(
      error,
      { operation, component: "provider_applications", provider },
      {
        fallback: `Slack requires a public HTTPS address. This Hub is at ${errorContext(error) ?? "an HTTP address"}. Open Hub at its public HTTPS address to set up Slack.`,
      },
      { kind: "validation" },
    );
  }
  if (code === "managedByEnvironment") {
    return respondWithFailure(
      error,
      { operation, component: "provider_applications", provider },
      { fallback: `${name} is managed by this Hub's environment. Change its credentials there.` },
      { kind: "conflict" },
    );
  }
  if (code === "configurationConflict") {
    return respondWithFailure(
      error,
      { operation, component: "provider_applications", provider },
      {
        fallback: `Someone else changed the ${name} app. Reload its current settings before saving again.`,
      },
      { kind: "conflict" },
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
      { kind: "conflict" },
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
  );
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

function providerHost(provider: Provider): string {
  if (provider === "github") return "api.github.com";
  if (provider === "slack") return "slack.com";
  return "discord.com";
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

function providerName(provider: Provider): string {
  if (provider === "github") return "GitHub";
  if (provider === "slack") return "Slack";
  return "Discord";
}

function normalizedConfiguration(
  data: z.infer<typeof configurationSchema>,
): ProviderApplicationConfiguration {
  const version =
    data.expectedVersion === undefined ? {} : { expectedVersion: data.expectedVersion };
  if (data.provider === "github") {
    return {
      provider: data.provider,
      appId: data.appId,
      appSlug: data.appSlug,
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      privateKey: data.privateKey,
      webhookSecret: data.webhookSecret,
      ...version,
    };
  }
  if (data.provider === "slack") {
    return {
      provider: data.provider,
      appId: data.appId,
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      signingSecret: data.signingSecret,
      ...version,
    };
  }
  return {
    provider: data.provider,
    applicationId: data.applicationId,
    clientSecret: data.clientSecret,
    botToken: data.botToken,
    ...version,
  };
}
