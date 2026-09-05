import { Children, isValidElement, type ReactNode } from "react";

/**
 * A sequence of cards read in order, numbered in the gutter and joined by a rail.
 *
 * The number is decoration: the list is an `ol`, so the order is already carried for a reader
 * who cannot see the rail, and the marker is hidden from them rather than announced twice. A
 * child that renders nothing is not a step — `Children.toArray` drops it — so a decision that
 * removes a step renumbers the ones after it instead of leaving a gap.
 *
 * Each child is a surface of its own; in practice a `Card`. Steps owns the distance between
 * them, so a caller never spaces the run itself.
 */
export function Steps({ children }: { children: ReactNode }) {
  const steps = Children.toArray(children).filter((step) => isValidElement(step));
  return (
    <ol className="grid gap-3">
      {steps.map((step, index) => (
        <li
          key={isValidElement(step) ? (step.key ?? index) : index}
          className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)] gap-4"
        >
          {/* The marker sits on the card's first line: `mt-6` is the card's own top padding. */}
          <span aria-hidden="true" className="flex flex-col items-center">
            <span className="mt-6 grid size-6 shrink-0 place-items-center rounded-full border bg-card text-xs text-muted-foreground">
              {index + 1}
            </span>
            {index === steps.length - 1 ? null : <span className="mt-2 w-px flex-1 bg-border" />}
          </span>
          {step}
        </li>
      ))}
    </ol>
  );
}
