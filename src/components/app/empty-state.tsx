import type { ReactNode } from "react";

/**
 * The one empty state: a short noun phrase, a line of context, and — when there is exactly one
 * thing to do next — the way to do it.
 */
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  /** The single next step: a command to copy, a link to the docs, a button. */
  children?: ReactNode;
}) {
  return (
    <div className="grid justify-items-center gap-2 px-6 py-12 text-center">
      <p className="text-sm">{title}</p>
      {description === undefined ? null : (
        <p className="max-w-md text-sm text-balance text-muted-foreground">{description}</p>
      )}
      {children === undefined ? null : (
        <div className="mt-4 grid w-full max-w-md justify-items-center gap-3">{children}</div>
      )}
    </div>
  );
}
