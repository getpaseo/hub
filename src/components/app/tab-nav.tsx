/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- tenant-scoped paths are assembled from server-resolved route metadata */
import { Link, useRouterState } from "@tanstack/react-router";

import { cn } from "../../lib/utils.js";

export interface TabNavItem {
  to: string;
  label: string;
}

/**
 * Navigate between sibling routes under one page. A rail with the active tab underlined in the
 * text colour, so the tab strip reads as part of the page rather than as a second set of
 * buttons — the active tab is a colour step at the same size, and the rule under it is the only
 * decoration. Owns the space between itself and the page below it.
 *
 * These are routes. A control that swaps state without changing the URL is `SegmentedControl`.
 */
export function TabNav({ label, items }: { label: string; items: readonly TabNavItem[] }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <nav aria-label={label} className="mb-6 flex flex-wrap gap-4 border-b">
      {items.map((item) => {
        const active = pathname === item.to;
        return (
          <Link
            key={item.to}
            to={item.to as never}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex h-9 items-center border-b text-sm transition-colors duration-150",
              active
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
