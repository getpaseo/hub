import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";
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
  empty: { title: string; description?: string };
  isEmpty: boolean;
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
                  "h-9 px-4 text-xs font-medium text-muted-foreground",
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
        <TableBody>
          {isEmpty ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-0">
                <EmptyState
                  title={empty.title}
                  {...(empty.description === undefined ? {} : { description: empty.description })}
                />
              </TableCell>
            </TableRow>
          ) : (
            children
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/** A record row. Cells align to the column rails established by `DataTable`. */
export function DataRow({ children }: { children: ReactNode }) {
  return <TableRow className="border-border/60">{children}</TableRow>;
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
