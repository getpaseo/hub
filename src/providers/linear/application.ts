import type { AccountAccessValue } from "../../auth/organization-access.js";
import type { BindLinearConnectionInput } from "./persistence-types.js";

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
import type { LinearInstallation } from "../linear/client.js";
import type { LinearProviderApplicationConfiguration } from "./application-configuration.js";
import { configurationSchema } from "./application-configuration.js";
import { linearPersistence, type LinearPersistence } from "./persistence.js";
const parseProviderApplicationConfiguration = (input: unknown) => configurationSchema.parse(input);
export async function beginLinearConfiguration(
  options: ProviderApplicationsOptions,
  request: Request,
  account: AccountAccessValue,
  callbackOrigin: string,
  input: LinearProviderApplicationConfiguration,
  returnRoute: string,
): Promise<ProviderApplicationContinuation> {
  requireHttpsOrigin(callbackOrigin);
  const previous = await options.store.read("linear");
  if (previous?.version !== input.expectedVersion) {
    throw new ProviderApplicationError("configurationConflict");
  }
  const organizationId = account.session.activeOrganizationId;
  if (organizationId === null || options.beginCandidateConnection === undefined) {
    throw new ProviderApplicationError("invalidInput");
  }
  const candidate = await options.runtime.prepare(
    "linear",
    withoutExpectedVersion(input),
    callbackOrigin,
    { provider: "linear", id: input.clientId, name: "Linear app" },
    (input.expectedVersion ?? 0) + 1,
    {
      expectedConfigurationVersion: input.expectedVersion,
      activateConfiguration: true,
    },
  );
  if (candidate.beginConnection === undefined) {
    await closeCandidate(candidate, "linear", "begin_configuration");
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
    return { status: "continuing", provider: "linear", url };
  } catch (error) {
    await closeCandidate(candidate, "linear", "begin_configuration");
    if (error instanceof ProviderApplicationError) throw error;
    throw new ProviderApplicationError("internal", undefined, { cause: error });
  }
}

export async function completeLinearInstallation(
  options: ProviderApplicationsOptions,
  input: {
    configuration: unknown;
    expectedConfigurationVersion: number | undefined;
    callbackOrigin: string;
    userId: string;
    installation: LinearInstallation;
    binding: BindLinearConnectionInput;
  },
  persistence: Pick<LinearPersistence, "completeLinearProviderApplication"> = linearPersistence(
    options.database,
  ),
): Promise<void> {
  const configuration = parseProviderApplicationConfiguration(input.configuration);
  if (
    configuration.provider !== "linear" ||
    configuration.clientId !== input.binding.providerApplicationId
  ) {
    throw new ProviderApplicationError("credentialsRejected");
  }
  const previous = await options.store.read("linear");
  const connections = await options.inventory.connectedIdentities("linear");
  const identity: ProviderApplicationIdentity = {
    provider: "linear",
    id: configuration.clientId,
    name: "Linear app",
  };
  if (identityConflictsWithConnections(identity, previous, connections)) {
    throw new ProviderApplicationError("identityConflict", previous?.identity.name);
  }
  let candidate: ProviderRuntimeCandidate | undefined;
  try {
    candidate = await options.runtime.prepare(
      "linear",
      configuration,
      input.callbackOrigin,
      identity,
      (input.expectedConfigurationVersion ?? 0) + 1,
    );
    await candidate.start();
    await persistence.completeLinearProviderApplication({
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
    await closeCandidate(candidate, "linear", "complete_installation");
    throw error;
  }
}
