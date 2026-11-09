import type { ProviderRegistry, ProviderVerificationOptions } from "../../providers/registry.js";
import type { ProviderApplicationVerifier } from "../index.js";
import { ProviderVerificationError } from "../index.js";
/** @package */
export function createProviderApplicationVerifier(
  registry: ProviderRegistry,
  options: ProviderVerificationOptions = {},
): ProviderApplicationVerifier {
  return {
    verify(provider, configuration) {
      const application = registry.require(provider).application;
      if (provider !== configuration.provider || application.verify === undefined)
        return Promise.reject(new ProviderVerificationError("credentialsRejected"));
      return application.verify(configuration, options);
    },
  };
}
