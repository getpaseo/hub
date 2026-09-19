import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * The one way a record shows two facts: what it is, over the quieter fact that identifies it.
 * Emphasis here is colour and size, never weight, and both lines truncate rather than wrap so
 * a table row keeps its height whatever the data is.
 */
export function TwoLine({
  primary,
  secondary,
  mono = false,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  /** The secondary line is an identifier — a key prefix, a slug, an id — not prose. */
  mono?: boolean;
}) {
  return (
    <span className="grid min-w-0 gap-0.5">
      <span className="truncate text-sm">{primary}</span>
      {secondary === undefined ? null : (
        <span className={cn("truncate text-xs text-muted-foreground", mono && "font-mono")}>
          {secondary}
        </span>
      )}
    </span>
  );
}
