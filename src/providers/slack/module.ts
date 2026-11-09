import { replyOutputTool } from "../../execution-capabilities/outputs.js";
import type { ProviderModule } from "../registry.js";
import { summarizeEvent } from "./activity.js";
import { SlackApplication } from "./application-capability.js";
import { configurationSchema } from "./application-configuration.js";
import { completeSlackInstallation } from "./application.js";
import { createSlackRegistration } from "./index.js";
import type { SlackSocketInstallationVerifier } from "./installation.js";
export function createSlackProvider(verifier?: SlackSocketInstallationVerifier): ProviderModule {
  return {
    summarizeEvent,
    manifest: {
      id: "slack",
      connectionOrder: 2,
      actions: ["start", "disconnect", "callback"],
      events: ["slack.mention"],
      requests: ["slack.events"],
      outputs: [{ type: "slack.reply", tool: replyOutputTool }],
      attachment: "slack",
    },
    application: new SlackApplication(verifier),
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
}
