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
  icon,
  title,
  description,
  action,
  footer,
  children,
  className,
}: {
  /** A glyph identifying what the card is about, beside its title. */
  icon?: ReactNode;
  title?: string;
  description?: string;
  /** A single trailing link or button belonging to the card, not to its body. */
  action?: ReactNode;
  /** Optional: a card that is only a title and an action is still a card. */
  children?: ReactNode;
  /**
   * A quiet line closing the card: one fact about its records, and links to where they are
   * listed in full.
   */
  footer?: SurfaceFooter;
  /** Placement in a parent grid only. Never used to change how the card looks. */
  className?: string;
}) {
  const titled = title !== undefined || description !== undefined || action !== undefined;
  return (
    <section className={cn("grid min-w-0 gap-4 rounded-xl border bg-card p-6", className)}>
      {titled ? (
        <div className="flex min-w-0 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            {icon === undefined ? null : (
              <span aria-hidden="true" className="flex shrink-0 items-center [&>svg]:size-4">
                {icon}
              </span>
            )}
            <div className="grid min-w-0 gap-1">
              {title === undefined ? null : (
                <h2 className="text-base font-title text-foreground">{title}</h2>
              )}
              {description === undefined ? null : (
                <p className="text-sm text-muted-foreground">{description}</p>
              )}
            </div>
          </div>
          {action === undefined ? null : <div className="shrink-0">{action}</div>}
        </div>
      ) : null}
      {children}
      {footer === undefined ? null : <CardFooter {...footer} />}
    </section>
  );
}

/** A quiet line closing a bordered surface, and at most a control or two at its far end. */
export interface SurfaceFooter {
  note: string;
  actions?: ReactNode;
}

/**
 * The closing line of a `Card` or a `Disclosure`, one anatomy for both: a rule, a muted note,
 * and its actions at the far edge. The surface spaces it from the body above.
 */
export function CardFooter({ note, actions }: SurfaceFooter) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-4">
      <p className="text-xs text-muted-foreground tabular-nums">{note}</p>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
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
