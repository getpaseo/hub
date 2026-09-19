import { trimPathRight, useMatches } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    breadcrumb?: string;
    instance?: boolean;
    tabs?: boolean;
    projectSection?: "overview" | "configuration" | "activity" | "settings";
  }
}

/** Shared layout context comes from the routes TanStack is presenting, including pending UI. */
export function usePageContext() {
  return useMatches({
    select: (matches) => ({
      breadcrumbs: matches.flatMap(({ staticData }) =>
        staticData.breadcrumb === undefined ? [] : [staticData.breadcrumb],
      ),
      instance: matches.some(({ staticData }) => staticData.instance === true),
      tabs: matches.some(({ staticData }) => staticData.tabs === true),
      projectSection:
        matches
          .flatMap(({ staticData }) =>
            staticData.projectSection === undefined ? [] : [staticData.projectSection],
          )
          .at(-1) ?? "overview",
    }),
    structuralSharing: true,
  });
}

/** Parameters are already decoded by the router; never reconstruct tenant identity from a URL. */
export function usePresentedTenantScope():
  | { organizationSlug: string; projectSlug?: string }
  | undefined {
  return useMatches({
    select: (matches) => {
      const params = matches.at(-1)!.params;
      return "organizationSlug" in params
        ? { organizationSlug: params.organizationSlug }
        : undefined;
    },
    structuralSharing: true,
  });
}

/** Links reflect the presented route tree, rather than the URL of an unfinished navigation. */
export function usePresentedDestination(to: string, subtree = false): boolean {
  return useMatches({
    select: (matches) =>
      (subtree ? matches : matches.slice(-1)).some(
        (match) => trimPathRight(match.pathname) === trimPathRight(to),
      ),
  });
}
