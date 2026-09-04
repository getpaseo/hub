import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * The button row under a form. On a phone the buttons stack full width with the primary one on
 * top, which is why the row is reversed: the primary button is the last child in the markup, so
 * it is the last thing the keyboard reaches and the first thing the thumb finds.
 */
export function FormActions({
  children,
  pinned = false,
}: {
  children: ReactNode;
  /**
   * Hold the row against the bottom of a phone screen. For a surface long enough to scroll,
   * where the row as written sits below the fold and the reader has to scroll past everything
   * they already decided to reach the way out. From `sm` there is room for it where it belongs.
   */
  pinned?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        pinned &&
          "sticky bottom-0 border-t bg-background py-3 sm:static sm:border-0 sm:bg-transparent sm:py-0",
      )}
    >
      {children}
    </div>
  );
}
