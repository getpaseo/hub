import type { ProviderSetupFailure } from "../presentation.js";
export const failure: ProviderSetupFailure = {
  host: "slack.com",
  applicationNoun: "application",
  credentials(subject) {
    if (subject === "identityMismatch") return identityMismatchMessage();
    if (subject === "appToken") {
      return "Slack rejected the app-level token. Nothing was saved. Open Basic Information → App-Level Tokens, generate one with connections:write, then connect again.";
    }
    if (subject === "botToken") {
      return "Slack rejected the bot token. Nothing was saved. Reinstall the app in that workspace, copy its new bot token, then connect again.";
    }
    return "Slack rejected these app credentials. Nothing was saved. Check every value under Basic Information → App Credentials, then continue again.";
  },
  special(code, subject) {
    if (code !== "permissionMissing") return undefined;
    return { kind: "permissionMissing", message: slackPermissionMessage(subject) };
  },
};
function identityMismatchMessage(): string {
  return "The app-level token and bot token belong to different Slack apps. Nothing was saved. Copy both tokens from the same app, then connect again.";
}
function slackPermissionMessage(subject: string | undefined): string {
  if (subject === "appToken") {
    return "The app-level token is missing connections:write. Nothing was saved. Generate a new app-level token with that scope, then connect again.";
  }
  return "The bot token is missing permissions Hub needs. Nothing was saved. Reapply the Socket Mode manifest, reinstall the app in the workspace, then connect again.";
}
