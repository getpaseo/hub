import { z } from "zod";
import type {
  DiscordProviderApplicationConfiguration,
  DiscordProviderApplicationIdentity,
} from "./discord/application-configuration.js";
import {
  configurationSchema as discordConfigurationSchema,
  identitySchema as discordIdentitySchema,
} from "./discord/application-configuration.js";
import type {
  GitHubProviderApplicationConfiguration,
  GitHubProviderApplicationIdentity,
} from "./github/application-configuration.js";
import {
  configurationSchema as githubConfigurationSchema,
  identitySchema as githubIdentitySchema,
} from "./github/application-configuration.js";
import { githubRuntime } from "./github/runtime.js";
import type {
  LinearProviderApplicationConfiguration,
  LinearProviderApplicationIdentity,
} from "./linear/application-configuration.js";
import {
  configurationSchema as linearConfigurationSchema,
  identitySchema as linearIdentitySchema,
} from "./linear/application-configuration.js";
import { completeLinearInstallation } from "./linear/application.js";
import type { ProviderRegistration } from "./registration.js";
import { ProviderRegistry, type ProviderModule, type ProviderRuntimeInput } from "./registry.js";
import { createProviderRegistry } from "./server.js";
import type {
  SlackProviderApplicationConfiguration,
  SlackProviderApplicationIdentity,
} from "./slack/application-configuration.js";
import {
  configurationSchema as slackConfigurationSchema,
  identitySchema as slackIdentitySchema,
} from "./slack/application-configuration.js";
import { completeSlackInstallation } from "./slack/application.js";
import { slackRuntime } from "./slack/runtime.js";

/** A test composition using the same registration interface as bootstrap. */
export function registrationRegistry(
  create: (
    input: Omit<ProviderRuntimeInput, "configuration"> & {
      provider: TestProviderApplicationConfiguration["provider"];
      configuration: TestProviderApplicationConfiguration;
      onVerifiedSlackInstallation: NonNullable<
        Parameters<
          typeof import("./slack/index.js").createSlackRegistration
        >[0]["onVerifiedInstallation"]
      >;
      onVerifiedLinearInstallation: NonNullable<
        Parameters<
          typeof import("./linear/index.js").createLinearRegistration
        >[0]["onVerifiedInstallation"]
      >;
    },
  ) => ProviderRegistration,
): ProviderRegistry {
  const modules: ProviderModule[] = [];
  for (const module of createProviderRegistry().list())
    modules.push({
      ...module,
      createRuntime: (input) =>
        registerNative(
          module.manifest.id,
          create({
            ...input,
            provider: parseTestApplicationConfiguration(input.configuration).provider,
            configuration: parseTestApplicationConfiguration(input.configuration),
            onVerifiedSlackInstallation: (installation) =>
              input.onInstallation((options) => completeSlackInstallation(options, installation)),
            onVerifiedLinearInstallation: (installation) =>
              input.onInstallation((options) => completeLinearInstallation(options, installation)),
          }),
        ),
    });
  return new ProviderRegistry(modules);
}

function registerNative(
  provider: string,
  registration: ProviderRegistration,
): ProviderRegistration {
  if (provider === "github") return githubRuntime.register(registration);
  if (provider === "slack") return slackRuntime.register(registration);
  return registration;
}

/** The four shipped fixtures; production contracts use registered string IDs. */
export type TestProviderApplicationConfiguration =
  | GitHubProviderApplicationConfiguration
  | SlackProviderApplicationConfiguration
  | DiscordProviderApplicationConfiguration
  | LinearProviderApplicationConfiguration;
export type TestProviderApplicationIdentity =
  | GitHubProviderApplicationIdentity
  | SlackProviderApplicationIdentity
  | DiscordProviderApplicationIdentity
  | LinearProviderApplicationIdentity;
export function testApplicationConfiguration(
  value: TestProviderApplicationConfiguration,
): TestProviderApplicationConfiguration {
  return value;
}
export function testApplicationIdentity(
  value: TestProviderApplicationIdentity,
): TestProviderApplicationIdentity {
  return value;
}

const fixtureConfigurationSchema = z.union([
  githubConfigurationSchema,
  slackConfigurationSchema,
  discordConfigurationSchema,
  linearConfigurationSchema,
]);
const fixtureIdentitySchema = z.union([
  githubIdentitySchema,
  slackIdentitySchema,
  discordIdentitySchema,
  linearIdentitySchema,
]);
export function parseTestApplicationConfiguration(
  value: unknown,
): TestProviderApplicationConfiguration {
  const parsed = fixtureConfigurationSchema.parse(value);
  if (parsed.provider !== "github") return parsed;
  const { webhookSecret, ...rest } = parsed;
  return webhookSecret === undefined ? rest : { ...rest, webhookSecret };
}
export function parseTestApplicationIdentity(value: unknown): TestProviderApplicationIdentity {
  return fixtureIdentitySchema.parse(value);
}
