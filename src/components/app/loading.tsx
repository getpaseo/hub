import { Loader2Icon } from "lucide-react";

import { cn } from "../../lib/utils.js";
import { Skeleton } from "../ui/skeleton.js";
import { DataTableSkeleton, type DataColumn } from "./data-table.js";

/**
 * Pending states.
 *
 * A surface waiting on the data it exists to show draws itself as a skeleton: the parts that are
 * already known — titles, section labels, table columns — are rendered for real, and only what
 * the request decides is a placeholder. The reader is looking at the page they asked for from the
 * first frame, and nothing moves when the data lands.
 *
 * A surface waiting on one small fact inside an otherwise finished page shows a spinner instead.
 * Never a bare line of text: "Loading…" reserves no space, so the page jumps when it resolves.
 */

/** The one spinner. Everything that spins uses this, at the size of the text beside it. */
export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2Icon aria-hidden="true" className={cn("size-4 shrink-0 animate-spin", className)} />
  );
}

/** A spinner and what it is waiting for, on one line, inside an already-drawn page. */
export function LoadingLine({ children }: { children: string }) {
  return (
    <p aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      {children}
    </p>
  );
}

/**
 * A page title and its description before either is known. Matches `PageHeader`'s block, so a
 * surface that cannot name itself until its data arrives still reserves the right space.
 */
export function PageHeaderSkeleton() {
  return (
    <header className="mb-6 grid gap-2">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </header>
  );
}

/** A bordered card that is about to hold prose, fields, or a summary. */
export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-busy="true" className="grid gap-3 rounded-lg border bg-card p-5">
      {Array.from({ length: lines }, (_, line) => (
        <Skeleton key={line} className={cn("h-4", line === 0 ? "w-40" : "w-full")} />
      ))}
    </div>
  );
}

const GENERIC_COLUMNS: readonly DataColumn[] = [
  { header: "" },
  { header: "" },
  { header: "", align: "end" },
];

/**
 * A whole dashboard panel before the route's own surface can say what it is — switching
 * organization, or resolving the tenant behind a URL. Every panel below is a header over
 * records, so that is the shape held open. The label names the slot that is waiting, not the
 * page that will fill it, which is still unknown.
 */
export function PanelSkeleton({ label = "Loading" }: { label?: string }) {
  return (
    <section aria-label={label} aria-busy="true">
      <PageHeaderSkeleton />
      {/* Its own name, not the panel's. `Table` derives a landmark called "<label> table", so
          reusing the panel's label here would put two regions under one name. */}
      <DataTableSkeleton label="Placeholder rows" columns={GENERIC_COLUMNS} />
    </section>
  );
}
