import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Card } from "./card.js";

/**
 * An overview figure. The number is bigger, never heavier, and sits in a fixed-height box so a
 * tile does not resize when its data resolves — the loading, empty, and loaded states occupy
 * the same space.
 */
export function StatTile({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  icon?: LucideIcon;
}) {
  return (
    <Card>
      <div className="grid gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {Icon === undefined ? null : <Icon aria-hidden="true" className="size-4" />}
          {label}
        </div>
        <div className="grid min-h-11 content-start gap-1">
          <p className="text-2xl leading-none tabular-nums">{value}</p>
          <p className="min-h-5 text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>
    </Card>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}
