import type { ProviderApplicationConfiguration } from "../provider-applications/index.js";
import { completeLinearInstallation } from "./linear/application.js";
import type { ProviderRegistration } from "./registration.js";
import { ProviderRegistry, type ProviderModule, type ProviderRuntimeInput } from "./registry.js";
import { createProviderRegistry } from "./server.js";
import { completeSlackInstallation } from "./slack/application.js";

/** A test composition using the same registration interface as bootstrap. */
export function registrationRegistry(
  create: (
    input: Omit<ProviderRuntimeInput, "configuration"> & {
      provider: ProviderApplicationConfiguration["provider"];
      configuration: ProviderApplicationConfiguration;
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
        create({
          ...input,
          provider: module.application.parseConfiguration(input.configuration).provider,
          configuration: module.application.parseConfiguration(input.configuration),
          onVerifiedSlackInstallation: (installation) =>
            input.onInstallation((options) => completeSlackInstallation(options, installation)),
          onVerifiedLinearInstallation: (installation) =>
            input.onInstallation((options) => completeLinearInstallation(options, installation)),
        }),
    });
  return new ProviderRegistry(modules);
}
