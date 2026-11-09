import { replyOutputTool } from "../../execution-capabilities/outputs.js";
import { GITHUB_TRIGGER_SOURCE_NAMES } from "../../triggers/github/classification.js";
import type { ProviderModule } from "../registry.js";
import { configurationSchema, identitySchema } from "./application-configuration.js";
import { connectionInventory } from "./application-persistence.js";
import { readEnvironment } from "./environment.js";
import { createGitHubRegistration } from "./index.js";
import { verifyGitHub } from "./verification.js";
export const githubProvider: ProviderModule = {
  manifest: {
    id: "github",
    connectionOrder: 0,
    actions: ["start", "disconnect", "setup", "callback"],
    events: GITHUB_TRIGGER_SOURCE_NAMES,
    requests: ["webhook"],
    outputs: [{ type: "github.reply", tool: replyOutputTool }],
    integration: { repositoryAuthority: true },
  },
  application: {
    persistence: connectionInventory,
    parseConfiguration(value) {
      const parsed = configurationSchema.parse(value);
      const { webhookSecret, ...rest } = parsed;
      return webhookSecret === undefined ? rest : { ...rest, webhookSecret };
    },
    parseIdentity: (value) => identitySchema.parse(value),
    readEnvironment,
    identifiers(value) {
      const configuration = configurationSchema.parse(value);
      return {
        appId: configuration.appId,
        appSlug: configuration.appSlug,
        clientId: configuration.clientId,
      };
    },
    acceptsEvents(value) {
      return (configurationSchema.parse(value).webhookSecret ?? "") !== "";
    },
    receivesEvents: true,
    verify(value, options) {
      const configuration = configurationSchema.parse(value);
      const { webhookSecret, ...rest } = configuration;
      return verifyGitHub(
        webhookSecret === undefined ? rest : { ...rest, webhookSecret },
        options.fetch ?? fetch,
        options.now ?? Date.now,
        options.timeoutMs ?? 8_000,
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
    const { webhookSecret, ...rest } = configuration;
    return createGitHubRegistration({
      ...shared,
      configuration: webhookSecret === undefined ? rest : { ...rest, webhookSecret },
    });
  },
};
