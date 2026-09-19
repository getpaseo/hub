/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- server functions are erased to a generic call signature at the boundary */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";
import { FailureAlert } from "../components/app/failure-alert.js";
import { PanelSkeleton } from "../components/app/loading.js";
import type { Result } from "../contract/respond.js";
import { useRouteTenant } from "./context.js";
import type { ProjectDashboard } from "./dashboard.js";
import { organizationSnapshot, projectSnapshot } from "./functions.js";

/**
 * The load/command plumbing every dashboard panel shares: one snapshot query per
 * scope, one mutation shape, and the two states — pending and failed — a panel
 * renders instead of its content.
 */

export type OrganizationSnapshot = Awaited<ReturnType<ProjectDashboard["organizationSnapshot"]>>;
export type ProjectSnapshot = Awaited<ReturnType<ProjectDashboard["projectSnapshot"]>>;

export function useOrganizationSnapshot(pending?: ReactNode) {
  const tenant = useRouteTenant();
  const load = useServerFn(organizationSnapshot);
  const query = useQuery({
    queryKey: ["organization", tenant.account.id, tenant.organization.id],
    queryFn: () => load({ data: { organizationSlug: tenant.organization.slug } }),
  });
  return queryState<OrganizationSnapshot>(query, "Organization unavailable", pending);
}

export function useProjectSnapshot() {
  const tenant = useRouteTenant();
  const load = useServerFn(projectSnapshot);
  const scope = projectScope(tenant);
  const query = useQuery({
    queryKey: ["project", tenant.account.id, tenant.organization.id, tenant.project?.id],
    queryFn: () => load({ data: scope }),
  });
  return queryState<ProjectSnapshot>(query, "Project unavailable");
}

/**
 * The two states a panel renders instead of its content. `pending` is the panel's own skeleton;
 * without one it falls back to the generic panel shape, which is right only where the surface
 * cannot yet say what it is.
 */
export function queryState<T>(
  query: { isPending: boolean; isError: boolean; data: Result<T> | undefined },
  title: string,
  pending?: ReactNode,
): { ok: true; data: T } | { ok: false; element: ReactNode } {
  if (query.isPending) return { ok: false, element: pending ?? <PanelSkeleton /> };
  if (query.isError || query.data?.status !== "ok")
    return {
      ok: false,
      element: <FailureAlert title={title} error={query.data} fallback={`${title}.`} />,
    };
  return { ok: true, data: query.data.data };
}

export function useProjectCommand<TInput, TOutput = { state: "complete" }>(
  command: (input: TInput) => Promise<Result<TOutput>>,
  queryClient: ReturnType<typeof useQueryClient>,
  scope: { organizationSlug: string; projectSlug?: string },
) {
  return useMutation({
    mutationFn: useServerFn(command as never) as unknown as (
      input: TInput,
    ) => Promise<Result<TOutput>>,
    onSuccess: async (result) => {
      if (result.status === "ok") await invalidateScope(queryClient, scope);
    },
  });
}

export function CommandError({
  mutations,
}: {
  mutations: Array<{ data: Result<unknown> | undefined; isError: boolean }>;
}) {
  const failed = mutations.find(
    (mutation) => mutation.isError || mutation.data?.status === "error",
  );
  if (failed === undefined) return null;
  return (
    <FailureAlert
      standalone
      title="The last action didn't complete"
      error={failed.data}
      fallback="Hub did not receive the project action result. Check your connection and reload the current project state."
    />
  );
}

export async function invalidateScope(
  queryClient: ReturnType<typeof useQueryClient>,
  scope: { organizationSlug: string; projectSlug?: string },
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["organization"] }),
    queryClient.invalidateQueries({ queryKey: ["project"] }),
    queryClient.invalidateQueries({ queryKey: ["tenant", scope.organizationSlug] }),
  ]);
}

export async function invalidateOrganization(
  queryClient: ReturnType<typeof useQueryClient>,
  organizationSlug: string,
) {
  await invalidateScope(queryClient, { organizationSlug });
}

export function projectScope(tenant: ReturnType<typeof useRouteTenant>) {
  if (tenant.project === null) throw new Error("project route has no project context");
  return { organizationSlug: tenant.organization.slug, projectSlug: tenant.project.slug };
}
