import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Skeleton } from "../ui/skeleton.js";
import { StatusPill, type StatusTone } from "./status-pill.js";

/**
 * The single content column every dashboard surface sits in. Screens never set
 * their own width or page padding; that rhythm lives here so all surfaces agree.
 */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-5xl", className)}>{children}</div>;
}

/**
 * The one title on a page. `SiteHeader` carries only breadcrumb-level context, so
 * this is never duplicated by the chrome above it, and it is never wrapped in a card.
 */
export function PageHeader({
  title,
  description,
  children,
  id,
  status,
}: {
  title: string;
  description?: string;
  /** The page's actions. At most one is filled; the rest are outline or ghost. */
  children?: ReactNode;
  id?: string;
  status?: { label: string; tone: StatusTone };
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="grid min-w-0 gap-1">
        <span className="flex items-center gap-2">
          <h1 id={id} className="text-xl font-title">
            {title}
          </h1>
          {status === undefined ? null : <StatusPill tone={status.tone}>{status.label}</StatusPill>}
        </span>
        {description === undefined ? null : (
          <p className="text-sm text-balance text-muted-foreground">{description}</p>
        )}
      </div>
      {children === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      )}
    </header>
  );
}

/**
 * The page header before the title is known. A surface usually knows what it is for long
 * before it knows what it is called, so pass the description you already have: a real line
 * of prose reads as the page arriving rather than as two grey bars, and nothing reflows when
 * the title lands on top of it.
 */
export function PageHeaderSkeleton({ description }: { description?: string }) {
  return (
    <header className="mb-6 grid gap-1">
      <Skeleton className="h-7 w-48" />
      {description === undefined ? (
        <Skeleton className="h-5 w-80 max-w-full" />
      ) : (
        <p className="text-sm text-balance text-muted-foreground">{description}</p>
      )}
    </header>
  );
}
