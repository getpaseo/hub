import type { AccountAccessValue } from "../../auth/organization-access.js";
import type { BindSlackConnectionInput } from "./persistence-types.js";

import type {
  ProviderApplicationContinuation,
  ProviderApplicationIdentity,
  ProviderApplicationsOptions,
  ProviderRuntimeCandidate,
} from "../../provider-applications/index.js";
import { ProviderApplicationError } from "../../provider-applications/index.js";
import {
  closeCandidate,
  identityConflictsWithConnections,
  requireHttpsOrigin,
  withoutExpectedVersion,
} from "../../provider-applications/workflow.js";
import type { SlackProviderApplicationConfiguration } from "./application-configuration.js";
import { configurationSchema } from "./application-configuration.js";
import type { VerifiedSlackInstallation } from "./installation.js";
import { slackPersistence, type SlackPersistence } from "./persistence.js";
const parseProviderApplicationConfiguration = (input: unknown) => configurationSchema.parse(input);
export async function beginSlackConfiguration(
  options: ProviderApplicationsOptions,
  request: Request,
  account: AccountAccessValue,
  callbackOrigin: string,
  input: SlackProviderApplicationConfiguration,
  returnRoute: string,
): Promise<ProviderApplicationContinuation> {
  requireHttpsOrigin(callbackOrigin);
  const previous = await options.store.read("slack");
  if (previous?.version !== input.expectedVersion) {
    throw new ProviderApplicationError("configurationConflict");
  }
  const organizationId = account.session.activeOrganizationId;
  if (organizationId === null || options.beginCandidateConnection === undefined) {
    throw new ProviderApplicationError("invalidInput");
  }
  const candidate = await options.runtime.prepare(
    "slack",
    withoutExpectedVersion(input),
    callbackOrigin,
    { provider: "slack", id: input.appId, name: input.appId },
    (input.expectedVersion ?? 0) + 1,
    {
      expectedConfigurationVersion: input.expectedVersion,
      activateConfiguration: true,
    },
  );
  if (candidate.beginConnection === undefined) {
    await closeCandidate(candidate, "slack", "begin_configuration");
    throw new ProviderApplicationError("internal");
  }
  try {
    const { url } = await options.beginCandidateConnection(
      request,
      organizationId,
      returnRoute,
      (candidateRequest) => {
        const result = candidate.beginConnection?.(candidateRequest);
        return result ?? Promise.reject(new Error("provider unavailable"));
      },
    );
    await candidate.close();
    return { status: "continuing", provider: "slack", url };
  } catch (error) {
    await closeCandidate(candidate, "slack", "begin_configuration");
    if (error instanceof ProviderApplicationError) throw error;
    throw new ProviderApplicationError("internal", undefined, { cause: error });
  }
}

export async function completeSlackInstallation(
  options: ProviderApplicationsOptions,
  input: {
    configuration: unknown;
    expectedConfigurationVersion: number | undefined;
    callbackOrigin: string;
    userId: string;
    installation: VerifiedSlackInstallation;
    binding: BindSlackConnectionInput;
  },
  persistence: Pick<SlackPersistence, "completeSlackProviderApplication"> = slackPersistence(
    options.database,
  ),
): Promise<void> {
  const configuration = parseProviderApplicationConfiguration(input.configuration);
  if (configuration.provider !== "slack" || configuration.appId !== input.installation.appId) {
    throw new ProviderApplicationError("credentialsRejected");
  }
  const previous = await options.store.read("slack");
  const connections = await options.inventory.connectedIdentities("slack");
  const identity: ProviderApplicationIdentity = {
    provider: "slack",
    id: input.installation.appId,
    name: input.installation.appId,
  };
  if (identityConflictsWithConnections(identity, previous, connections)) {
    throw new ProviderApplicationError("identityConflict", previous?.identity.name);
  }
  let candidate: ProviderRuntimeCandidate | undefined;
  try {
    candidate = await options.runtime.prepare(
      "slack",
      configuration,
      input.callbackOrigin,
      identity,
      (input.expectedConfigurationVersion ?? 0) + 1,
    );
    await candidate.start();
    await persistence.completeSlackProviderApplication({
      ...input.binding,
      providerConfiguration: {
        configuration,
        identity,
        expectedVersion: input.expectedConfigurationVersion,
        updatedByUserId: input.userId,
      },
    });
    candidate.publish();
    candidate = undefined;
  } catch (error) {
    await closeCandidate(candidate, "slack", "complete_installation");
    throw error;
  }
}
