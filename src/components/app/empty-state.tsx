import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * The one empty state: a short noun phrase, a line of context, and — when there is exactly one
 * thing to do next — the way to do it.
 *
 * `align` is about the next step, not about taste. A button or a link reads centred; a command
 * to copy is a value, and a value that is centred is a value nobody can scan. Choose `start`
 * when the child has a left edge worth keeping.
 */
export function EmptyState({
  title,
  description,
  align = "center",
  children,
}: {
  title: string;
  description?: string;
  align?: "center" | "start";
  /** The single next step: a command to copy, a link to the docs, a button. */
  children?: ReactNode;
}) {
  const centred = align === "center";
  return (
    <div className={cn("grid gap-2 px-6 py-12", centred && "justify-items-center text-center")}>
      <p className="text-sm">{title}</p>
      {description === undefined ? null : (
        <p className="max-w-md text-sm text-balance text-muted-foreground">{description}</p>
      )}
      {children === undefined ? null : (
        <div className={cn("mt-4 grid w-full max-w-md gap-3", centred && "justify-items-center")}>
          {children}
        </div>
      )}
    </div>
  );
}
