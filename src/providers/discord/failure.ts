import type { ProviderSetupFailure } from "../presentation.js";
export const failure: ProviderSetupFailure = {
  host: "discord.com",
  applicationNoun: "application",
  credentials(subject) {
    if (subject === "identityMismatch") return identityMismatchMessage();
    if (subject === "botToken") {
      return "Discord rejected the bot token. Nothing was saved. Open Bot → Reset Token, copy the new token, then verify again.";
    }
    if (subject === "clientSecret") {
      return "Discord rejected the Client Secret. Nothing was saved. Open OAuth2, reset the Client Secret, copy it, then verify again.";
    }
    return "Discord rejected these credentials. Nothing was saved. Check the Application ID, Client Secret, and bot token, then verify again.";
  },
  diagnostic: discordGatewayDiagnostic,
  special(_code, subject) {
    if (subject !== "discordGatewayDisallowedIntents") return undefined;
    return {
      kind: "permissionMissing",
      message:
        "Discord refused the bot because Message Content Intent is off, so it would only receive empty messages. Nothing was saved. Turn it on under Bot → Privileged Gateway Intents, save in Discord, then verify again.",
    };
  },
};
function identityMismatchMessage(): string {
  return "That bot token belongs to a different Discord application than the Application ID you entered. Nothing was saved. Copy both values from the same application, then verify again.";
}
function discordGatewayDiagnostic(
  error: unknown,
): { gatewayCloseCode: number; gatewayFailure: string } | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.name === "DiscordGatewayError") {
      const gatewayCloseCode: unknown = Reflect.get(current, "gatewayCloseCode");
      const gatewayFailure: unknown = Reflect.get(current, "gatewayFailure");
      return typeof gatewayCloseCode === "number" && typeof gatewayFailure === "string"
        ? { gatewayCloseCode, gatewayFailure }
        : undefined;
    }
    current = current.cause;
  }
  return undefined;
}
