/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- dynamic tenant URLs are assembled from server-resolved route metadata */
import { Link, useRouterState } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import { useCallback } from "react";

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../components/ui/sidebar.js";

export interface NavigationItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** The destination owns pages beneath it, so it stays lit while any of them is open. */
  subtree?: boolean;
}

/**
 * The destinations for one level of the app, and only those. A group that is not the outermost
 * level leads with its way back out, set apart by a rule — going up is not a sibling of going
 * across, and putting it in the same list would make it look like one.
 */
export function NavigationGroup({
  label,
  back,
  items,
}: {
  /** Names the level, e.g. "Organization". Becomes the landmark's accessible name. */
  label: string;
  back?: NavigationItem;
  items: readonly NavigationItem[];
}) {
  return (
    <nav aria-label={label}>
      <SidebarGroup>
        {back === undefined ? null : (
          <>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavItem item={back} />
              </SidebarMenu>
            </SidebarGroupContent>
            <SidebarSeparator className="my-2" />
          </>
        )}
        <SidebarGroupContent>
          <SidebarMenu>
            {items.map((item) => (
              <NavItem key={item.to} item={item} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </nav>
  );
}

/**
 * Navigation stays inside the running app. A plain anchor reloads the document, which
 * throws away the resolved account and repaints the pre-auth shell on every hop.
 */
function NavItem({ item }: { item: NavigationItem }) {
  const { to, label, icon: Icon, subtree = false } = item;
  const active = useRouterState({
    select: (state) =>
      state.location.pathname === to || (subtree && state.location.pathname.startsWith(`${to}/`)),
  });
  const { isMobile, setOpenMobile } = useSidebar();
  // On compact the sidebar is an overlay covering the destination. A document load used
  // to dismiss it; client-side navigation has to dismiss it deliberately.
  const navigate = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={label}>
        <Link to={to as never} aria-current={active ? "page" : undefined} onClick={navigate}>
          <Icon aria-hidden="true" />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
