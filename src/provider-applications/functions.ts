import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { getApplication } from "../server/runtime.js";
import {
  type ProviderApplicationConfiguration,
  type ProviderApplicationOverview,
  type ProviderApplicationSaveResult,
} from "./index.js";
import { providerApplicationSaveFailure, providerHost, providerName } from "./save-failure.js";

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
      return providerApplicationSaveFailure(
        data.provider,
        error,
        sensitiveConfigurationValues(data),
      );
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

function sensitiveConfigurationValues(
  configuration: z.infer<typeof configurationSchema>,
): readonly string[] {
  if (configuration.provider === "github") {
    return [configuration.clientSecret, configuration.privateKey, configuration.webhookSecret];
  }
  if (configuration.provider === "slack") {
    return [configuration.clientSecret, configuration.signingSecret];
  }
  return [configuration.clientSecret, configuration.botToken];
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
