import { useRouterState } from "@tanstack/react-router";
import { Fragment, useEffect, useRef } from "react";

import { cn } from "../lib/utils.js";
import { Separator } from "../components/ui/separator.js";
import { SidebarTrigger, useSidebar } from "../components/ui/sidebar.js";
import { SiteHeaderActionsTarget } from "./site-header-actions.js";

/**
 * Header context, not a second title. The page owns its `<h1>`; this says where that page sits,
 * which is why it leads with where you are — the same scope the sidebar header stacks — rather
 * than repeating the view. Everything but the last crumb hides on a phone, so the trail always
 * ends on the thing the reader is looking at.
 */
export function SiteHeader({ scope, project }: { scope: string; project?: string }) {
  const trail = useRouterState({ select: (state) => viewTrail(state.location.pathname) });
  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
      <RestoringSidebarTrigger />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 items-center gap-1.5 overflow-hidden text-sm"
      >
        <span className="truncate text-muted-foreground">{scope}</span>
        {project === undefined ? null : (
          <>
            <CrumbSeparator compact />
            <span className="hidden truncate text-muted-foreground sm:inline">{project}</span>
          </>
        )}
        {trail.map((entry, index) => (
          <Fragment key={entry}>
            <CrumbSeparator />
            <span
              className={cn(
                "truncate",
                index < trail.length - 1 && "hidden text-muted-foreground sm:inline",
              )}
            >
              {entry}
            </span>
          </Fragment>
        ))}
      </nav>
      <SiteHeaderActionsTarget />
    </header>
  );
}

/** The quietest mark on the page: a rule between crumbs, missable by design. */
function CrumbSeparator({ compact = false }: { compact?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn("text-extra-muted-foreground", compact && "hidden sm:inline")}
    >
      /
    </span>
  );
}

function RestoringSidebarTrigger() {
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const { isMobile, openMobile } = useSidebar();

  useEffect(() => {
    if (isMobile && wasOpen.current && !openMobile) trigger.current?.focus();
    wasOpen.current = openMobile;
  }, [isMobile, openMobile]);

  return <SidebarTrigger ref={trigger} className="-ml-1" />;
}

// Longest suffix first: an organization settings path ends with `/settings/team`, a project
// settings path ends with `/settings`, and only the first match may win.
const ROUTE_SECTIONS = [
  { suffix: "/settings/api-keys", label: "API keys", group: "Settings" },
  { suffix: "/settings/team", label: "Team", group: "Settings" },
  { suffix: "/settings/usage", label: "Usage", group: "Settings" },
  { suffix: "/settings/billing", label: "Billing", group: "Settings" },
  { suffix: "/settings", label: "Settings", projectSection: "settings" },
  { suffix: "/configuration", label: "Configuration", projectSection: "configuration" },
  { suffix: "/activity", label: "Activity", projectSection: "activity" },
  { suffix: "/overview", label: "Overview", projectSection: "overview" },
  { suffix: "/triggers", label: "Triggers" },
  { suffix: "/projects", label: "Projects" },
  { suffix: "/daemons", label: "Daemons" },
  { suffix: "/connections", label: "Connections" },
  { suffix: "/apps", label: "Apps" },
  { suffix: "/operator", label: "Operator" },
] as const;

/** Which surface a pathname is, for the breadcrumb and for the project switcher's target. */
export function routeSection(pathname: string) {
  return ROUTE_SECTIONS.find((route) => pathname.endsWith(route.suffix));
}

function viewTrail(pathname: string): string[] {
  if (/\/triggers\/[^/]+$/u.test(pathname)) return ["Triggers", "Trigger editor"];
  const section = routeSection(pathname);
  if (section === undefined) return ["Register daemon"];
  return "group" in section ? [section.group, section.label] : [section.label];
}
