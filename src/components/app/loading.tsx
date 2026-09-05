import { Loader2Icon } from "lucide-react";

import { cn } from "../../lib/utils.js";
import { DataTableSkeleton, type DataColumn } from "./data-table.js";
import { PageHeaderSkeleton } from "./page.js";
import { TabNavSkeleton } from "./tab-nav.js";

/**
 * Pending states.
 *
 * A surface waiting on the data it exists to show draws itself as a skeleton: the parts that are
 * already known — titles, section labels, table columns — are rendered for real, and only what
 * the request decides is a placeholder. The reader is looking at the page they asked for from the
 * first frame, and nothing moves when the data lands. Each of those skeletons lives beside the
 * component it stands in for, which is why only the whole-panel one is here.
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

/**
 * A spinner and what it is waiting for, on one line, inside an already-drawn page. It is a live
 * region as well as a busy one: `aria-busy` says the part is not finished, and only the status
 * role makes the sentence itself reach a screen reader when the wait starts.
 */
export function LoadingLine({ children }: { children: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex items-center gap-2 text-sm text-muted-foreground"
    >
      <Spinner />
      {children}
    </p>
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
export function PanelSkeleton({
  label = "Loading",
  tabs = false,
}: {
  label?: string;
  /** The page being waited for carries a tab strip, so hold that rail open too. */
  tabs?: boolean;
}) {
  return (
    <section aria-label={label} aria-busy="true">
      {tabs ? <TabNavSkeleton /> : null}
      <PageHeaderSkeleton />
      {/* Its own name, not the panel's. `Table` derives a landmark called "<label> table", so
          reusing the panel's label here would put two regions under one name. */}
      <DataTableSkeleton label="Placeholder rows" columns={GENERIC_COLUMNS} />
    </section>
  );
}
