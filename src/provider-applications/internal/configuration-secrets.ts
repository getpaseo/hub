import type { ProviderApplicationConfiguration } from "../index.js";

export function sensitiveConfigurationValues(
  configuration: ProviderApplicationConfiguration,
): readonly string[] {
  if (configuration.provider === "github") {
    return [
      configuration.clientSecret,
      configuration.privateKey,
      ...(configuration.webhookSecret === undefined ? [] : [configuration.webhookSecret]),
    ];
  }
  if (configuration.provider === "slack") {
    return configuration.transport === "socket"
      ? [configuration.appToken]
      : [configuration.clientSecret, configuration.signingSecret];
  }
  if (configuration.provider === "linear") {
    return [configuration.clientSecret, configuration.webhookSecret];
  }
  return [configuration.clientSecret, configuration.botToken];
}
