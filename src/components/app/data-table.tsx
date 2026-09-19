/* oxlint-disable eslint-plugin-jsx-a11y/prefer-tag-over-role, eslint-plugin-react-perf/jsx-no-new-function-as-prop -- a table row cannot itself be a <button>, and its onKeyDown handler is scoped per rendered row */
import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Skeleton } from "../ui/skeleton.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.js";
import { EmptyState } from "./empty-state.js";

export interface DataColumn {
  /** Visible header text. Empty for a trailing action column. */
  header: string;
  align?: "start" | "end";
  /** Width or emphasis overrides for this column's cells. */
  className?: string;
}

/**
 * The one table shell: bordered card, quiet header row, one body-row height, and — when there is
 * nothing to list — the empty state instead of the table. Column headers over no rows are a
 * promise the screen cannot keep, so an empty list drops the card and says what is missing where
 * the records would have been. Every list of records on the dashboard goes through here, so
 * members and daemons cannot drift apart.
 */
export function DataTable({
  label,
  columns,
  empty,
  isEmpty,
  children,
}: {
  label: string;
  columns: readonly DataColumn[];
  empty: { title: string; description?: string; action?: ReactNode };
  isEmpty: boolean;
  children: ReactNode;
}) {
  if (isEmpty) {
    return (
      <EmptyState
        title={empty.title}
        {...(empty.description === undefined ? {} : { description: empty.description })}
      >
        {empty.action}
      </EmptyState>
    );
  }
  return (
    <TableShell label={label} columns={columns}>
      {children}
    </TableShell>
  );
}

/**
 * The same table before its rows are known: real columns, placeholder cells. The page the
 * reader is waiting for is already the page on screen, so nothing moves when the data lands.
 */
export function DataTableSkeleton({
  label,
  columns,
  rows = 3,
}: {
  label: string;
  columns: readonly DataColumn[];
  rows?: number;
}) {
  return (
    <div aria-busy="true">
      <TableShell label={label} columns={columns}>
        {Array.from({ length: rows }, (_, row) => (
          <TableRow key={row}>
            {columns.map((column, index) => (
              <DataCell
                key={column.header === "" ? `actions-${String(index)}` : column.header}
                {...(column.align === undefined ? {} : { align: column.align })}
              >
                <Skeleton className={cn("h-4", placeholderWidth(columns, index))} />
              </DataCell>
            ))}
          </TableRow>
        ))}
      </TableShell>
    </div>
  );
}

/**
 * The identifying column carries the long value, the rest are short facts, and a trailing
 * action column is a button-sized square.
 */
function placeholderWidth(columns: readonly DataColumn[], index: number): string {
  const column = columns[index];
  if (column?.header === "" && index === columns.length - 1) return "ml-auto size-8";
  return index === 0 ? "w-48" : "w-16";
}

/** The bordered card and quiet header row both the table and its skeleton are drawn in. */
function TableShell({
  label,
  columns,
  children,
}: {
  label: string;
  columns: readonly DataColumn[];
  children: ReactNode;
}) {
  return (
    // Every table is `tabular-nums`. A count, a limit, and a duration all sit in columns here,
    // and figuring out which cells hold digits is not a decision a caller should be making one
    // screen at a time. Proportional digits cost nothing on prose and misalign every column.
    <div className="min-w-0 overflow-hidden rounded-xl border bg-card">
      <Table aria-label={label} className="tabular-nums">
        <TableHeader>
          <TableRow>
            {columns.map((column, index) => (
              <TableHead
                key={column.header === "" ? `actions-${String(index)}` : column.header}
                className={cn(
                  // The identifying column absorbs the spare width; everything after it
                  // shrinks to its content, so columns stay next to each other instead of
                  // drifting apart on a wide screen. The floor keeps that column readable once
                  // there is room for it; on a phone there is not, and a table that scrolls
                  // sideways is worse than a name that truncates.
                  index === 0 ? "w-full sm:min-w-48" : "w-px",
                  column.align === "end" && "text-right",
                  column.className,
                )}
              >
                {column.header === "" ? <span className="sr-only">Actions</span> : column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

/**
 * A record row. Cells align to the column rails established by `DataTable`. Pass `onSelect` to
 * let the whole row take the click that its first cell's link already takes — and only then does
 * the row light up under the pointer, because a hover fill on a row that goes nowhere promises a
 * click.
 *
 * The row is a pointer shortcut, not a control: a row carrying `role="button"` and `tabIndex`
 * around a link and a kebab is two focusable things inside a third, which is the
 * `nested-interactive` failure. The keyboard and a screen reader use the link in the row, so
 * `onSelect` requires one.
 */
export function DataRow({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) {
  if (onSelect === undefined) return <TableRow>{children}</TableRow>;
  return (
    <TableRow data-navigates="true" className="cursor-pointer" onClick={onSelect}>
      {children}
    </TableRow>
  );
}

export function DataCell({
  children,
  align = "start",
  muted = false,
  className,
}: {
  children: ReactNode;
  align?: "start" | "end";
  muted?: boolean;
  /** Column width or wrapping only. Never used to change how a cell reads. */
  className?: string;
}) {
  return (
    <TableCell
      className={cn(align === "end" && "text-right", muted && "text-muted-foreground", className)}
    >
      {children}
    </TableCell>
  );
}
