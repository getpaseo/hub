import { cn } from "../../lib/utils.js";

/**
 * The one status pill. Tones map to the status tokens in `styles.css`; no surface
 * hardcodes a status colour or reaches for `<Badge>` to signal state.
 *
 * The pill renders the text it is given and never transforms it. Casing is a decision about
 * the data, not about the pill — `statusLabel` is where a machine value becomes a sentence.
 */
export type StatusTone = "success" | "warning" | "danger" | "neutral";

const toneStyles: Record<StatusTone, string> = {
  success: "bg-success-surface text-success",
  warning: "bg-warning-surface text-warning",
  danger: "bg-danger-surface text-danger",
  neutral: "bg-neutral-surface text-neutral",
};

export function StatusPill({
  tone,
  children,
  dot = true,
}: {
  tone: StatusTone;
  children: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs whitespace-nowrap",
        toneStyles[tone],
      )}
    >
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/**
 * A machine status as a sentence: `in_progress` reads "In progress". One home for the three
 * casing strategies the dashboard grew — a CSS `capitalize`, a `charAt(0).toUpperCase()`, and
 * nothing at all — none of which agreed on what a two-word status looked like.
 */
export function statusLabel(value: string): string {
  const words = value.replaceAll(/[_-]+/gu, " ").trim().toLowerCase();
  if (words === "") return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}
