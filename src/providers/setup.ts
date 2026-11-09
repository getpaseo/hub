import type { ProviderSetupInput, ProviderSetupRetry } from "./presentation.js";

/** The ordinary verification path; a provider may select a native setup operation instead. */
export async function saveProviderApplication(provider: string, input: ProviderSetupInput) {
  const { verifyAndSaveProviderApplication } =
    await import("../provider-applications/functions.js");
  return verifyAndSaveProviderApplication({
    data: {
      provider,
      surface: input.surface,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      ...input.values,
    },
  });
}

export function executeProviderRetry(action: ProviderSetupRetry) {
  return action.execute();
}
