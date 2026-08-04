import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

/**
 * The frame for every surface reached before the dashboard: sign-in, the organization
 * gate, invitations, and daemon approval. A product mark, then one card. The mark is
 * the branding — surfaces do not repeat it as a badge above their own title.
 */
export function AuthLayout({
  children,
  width = "sm",
}: {
  children: ReactNode;
  width?: "sm" | "md";
}) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6">
      <ProductMark />
      <div className={cn("w-full", width === "sm" ? "max-w-sm" : "max-w-lg")}>{children}</div>
    </main>
  );
}

export function AuthCard({
  title,
  description,
  descriptionRole,
  children,
  titleId,
}: {
  title: string;
  description?: string;
  /** Set to "status" when the description reports account state that just changed. */
  descriptionRole?: "status";
  children: ReactNode;
  titleId?: string;
}) {
  return (
    <section
      className="grid gap-6 rounded-lg border bg-card p-6 shadow-sm"
      {...(titleId === undefined ? {} : { "aria-labelledby": titleId })}
    >
      <div className="grid gap-1.5">
        <h1 id={titleId} className="text-base font-medium">
          {title}
        </h1>
        {description === undefined ? null : (
          <p
            className="text-sm text-balance text-muted-foreground"
            {...(descriptionRole === undefined ? {} : { role: descriptionRole })}
          >
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

export function ProductMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <PaseoGlyph />
      </span>
      <span className="text-sm font-medium">Paseo Hub</span>
    </div>
  );
}

export function PaseoGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden="true">
      <path
        d="M4 12.5V4.5a1 1 0 0 1 1-1h3.5a3 3 0 0 1 0 6H4"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
