import type { ProviderSetupFailure } from "../presentation.js";
export const failure: ProviderSetupFailure = {
  host: "api.github.com",
  applicationNoun: "App",
  credentials(subject) {
    if (subject === "identityMismatch") return identityMismatchMessage();
    if (subject === "privateKey") {
      return "GitHub rejected the Private key for this App. Nothing was saved. Generate a new private key on the App's settings page, paste the whole .pem file, then verify again.";
    }
    return "GitHub rejected these credentials. Nothing was saved. Check the App ID and Private key on the App's settings page, then verify again.";
  },
};
function identityMismatchMessage(): string {
  return "These credentials belong to a different GitHub App than the App ID you entered. Nothing was saved. Copy the App ID from the same App's settings page, then verify again.";
}
