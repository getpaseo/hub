import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * The one way a record shows two facts: what it is, over the quieter fact that identifies it.
 * Emphasis here is colour and size, never weight, and both lines truncate rather than wrap so
 * a table row keeps its height whatever the data is. A line only truncates when whatever holds
 * it is narrower than the line: on its own it is as wide as its longer line, so a table column
 * sized to its content shows all of it. A string line carries itself as its title, so a value
 * that was cut is one hover away.
 */
export function TwoLine({
  primary,
  secondary,
  mono = false,
  path = false,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  /** The secondary line is an identifier — a key prefix, a slug, an id — not prose. */
  mono?: boolean;
  /**
   * The secondary line is a filesystem path: an identifier whose tail tells two records apart,
   * so it gives way from the start and keeps its end.
   */
  path?: boolean;
}) {
  return (
    // In a filling cell the record also takes the row it sits in, beside a glyph or not, so its
    // secondary line has the whole column to give way in rather than the primary line's width.
    <span className="flex min-w-0 flex-col gap-0.5 in-data-[slot=fill-cell]:grow">
      <span className="truncate text-sm" title={titleOf(primary)}>
        {primary}
      </span>
      {secondary === undefined ? null : (
        <span
          className={cn(
            // In a filling table cell the primary line sets the record's width and the secondary
            // line takes whatever that leaves: a model under a name, a path under a daemon, a
            // connection under an event. Otherwise one long path would claim the width a
            // neighbouring column needs for the fact a reader is scanning for.
            "truncate text-xs text-muted-foreground in-data-[slot=fill-cell]:w-0 in-data-[slot=fill-cell]:min-w-full",
            (mono || path) && "font-mono",
            path && "text-left",
          )}
          title={titleOf(secondary)}
          // Right-to-left puts the overflow, and the ellipsis, at the start of the line; the
          // isolate inside keeps the path itself reading left to right.
          {...(path ? { dir: "rtl" } : {})}
        >
          {path ? <bdi dir="ltr">{secondary}</bdi> : secondary}
        </span>
      )}
    </span>
  );
}

function titleOf(line: ReactNode): string | undefined {
  return typeof line === "string" ? line : undefined;
}
