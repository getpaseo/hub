import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { tenantContext } from "./functions.js";
import type { ProjectDashboard } from "./dashboard.js";

type TenantContextValue = Awaited<ReturnType<ProjectDashboard["tenantContext"]>>;

/**
 * Which organization and project the URL is in, once the server has confirmed them.
 *
 * The provider always renders its children. Resolving a tenant is the dashboard's own business,
 * and the dashboard is what wraps it: if the provider returned a placeholder instead, the sidebar
 * and site header would go with it, and a slow tenant read would look like the app unmounting.
 * The shell reads `useRouteTenantStatus` and puts the pending or failed state in its content slot.
 */
export type RouteTenantStatus =
  | { state: "outside" }
  | { state: "pending" }
  | { state: "failed"; title: string; message: string }
  | { state: "ready" };

const ProjectTenantContext = createContext<TenantContextValue | null>(null);
const RouteTenantStatusContext = createContext<RouteTenantStatus>({ state: "outside" });

export function RouteTenantProvider({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const scope = routeScope(pathname);
  const load = useServerFn(tenantContext);
  const snapshot = useQuery({
    queryKey: ["tenant", scope?.organizationSlug, scope?.projectSlug],
    queryFn: () => load({ data: scope! }),
    enabled: scope !== undefined,
  });
  const tenant = scope !== undefined && snapshot.data?.status === "ok" ? snapshot.data.data : null;
  // The status is recomputed only when the read moves, so the whole dashboard below does not
  // rerender because something else in the tree did.
  const outside = scope === undefined;
  const projectScoped = scope?.projectSlug !== undefined;
  const pending = snapshot.isPending;
  const failure = readFailure(snapshot);
  const status = useMemo(
    () => tenantStatus({ outside, projectScoped, pending, failure }),
    [outside, projectScoped, pending, failure],
  );
  return (
    <RouteTenantStatusContext.Provider value={status}>
      <ProjectTenantContext.Provider value={tenant}>{children}</ProjectTenantContext.Provider>
    </RouteTenantStatusContext.Provider>
  );
}

/** The server's message, the empty string when the request never arrived, undefined when it worked. */
function readFailure(snapshot: {
  isError: boolean;
  data: { status: "ok" } | { status: "error"; error: { message: string } } | undefined;
}): string | undefined {
  if (snapshot.data?.status === "error") return snapshot.data.error.message;
  return snapshot.isError ? "" : undefined;
}

/** `failure` is the server's message, the empty string for a request that never arrived. */
function tenantStatus(read: {
  outside: boolean;
  projectScoped: boolean;
  pending: boolean;
  failure: string | undefined;
}): RouteTenantStatus {
  if (read.outside) return { state: "outside" };
  if (read.pending) return { state: "pending" };
  if (read.failure !== undefined) {
    const title = read.projectScoped ? "Project unavailable" : "Organization unavailable";
    return { state: "failed", title, message: read.failure === "" ? `${title}.` : read.failure };
  }
  return { state: "ready" };
}

export function useRouteTenant(): TenantContextValue {
  const tenant = useContext(ProjectTenantContext);
  if (tenant === null) throw new Error("useRouteTenant used outside an organization route");
  return tenant;
}

export function useOptionalRouteTenant(): TenantContextValue | null {
  return useContext(ProjectTenantContext);
}

export function useRouteTenantStatus(): RouteTenantStatus {
  return useContext(RouteTenantStatusContext);
}

export function routeScope(
  pathname: string,
): { organizationSlug: string; projectSlug?: string } | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "o" || segments[1] === undefined) return undefined;
  const projectIndex = segments.indexOf("projects");
  const projectSlug = projectIndex >= 0 ? segments[projectIndex + 1] : undefined;
  return {
    organizationSlug: decodeURIComponent(segments[1]),
    ...(projectSlug === undefined ? {} : { projectSlug: decodeURIComponent(projectSlug) }),
  };
}
