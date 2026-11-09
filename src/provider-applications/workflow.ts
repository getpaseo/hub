import type { AccountAccessValue } from "../auth/organization-access.js";
import { reportFailure } from "../failures/index.js";
import type {
  ConnectedProviderIdentity,
  Provider,
  ProviderApplicationConfiguration,
  ProviderApplicationIdentity,
  ProviderApplicationsOptions,
  ProviderRuntimeCandidate,
  StoredProviderApplication,
} from "./index.js";
import { ProviderApplicationError } from "./index.js";
export interface ProviderApplicationContext {
  options: ProviderApplicationsOptions;
  request: Request;
  account: AccountAccessValue;
  callbackOrigin: string;
  returnRoute: string;
}
export function withoutExpectedVersion(
  input: ProviderApplicationConfiguration,
): ProviderApplicationConfiguration {
  const { expectedVersion: _expectedVersion, ...configuration } = input;
  return configuration as ProviderApplicationConfiguration;
}

export function sameExternalIdentity(
  left: ProviderApplicationIdentity,
  right: ProviderApplicationIdentity,
): boolean {
  return left.provider === right.provider && left.id === right.id;
}

export function identityConflictsWithConnections(
  identity: ProviderApplicationIdentity,
  previous: StoredProviderApplication | undefined,
  connections: readonly ConnectedProviderIdentity[],
): boolean {
  if (connections.length === 0) return false;
  if (
    connections.some(
      (connection) => connection.applicationId !== null && connection.applicationId !== identity.id,
    )
  ) {
    return true;
  }
  return (
    connections.some((connection) => connection.applicationId === null) &&
    (previous === undefined || !sameExternalIdentity(previous.identity, identity))
  );
}

export function isConfigurationConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    Reflect.get(error, "name") === "ProviderConfigurationConflictError"
  );
}

export function isIdentityConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    Reflect.get(error, "name") === "ProviderApplicationIdentityConflictError"
  );
}

export function requireHttpsOrigin(callbackOrigin: string): void {
  if (!callbackOrigin.startsWith("https://")) {
    throw new ProviderApplicationError("httpsRequired", callbackOrigin);
  }
}

export async function closeCandidate(
  candidate: ProviderRuntimeCandidate | undefined,
  provider: Provider,
  parentOperation: string,
): Promise<void> {
  if (candidate === undefined) return;
  try {
    await candidate.close();
  } catch (error) {
    reportFailure(error, {
      operation: `provider_application.${parentOperation}.cleanup`,
      component: "provider_applications",
      provider,
    });
  }
}
