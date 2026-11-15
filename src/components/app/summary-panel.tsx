import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { CopyButton } from "./copy-field.js";

/**
 * One labelled fact. An `identifier` is a value someone reads out or pastes elsewhere — an ID, a
 * slug, a customer reference — so it renders monospaced with its own copy button.
 */
export type SummaryRow =
  | { label: string; value: ReactNode }
  | { label: string; identifier: string };

/**
 * What a finished piece of setup amounts to, as labelled rows rather than a stack of sentences.
 * Four anonymous lines of body text say the same words and give the eye nothing to land on; a
 * description list gives every fact a name, a place, and a shape a screen reader can navigate.
 */
export function SummaryPanel({
  label,
  rows,
  className,
}: {
  /** Identifies which summary this is, e.g. "GitHub app". */
  label: string;
  rows: readonly SummaryRow[];
  /** Placement in a parent grid only. Never used to change how the panel looks. */
  className?: string;
}) {
  return (
    <dl
      // No role override. A description list already exposes its rows as terms and definitions,
      // and naming the container costs exactly that. The attribute is a test hook, nothing more.
      data-summary={label}
      // Each fact's one-pixel outline, over a one-pixel gap, is the divider. No extra element,
      // and the rows reflow into one column on a phone without the rules ending up in the wrong
      // places. The panel itself is card-coloured, so the empty end of a short last row reads as
      // panel rather than as a block of divider colour.
      //
      // The tracks are fitted rather than fixed at two: a panel of one fact filled half a box
      // and left the other half empty.
      className={cn(
        "grid gap-px overflow-hidden rounded-xl border bg-card sm:grid-cols-[repeat(auto-fit,minmax(16rem,1fr))]",
        className,
      )}
    >
      {rows.map((row) => (
        <div
          key={row.label}
          className="grid content-start gap-1 bg-card px-4 py-3 outline outline-border"
        >
          <dt className="text-xs text-muted-foreground">{row.label}</dt>
          {"identifier" in row ? (
            <dd className="flex min-w-0 items-center gap-2 text-sm">
              <span className="min-w-0 font-mono text-xs break-words">{row.identifier}</span>
              {/* The button is taller than the line. Pulled into the cell's padding so an
                  identifier's value sits on the same line as its neighbours' values. */}
              <span className="-my-1 shrink-0">
                <CopyButton label={row.label} value={row.identifier} />
              </span>
            </dd>
          ) : (
            <dd className="min-w-0 text-sm break-words">{row.value}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}
