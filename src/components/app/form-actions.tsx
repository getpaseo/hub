import type { ReactNode } from "react";

/**
 * The button row under a form. On a phone the buttons stack full width with the primary one on
 * top, which is why the row is reversed: the primary button is the last child in the markup, so
 * it is the last thing the keyboard reaches and the first thing the thumb finds.
 */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{children}</div>;
}
