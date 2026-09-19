import type { ReactNode } from "react";

/**
 * A polite live region with its height already reserved. The height is the point: a line that
 * appears only once there is something to say pushes the page down under the reader's cursor
 * the moment a request settles.
 */
export function StatusLine({ children }: { children: ReactNode }) {
  return (
    <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
      {children}
    </p>
  );
}
