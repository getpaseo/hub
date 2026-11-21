import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * A labelled group of related content. Owns its own bottom margin so callers never add spacing
 * between sections — the section decides how far apart sections sit.
 */
export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string;
  description?: string;
  /** A single trailing link or button, e.g. "View all". */
  action?: ReactNode;
  children: ReactNode;
  /** Placement in a parent grid only. Never used to change how the section looks. */
  className?: string;
}) {
  return (
    <section className={cn("mb-8 grid min-w-0 gap-3 last:mb-0", className)}>
      {title === undefined ? null : (
        <div
          className={cn(
            "flex min-w-0 justify-between gap-4",
            description === undefined ? "items-center" : "items-start",
          )}
        >
          <div className="grid min-w-0 gap-1">
            <h2 className="text-base font-title text-foreground">{title}</h2>
            {description === undefined ? null : (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {action === undefined ? null : <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
