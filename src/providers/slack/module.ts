import { replyOutputTool } from "../../execution-capabilities/outputs.js";
import type { ProviderModule } from "../registry.js";
import { configurationSchema, identitySchema } from "./application-configuration.js";
import { beginSlackConfiguration, completeSlackInstallation } from "./application.js";
import { readEnvironment } from "./environment.js";
import { createSlackRegistration } from "./index.js";
import { configureSocket } from "./socket-application.js";
export const slackProvider: ProviderModule = {
  manifest: {
    id: "slack",
    connectionOrder: 2,
    actions: ["start", "disconnect", "callback"],
    events: ["slack.mention"],
    requests: ["slack.events"],
    outputs: [{ type: "slack.reply", tool: replyOutputTool }],
    attachment: "slack",
  },
  application: {
    parseConfiguration(value) {
      const parsed = configurationSchema.parse(value);
      return parsed;
    },
    parseIdentity: (value) => identitySchema.parse(value),
    readEnvironment,
    identifiers(value) {
      const configuration = configurationSchema.parse(value);
      return configuration.transport === "webhook"
        ? {
            appId: configuration.appId,
            transport: configuration.transport,
            clientId: configuration.clientId,
          }
        : { appId: configuration.appId, transport: configuration.transport };
    },
    acceptsEvents(_value) {
      return true;
    },
    receivesEvents: true,

    environmentIdentity(value) {
      const configuration = configurationSchema.parse(value);
      return { provider: "slack", id: configuration.appId, name: "Slack app" };
    },
    configure(context, value) {
      const input = value;
      if (input.provider !== "slack") throw new Error("provider configuration mismatch");
      return beginSlackConfiguration(
        context.options,
        context.request,
        context.account,
        context.callbackOrigin,
        input,
        context.returnRoute,
      );
    },

    socket: { configure: configureSocket },
    deliveryStatus: (options) => options.slackDelivery?.status(),
  },
  createRuntime(input) {
    const configuration = configurationSchema.parse(input.configuration);
    const shared = {
      database: input.database,
      auth: input.auth,
      applicationBaseUrl: input.applicationBaseUrl,
      publicBaseUrl: input.callbackOrigin,
      configurationVersion: input.configurationVersion,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    };
    return createSlackRegistration({
      ...shared,
      configuration,
      ...(input.expectedConfigurationVersion === undefined
        ? {}
        : { expectedConfigurationVersion: input.expectedConfigurationVersion }),
      activateConfiguration: input.activateConfiguration,
      onVerifiedInstallation: (installation) =>
        input.onInstallation((options) => completeSlackInstallation(options, installation)),
    });
  },
};
