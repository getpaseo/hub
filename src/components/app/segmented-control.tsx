/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- each item's ref callback and click handler are scoped to the option rendered beside them */
import type { LucideIcon } from "lucide-react";
import { useCallback, useRef, type KeyboardEvent } from "react";

import { cn } from "../../lib/utils.js";

export interface SegmentedOption {
  value: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
}

/**
 * Pick one of a few modes. A radio group, not a row of buttons: one stop in the tab order, the
 * arrow keys move between options, and a screen reader hears "2 of 3 selected" rather than
 * three unrelated buttons whose selected one is a shade of grey.
 *
 * For two or three short modes that swap what is below them. Anything longer is a `Select`, and
 * anything that navigates is `TabNav`.
 */
export function SegmentedControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly SegmentedOption[];
  onChange: (value: string) => void;
}) {
  const items = useRef(new Map<string, HTMLButtonElement>());
  const move = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const next = nextSegmentValue(options, value, event.key);
      if (next === undefined) return;
      event.preventDefault();
      onChange(next);
      items.current.get(next)?.focus();
    },
    [onChange, options, value],
  );

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={move}
      className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5"
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node === null) items.current.delete(option.value);
              else items.current.set(option.value, node);
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={option.disabled === true}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5",
              active
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon === undefined ? null : <Icon aria-hidden="true" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** Both axes move the selection: a segmented control is a row, but it may be read as a list. */
const ARROW_STEPS: Record<string, number | undefined> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * Where a key press moves the selection, or `undefined` when the key is not one this control
 * answers to. Disabled options are skipped rather than landed on and refused, and the ends
 * wrap, which is what a radio group does everywhere else.
 */
export function nextSegmentValue(
  options: readonly SegmentedOption[],
  value: string,
  key: string,
): string | undefined {
  const selectable = options.filter((option) => option.disabled !== true);
  const first = selectable[0];
  const last = selectable[selectable.length - 1];
  if (first === undefined || last === undefined) return undefined;
  if (key === "Home") return first.value === value ? undefined : first.value;
  if (key === "End") return last.value === value ? undefined : last.value;
  const step = ARROW_STEPS[key];
  if (step === undefined) return undefined;
  const current = selectable.findIndex((option) => option.value === value);
  if (current === -1) return step === 1 ? first.value : last.value;
  const next = selectable[(current + step + selectable.length) % selectable.length];
  if (next === undefined || next.value === value) return undefined;
  return next.value;
}
