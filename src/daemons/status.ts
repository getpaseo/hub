import type { QueryClient } from "@tanstack/react-query";
import type { BrowserDaemon } from "./functions.js";

export function daemonsQueryKey(accountId: string, organizationId: string) {
  return ["daemons", accountId, organizationId] as const;
}

export async function refreshDaemons(
  queryClient: QueryClient,
  accountId: string,
  organizationId: string,
): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: daemonsQueryKey(accountId, organizationId),
    refetchType: "all",
  });
}

/** The first daemon a trigger can run on now: active, and connected to this Hub. */
export function connectedDaemon(daemons: readonly BrowserDaemon[]): BrowserDaemon | undefined {
  return daemons.find((daemon) => daemon.status === "active" && daemon.presence === "connected");
}
