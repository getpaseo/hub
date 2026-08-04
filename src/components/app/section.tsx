import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * A labelled group of related content. Owns its own bottom margin so callers never
 * add spacing between sections — the section decides how far apart sections sit.
 */
export function Section({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-8 grid min-w-0 gap-3 last:mb-0", className)}>
      {title === undefined ? null : (
        <div className="grid min-w-0 gap-1">
          <h2 className="text-sm font-medium">{title}</h2>
          {description === undefined ? null : (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
