import { replyOutputTool } from "../../execution-capabilities/outputs.js";
import type { ProviderModule } from "../registry.js";
import { summarizeEvent } from "./activity.js";
import { configurationSchema, identitySchema } from "./application-configuration.js";
import { connectionInventory } from "./application-persistence.js";
import { beginLinearConfiguration, completeLinearInstallation } from "./application.js";
import { readEnvironment } from "./environment.js";
import { createLinearRegistration } from "./index.js";
import { resources } from "./resources.js";
import { triggerConfiguration } from "./trigger-configuration.js";

export const linearProvider: ProviderModule = {
  configuration: triggerConfiguration,
  resources,
  summarizeEvent,
  manifest: {
    id: "linear",
    connectionOrder: 3,
    actions: ["start", "disconnect", "callback"],
    events: ["linear.issue", "linear.comment"],
    requests: ["linear.events"],
    outputs: [{ type: "linear.reply", tool: replyOutputTool }],
  },
  application: {
    initialConnectionPhase: "linear_authorization",
    connectionConfigurationActivation: true,
    persistence: connectionInventory,
    parseConfiguration(value) {
      const parsed = configurationSchema.parse(value);
      return parsed;
    },
    parseIdentity: (value) => identitySchema.parse(value),
    readEnvironment,
    identifiers(value) {
      const configuration = configurationSchema.parse(value);
      return { clientId: configuration.clientId };
    },
    acceptsEvents(_value) {
      return true;
    },
    receivesEvents: true,
    connectionRequiresHttps: true,
    environmentIdentity(value) {
      const configuration = configurationSchema.parse(value);
      return { provider: "linear", id: configuration.clientId, name: "Linear app" };
    },
    configure(context, value) {
      const parsed = configurationSchema.parse(value);
      const input = {
        ...parsed,
        ...(value.expectedVersion === undefined ? {} : { expectedVersion: value.expectedVersion }),
      };
      if (input.provider !== "linear") throw new Error("provider configuration mismatch");
      return beginLinearConfiguration(
        context.options,
        context.request,
        context.account,
        context.callbackOrigin,
        input,
        context.returnRoute,
      );
    },
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
    return createLinearRegistration({
      ...shared,
      configuration,
      ...(input.expectedConfigurationVersion === undefined
        ? {}
        : { expectedConfigurationVersion: input.expectedConfigurationVersion }),
      activateConfiguration: input.activateConfiguration,
      onVerifiedInstallation: (installation) =>
        input.onInstallation((options) => completeLinearInstallation(options, installation)),
    });
  },
};
