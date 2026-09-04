import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Skeleton } from "../ui/skeleton.js";

/**
 * The one bordered surface. Anything that would otherwise be a hand-rolled `rounded-* border
 * bg-card p-*` div is this, so every card on the dashboard has the same radius, the same
 * padding, and the same distance from its title to its body. Title and description are
 * optional: a card with neither is just the box.
 */
export function Card({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string;
  description?: string;
  /** A single trailing link or button belonging to the card, not to its body. */
  action?: ReactNode;
  /** Optional: a card that is only a title and an action is still a card. */
  children?: ReactNode;
  /** Placement in a parent grid only. Never used to change how the card looks. */
  className?: string;
}) {
  const titled = title !== undefined || description !== undefined || action !== undefined;
  return (
    <section className={cn("grid min-w-0 gap-4 rounded-xl border bg-card p-6", className)}>
      {titled ? (
        <div className="flex min-w-0 items-start justify-between gap-4">
          <div className="grid min-w-0 gap-1">
            {title === undefined ? null : <h2 className="text-sm text-foreground">{title}</h2>}
            {description === undefined ? null : (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {action === undefined ? null : <div className="shrink-0">{action}</div>}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** The same box before its contents are known, so nothing moves when they land. */
export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-busy="true" className="grid min-w-0 gap-3 rounded-xl border bg-card p-6">
      {Array.from({ length: lines }, (_, line) => (
        <Skeleton key={line} className={cn("h-4", line === 0 ? "w-40" : "w-full")} />
      ))}
    </div>
  );
}
