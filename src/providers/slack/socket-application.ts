import type {
  ProviderApplicationResult,
  ProviderApplicationsOptions,
  ProviderRuntimeCandidate,
} from "../../provider-applications/index.js";
import {
  ProviderApplicationError,
  ProviderVerificationError,
} from "../../provider-applications/index.js";
import type { ProviderApplicationContext } from "../../provider-applications/workflow.js";
import {
  closeCandidate,
  isConfigurationConflict,
  isIdentityConflict,
} from "../../provider-applications/workflow.js";
import type { SlackSocketInstallationVerifier } from "./installation.js";
import { slackPersistence, type SlackPersistence } from "./persistence.js";
export async function configureSocket(
  {
    options,
    request,
    account,
  }: Pick<ProviderApplicationContext, "options" | "request" | "account">,
  input: { appToken: string; botToken: string; expectedVersion?: number },
  verifier: SlackSocketInstallationVerifier,
  persistence: Pick<SlackPersistence, "completeSlackSocketApplication"> = slackPersistence(
    options.database,
  ),
): Promise<ProviderApplicationResult> {
  if (!input.appToken.startsWith("xapp-") || !input.botToken.startsWith("xoxb-")) {
    throw new ProviderApplicationError("invalidInput");
  }
  const organizationId = account.session.activeOrganizationId;
  if (organizationId === null) throw new ProviderApplicationError("invalidInput");
  let installation: Awaited<ReturnType<SlackSocketInstallationVerifier["verify"]>>;
  try {
    installation = await verifier.verify(input.appToken, input.botToken);
  } catch (error) {
    if (error instanceof ProviderVerificationError) {
      throw new ProviderApplicationError(error.reason, error.subject, { cause: error });
    }
    throw new ProviderApplicationError("internal", undefined, { cause: error });
  }
  const configuration = {
    provider: "slack" as const,
    transport: "socket" as const,
    appId: installation.appId,
    appToken: input.appToken,
  };
  const identity = {
    provider: "slack" as const,
    id: installation.appId,
    name: installation.appId,
  };
  let candidate: ProviderRuntimeCandidate | undefined;
  try {
    candidate = await options.runtime.prepare(
      "slack",
      configuration,
      await socketCallbackOrigin(options, request),
      identity,
      (input.expectedVersion ?? 0) + 1,
    );
    await candidate.start();
    const saved = await persistence.completeSlackSocketApplication({
      configuration,
      identity,
      expectedVersion: input.expectedVersion,
      updatedByUserId: account.account.id,
      organizationId,
      installation,
    });
    candidate.publish();
    candidate = undefined;
    return {
      status: "verified",
      provider: "slack",
      identity,
      configurationVersion: saved.version,
    };
  } catch (error) {
    await closeCandidate(candidate, "slack", "configure_socket");
    if (isConfigurationConflict(error)) {
      throw new ProviderApplicationError("configurationConflict");
    }
    if (isIdentityConflict(error)) {
      throw new ProviderApplicationError("identityConflict");
    }
    if (error instanceof ProviderApplicationError) throw error;
    throw new ProviderApplicationError("internal", undefined, { cause: error });
  }
}
async function socketCallbackOrigin(
  options: ProviderApplicationsOptions,
  request: Request,
): Promise<string> {
  try {
    return await options.callbackOrigin(request);
  } catch (error) {
    throw new ProviderApplicationError("invalidOrigin", undefined, { cause: error });
  }
}
