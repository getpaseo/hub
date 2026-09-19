import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Skeleton } from "../ui/skeleton.js";
import { FieldSkeleton } from "./form-field.js";

/**
 * The frame for every surface reached before the dashboard: sign-in, the organization
 * gate, invitations, and daemon approval. A product mark, then one card. The mark is
 * the branding — surfaces do not repeat it as a badge above their own title.
 */
const LAYOUT_WIDTHS = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
} as const;

export function AuthLayout({
  children,
  width = "sm",
}: {
  children: ReactNode;
  /** `lg` is for the app setup journey, whose generated URLs need room beside a copy button. */
  width?: keyof typeof LAYOUT_WIDTHS;
}) {
  return (
    <main
      className={cn(
        "flex min-h-svh flex-col items-center gap-6 bg-background p-6",
        width === "lg" ? "justify-start py-10" : "justify-center",
      )}
    >
      <ProductMark />
      <div className={cn("min-w-0 w-full", LAYOUT_WIDTHS[width])}>{children}</div>
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
  const heading = useRef<HTMLHeadingElement>(null);
  // Each of these cards is a whole screen, and they replace one another in place. Taking focus
  // on arrival is what tells a screen reader the screen changed and puts a keyboard user at the
  // top of the new card instead of back on the document body.
  useEffect(() => heading.current?.focus(), []);
  return (
    <section
      className="grid gap-6 rounded-xl border bg-card p-6"
      {...(titleId === undefined ? {} : { "aria-labelledby": titleId })}
    >
      <div className="grid gap-1.5">
        <h1 ref={heading} id={titleId} tabIndex={-1} className="text-base font-title outline-none">
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

/**
 * The card before the account resolves, and before anything knows which pre-auth screen wins.
 * It is the sign-in card's own box — title, two fields, the full-width submit, and the two
 * quiet lines under it — because that is the screen this resolves to almost every time. Being
 * the same box is the entire job: a shorter placeholder pulls the product mark up the page and
 * drops it again the moment the answer arrives.
 */
export function AuthCardSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-6 rounded-xl border bg-card p-6">
      <div className="grid gap-1.5">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-5 w-60 max-w-full" />
      </div>
      <div className="flex flex-col gap-4">
        <FieldSkeleton description={false} />
        <FieldSkeleton description={false} />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="grid justify-items-center gap-2">
        <Skeleton className="h-10 w-full max-w-72" />
        <Skeleton className="h-5 w-32" />
      </div>
    </div>
  );
}

export function ProductMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <PaseoGlyph />
      </span>
      <span className="text-sm">Paseo Hub</span>
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
