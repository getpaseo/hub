import type { QueryClient } from "@tanstack/react-query";
import type { ConnectionProvider, GenericProviderConnectionStatus } from "./functions.js";
import { connectionProviderName } from "./result-contract.js";

export type ProviderConnectionStatus = GenericProviderConnectionStatus;

export function connectionsQueryKey(accountId: string, organizationId: string) {
  return ["connections", accountId, organizationId] as const;
}

export async function refreshConnections(
  queryClient: QueryClient,
  accountId: string,
  organizationId: string,
): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: connectionsQueryKey(accountId, organizationId),
    refetchType: "all",
  });
}

export function hasProviderBinding(status: ProviderConnectionStatus): boolean {
  return (
    status.status === "connected" ||
    status.status === "suspended" ||
    status.status === "requiresReauthorization"
  );
}

export function providerBindingDetail(
  provider: ConnectionProvider,
  status: ProviderConnectionStatus,
): string | undefined {
  if (!hasProviderBinding(status)) return undefined;
  const name = connectionProviderName(provider);
  if (status.status === "suspended") return `${name} suspended`;
  if (status.status === "requiresReauthorization") return `${name} reauthorization required`;
  return name;
}
