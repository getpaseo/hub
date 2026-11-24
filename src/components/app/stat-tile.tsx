/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- tenant-scoped paths are assembled from server-resolved route metadata */
import { Link } from "@tanstack/react-router";
import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Where a tile leads: the records its figure counts. */
export interface StatTileLink {
  to: string;
  /** The destination route's own search shape. */
  search?: object;
}

/**
 * An overview figure that opens the records it counts. The number is bigger, never heavier, and
 * sits in a fixed-height box so a tile does not resize when its data resolves — the loading,
 * empty, and loaded states occupy the same space. The whole tile is the link; hover is a step of
 * fill and the chevron's colour, as on every other row that navigates.
 */
export function StatTile({
  label,
  value,
  detail,
  icon: Icon,
  link,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  icon?: LucideIcon;
  link: StatTileLink;
}) {
  return (
    <Link
      to={link.to as never}
      search={link.search as never}
      className="group grid min-w-0 gap-3 rounded-xl border bg-card p-6 transition-colors duration-150 hover:bg-accent"
    >
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        {Icon === undefined ? null : <Icon aria-hidden="true" className="size-4" />}
        {label}
        <ChevronRight
          aria-hidden="true"
          className="ml-auto size-4 text-extra-muted-foreground transition-colors duration-150 group-hover:text-foreground"
        />
      </span>
      <span className="grid min-h-11 content-start gap-1">
        <span className="text-2xl leading-none tabular-nums text-foreground">{value}</span>
        <span className="min-h-5 text-xs text-muted-foreground">{detail}</span>
      </span>
    </Link>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}
