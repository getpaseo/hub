import { replyOutputTool } from "../../execution-capabilities/outputs.js";
import type { ProviderModule } from "../registry.js";
import { activationError } from "./activation-error.js";
import { summarizeEvent } from "./activity.js";
import { configurationSchema, identitySchema } from "./application-configuration.js";
import { connectionInventory } from "./application-persistence.js";
import { readEnvironment } from "./environment.js";
import { createDiscordRegistration } from "./index.js";
import { resources } from "./resources.js";
import { verifyDiscord } from "./verification.js";
export const discordProvider: ProviderModule = {
  resources,
  summarizeEvent,
  manifest: {
    id: "discord",
    connectionOrder: 1,
    actions: ["start", "disconnect", "callback"],
    events: ["discord.mention"],
    requests: [],
    outputs: [{ type: "discord.reply", tool: replyOutputTool }],
    attachment: "discord",
  },
  application: {
    persistence: connectionInventory,
    parseConfiguration(value) {
      const parsed = configurationSchema.parse(value);
      return parsed;
    },
    parseIdentity: (value) => identitySchema.parse(value),
    readEnvironment,
    identifiers(value) {
      const configuration = configurationSchema.parse(value);
      return { applicationId: configuration.applicationId };
    },
    acceptsEvents(_value) {
      return false;
    },
    receivesEvents: false,
    verify(value, options) {
      const configuration = configurationSchema.parse(value);
      return verifyDiscord(configuration, options.fetch ?? fetch, options.timeoutMs ?? 8_000);
    },
    activationError,
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
    return createDiscordRegistration({
      ...shared,
      configuration: {
        clientId: configuration.applicationId,
        clientSecret: configuration.clientSecret,
        botToken: configuration.botToken,
      },
    });
  },
};
