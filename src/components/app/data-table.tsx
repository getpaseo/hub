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
 * The one table shell: bordered card, quiet header row, generous cell rhythm, and a
 * built-in empty row spanning the full width. Every list of records on the dashboard
 * goes through here, so members and daemons cannot drift apart.
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
  return (
    <TableShell label={label} columns={columns}>
      {isEmpty ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={columns.length} className="p-0">
            <EmptyState
              title={empty.title}
              {...(empty.description === undefined ? {} : { description: empty.description })}
            >
              {empty.action}
            </EmptyState>
          </TableCell>
        </TableRow>
      ) : (
        children
      )}
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
          <TableRow key={row} className="border-border/60 hover:bg-transparent">
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
    <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column, index) => (
              <TableHead
                key={column.header === "" ? `actions-${String(index)}` : column.header}
                className={cn(
                  "h-9 px-4 text-xs text-muted-foreground",
                  // The identifying column absorbs the spare width; everything after it
                  // shrinks to its content, so columns stay next to each other instead of
                  // drifting apart on a wide screen.
                  index === 0 ? "w-full" : "w-px",
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
 * A record row. Cells align to the column rails established by `DataTable`. Pass
 * `onSelect` to make the row a keyboard-operable button into a detail view.
 */
export function DataRow({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) {
  if (onSelect === undefined) return <TableRow className="border-border/60">{children}</TableRow>;
  return (
    <TableRow
      className="cursor-pointer border-border/60 hover:bg-muted/40"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
    >
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
  className?: string;
}) {
  return (
    <TableCell
      className={cn(
        "h-14 px-4",
        align === "end" && "text-right",
        muted && "text-muted-foreground",
        className,
      )}
    >
      {children}
    </TableCell>
  );
}
