import {
  defaultIntegrationRegistry,
  type IntegrationRegistry,
} from "../../integrations/registry.js";
import {
  isLegacyProviderApplicationConfiguration,
  type AnyProviderApplicationConfiguration,
} from "../index.js";

export function sensitiveConfigurationValues(
  configuration: AnyProviderApplicationConfiguration,
  registry: IntegrationRegistry = defaultIntegrationRegistry,
): readonly string[] {
  if (isLegacyProviderApplicationConfiguration(configuration)) {
    switch (configuration.provider) {
      case "github":
        return [
          configuration.clientSecret,
          configuration.privateKey,
          ...(configuration.webhookSecret === undefined ? [] : [configuration.webhookSecret]),
        ];
      case "slack":
        return configuration.transport === "socket"
          ? [configuration.appToken]
          : [configuration.clientSecret, configuration.signingSecret];
      case "linear":
        return [configuration.clientSecret, configuration.webhookSecret];
      case "discord":
        return [configuration.clientSecret, configuration.botToken];
    }
  }
  const integration = registry.get(configuration.provider);
  return integration === undefined ? [] : integration.connection.sensitiveValues(configuration);
}
