import type { ProviderSetupFailure } from "../presentation.js";
export const failure: ProviderSetupFailure = {
  host: "linear.app",
  applicationNoun: "application",
  credentials(subject) {
    if (subject === "identityMismatch") return identityMismatchMessage();
    return "Linear rejected these app credentials. Nothing was saved. Check the Client ID and Client Secret in the Linear application, then continue again.";
  },
};
function identityMismatchMessage(): string {
  return "The Linear Client ID and Client Secret do not belong to the same application. Nothing was saved. Copy both from one Linear application, then continue again.";
}
