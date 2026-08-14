import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondError, respondOk, type Result } from "../contract/respond.js";
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
    } catch {
      return respondError({ message: "We couldn't load your apps. Reload the page." });
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
      return respondError({ message: saveFailure(data.provider, error) });
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
    } catch {
      return respondError({
        message: `We couldn't open ${providerName(data.provider)}. Try again.`,
      });
    }
  });

function saveFailure(provider: Provider, error: unknown): string {
  if (error instanceof ProviderApplicationError) {
    if (provider === "slack" && error.code === "httpsRequired") {
      return `Slack requires a public HTTPS address. This Hub is at ${error.safeContext ?? "an HTTP address"}. Open Hub at its public HTTPS address to set up Slack.`;
    }
    if (error.code === "configurationConflict") {
      return "Someone else changed this app. Reload and try again.";
    }
    if (error.code === "identityConflict") {
      const identity = error.safeContext ?? providerName(provider);
      return `This Hub is connected to the ${providerName(provider)} App ${identity}. Remove its connections before setting up a different App.`;
    }
    if (error.code === "unreachable")
      return `We couldn't reach ${providerName(provider)}. Try again.`;
  }
  if (provider === "github") {
    return "GitHub didn't accept these credentials. Check the App ID and private key, then try again.";
  }
  if (provider === "discord") {
    return "Discord didn't accept these credentials. Check the Application ID and bot token, then try again.";
  }
  return "Slack didn't complete the installation. Nothing was saved. Try again.";
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
