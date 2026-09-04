/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- each item's ref callback and click handler are scoped to the option rendered beside them */
import type { LucideIcon } from "lucide-react";
import {
  createElement,
  isValidElement,
  useCallback,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "../../lib/utils.js";

export interface SegmentedOption {
  value: string;
  label: string;
  /** A lucide component, drawn at the control's own size, or a mark that draws itself. */
  icon?: LucideIcon | ReactNode;
  disabled?: boolean;
  /**
   * The one thing worth saying about this option: what it will do once chosen, or — on a
   * disabled option — why it cannot be. Shown under the control, never inside the segment.
   */
  hint?: string;
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
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  /** The quiet line above the track, e.g. the question the modes answer. */
  description?: string;
  value: string;
  options: readonly SegmentedOption[];
  onChange: (value: string) => void;
}) {
  const items = useRef(new Map<string, HTMLButtonElement>());
  const descriptionId = useId();
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
  const hint = segmentHint(options, value);

  return (
    // A block, and a track only as wide as its options. Left inline the control stretched to
    // fill whichever grid track a caller put it in, and every caller wrapped it in a div.
    <div className="grid gap-2">
      {description === undefined ? null : (
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      )}
      <div
        role="radiogroup"
        aria-label={label}
        // Never described by its own name: a caller whose visible question is also the group's
        // accessible name would otherwise have it read out twice.
        {...(description === undefined || description === label
          ? {}
          : { "aria-describedby": descriptionId })}
        onKeyDown={move}
        className="inline-flex w-fit items-center gap-0.5 rounded-md bg-muted p-0.5"
      >
        {options.map((option) => {
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
              <SegmentIcon icon={option.icon} />
              {option.label}
            </button>
          );
        })}
      </div>
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A component is instantiated at the size the segment sets; an element is a mark that already
 * knows how it is drawn — a provider glyph — and is used as it is.
 *
 * `typeof icon === "function"` is not the test. Lucide icons are `forwardRef` objects, so a
 * component and an element are both objects, and rendering one of them as a child is the
 * "Objects are not valid as a React child" crash. What separates them is that an element passes
 * `isValidElement` and a component type does not.
 */
function SegmentIcon({ icon }: { icon: SegmentedOption["icon"] }): ReactNode {
  if (icon === undefined || icon === null) return null;
  if (isIconComponent(icon)) {
    return createElement(icon, { "aria-hidden": "true", className: "size-4" });
  }
  return icon;
}

export function isIconComponent(icon: NonNullable<SegmentedOption["icon"]>): icon is LucideIcon {
  if (typeof icon === "function") return true;
  if (typeof icon !== "object" || isValidElement(icon)) return false;
  const candidate: object = icon;
  return "$$typeof" in candidate && "render" in candidate;
}

/**
 * The one line under the control. The selected option's own hint comes first, because that is
 * what the reader just chose; failing that, a disabled option's reason, which is the only hint
 * nobody can reveal by selecting it.
 */
export function segmentHint(
  options: readonly SegmentedOption[],
  value: string,
): string | undefined {
  const selected = options.find((option) => option.value === value);
  if (selected?.hint !== undefined) return selected.hint;
  return options.find((option) => option.disabled === true && option.hint !== undefined)?.hint;
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
