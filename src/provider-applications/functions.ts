import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { browserProvider } from "../providers/browser.js";
import { slackSocketSchema } from "../providers/slack/application-configuration.js";
import { getApplication } from "../server/runtime.js";
import {
  type ProviderApplicationConfiguration,
  type ProviderApplicationOverview,
  type ProviderApplicationSaveResult,
} from "./index.js";
import { providerApplicationSaveFailure, providerHost, providerName } from "./save-failure.js";

const providerSchema = z
  .string()
  .min(1)
  .superRefine((provider, context) => {
    try {
      browserProvider(provider);
    } catch {
      context.addIssue({ code: "custom", message: "Unknown provider" });
    }
  });
const surfaceSchema = z.enum(["appSetup", "apps"]).optional();
const configurationSchema = z
  .object({ provider: z.string() })
  .passthrough()
  .transform((value, context) => {
    try {
      return browserProvider(value.provider).request.parse(value);
    } catch (error) {
      if (error instanceof z.ZodError)
        for (const issue of error.issues) context.addIssue({ ...issue });
      else context.addIssue({ code: "custom", path: ["provider"], message: "Unknown provider" });
      return z.NEVER;
    }
  });
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
          fallback: "Hub couldn't load your apps. Reload the page.",
          forbidden: "Only an instance operator can view app setup.",
          authentication: "Your session has expired. Sign in again to view app setup.",
          network: "Hub couldn't reach its own data to read your apps. Reload the page.",
          timeout: "Reading your apps took too long. Reload the page.",
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
          fallback: `Something went wrong while starting the ${name} connection. Nothing was connected. Try again.`,
          forbidden: `You don't have permission to connect ${name} to this organization.`,
          authentication: `Your session has expired. Nothing was connected. Sign in again, then start the connection again.`,
          notFound: `There are no saved ${name} credentials to connect. Verify and save the app first.`,
          validation: `Hub couldn't confirm the address this page was opened at, so the connection was refused. Nothing was connected. Open Hub at its usual address, then start again.`,
          conflict: `The ${name} app changed while this connection was starting. Nothing was connected. Reload the page, then start again.`,
          network: `Hub couldn't reach ${name}. Nothing was connected. Check this server's network, DNS, and TLS access to ${providerHost(data.provider)}, then start again.`,
          timeout: `${name} didn't answer in time. Nothing was connected. Try again.`,
          rateLimited: `${name} is rate limiting Hub. Nothing was connected. Wait a few minutes, then start again.`,
          upstreamUnavailable: `${name} returned an error of its own. Nothing was connected. Check ${name}'s status page, then start again.`,
        },
      );
    }
  });

export const configureSlackSocketApplication = createServerFn({ method: "POST" })
  .validator(slackSocketSchema)
  .handler(async (context) => {
    const { configureSlackSocketHandler } = await import("../providers/slack/endpoints.js");
    return configureSlackSocketHandler(context);
  });
export const retrySlackSocketDelivery = createServerFn({ method: "POST" }).handler(async () => {
  const { retrySlackSocketHandler } = await import("../providers/slack/endpoints.js");
  return retrySlackSocketHandler();
});

function sensitiveConfigurationValues(
  configuration: z.infer<typeof configurationSchema>,
): readonly string[] {
  return browserProvider(configuration.provider).request.secrets(configuration);
}
function normalizedConfiguration(
  data: z.infer<typeof configurationSchema>,
): ProviderApplicationConfiguration {
  return browserProvider(data.provider).request.normalize(data);
}
