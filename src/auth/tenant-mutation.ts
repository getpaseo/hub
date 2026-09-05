import { useIsMutating } from "@tanstack/react-query";

export const TENANT_CONTEXT_MUTATION_KEY = ["tenant-context"] as const;
export const ACCOUNT_MUTATION_KEY = [...TENANT_CONTEXT_MUTATION_KEY, "account"] as const;
/**
 * Sending an invitation is an account mutation, but it is not one of *these*: a failure belongs
 * in the dialog the address was typed into, and this key is what keeps it out of the page-level
 * summary above the settings tabs.
 */
export const INVITATION_MUTATION_KEY = [...TENANT_CONTEXT_MUTATION_KEY, "invitation"] as const;
export const CONNECTION_MUTATION_KEY = [...TENANT_CONTEXT_MUTATION_KEY, "connections"] as const;
export const DAEMON_MUTATION_KEY = [...TENANT_CONTEXT_MUTATION_KEY, "daemon"] as const;
export const API_KEY_MUTATION_KEY = [...TENANT_CONTEXT_MUTATION_KEY, "api-keys"] as const;

export function useTenantContextMutationPending(): boolean {
  return useIsMutating({ mutationKey: TENANT_CONTEXT_MUTATION_KEY }) > 0;
}
