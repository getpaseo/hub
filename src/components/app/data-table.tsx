/* oxlint-disable eslint-plugin-jsx-a11y/prefer-tag-over-role, eslint-plugin-react-perf/jsx-no-new-function-as-prop -- a table row cannot itself be a <button>, and its onKeyDown handler is scoped per rendered row */
import { Children, createContext, isValidElement, useContext, type ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Skeleton } from "../ui/skeleton.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.js";
import { EmptyState } from "./empty-state.js";

export interface DataColumn {
  /** Visible header text. Empty for a trailing action column. */
  header: string;
  align?: "start" | "end";
  /**
   * The column holds values that can be cut — a name, a summary, a path — so it shares the width
   * the other columns leave and truncates when that is not enough. Every other column is as wide
   * as its widest value and never truncates. Every table has at least one.
   */
  fill?: boolean;
  /** Responsive visibility for the column, header and cells alike. */
  className?: string;
}

/** The columns of the table a cell is drawn in, and which of them the cell sits under. */
const TableColumns = createContext<readonly DataColumn[]>([]);
const CellIndex = createContext(-1);

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
          <DataRow key={row}>
            {columns.map((column, index) => (
              <DataCell key={columnKey(column, index)}>
                <Skeleton className={cn("h-4", placeholderWidth(columns, index))} />
              </DataCell>
            ))}
          </DataRow>
        ))}
      </TableShell>
    </div>
  );
}

/**
 * A filling column carries the long value, the rest are short facts, and a trailing action
 * column is a button-sized square.
 */
function placeholderWidth(columns: readonly DataColumn[], index: number): string {
  const column = columns[index];
  if (column?.header === "" && index === columns.length - 1) return "ml-auto size-8";
  return column?.fill === true ? "w-48" : "w-16";
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
                key={columnKey(column, index)}
                className={cn(
                  // A fitted column is a 1px request the browser widens to its widest value and
                  // never past it, so fitted columns stay next to each other on a wide screen.
                  // Filling columns share what is left by how much each holds, and give it back
                  // the same way when there is not enough. A floor keeps a filling column
                  // readable once there is room for one; on a phone there is not, and a table
                  // that scrolls sideways is worse than a name that truncates. The first column
                  // names the record, so its floor is higher: it is the last column a reader can
                  // afford to lose.
                  column.fill === true && (index === 0 ? "sm:min-w-48" : "sm:min-w-32"),
                  column.fill !== true && "w-px",
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
          <TableColumns.Provider value={columns}>{children}</TableColumns.Provider>
        </TableBody>
      </Table>
    </div>
  );
}

function columnKey(column: DataColumn, index: number): string {
  return column.header === "" ? `actions-${String(index)}` : column.header;
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
  // Each cell learns its column from its position, so a cell never restates how its column
  // reads. A cell left out with `cond ? <DataCell /> : null` drops out here too.
  const cells = Children.toArray(children).map((cell, index) => (
    <CellIndex.Provider key={isValidElement(cell) ? cell.key : index} value={index}>
      {cell}
    </CellIndex.Provider>
  ));
  if (onSelect === undefined) return <TableRow>{cells}</TableRow>;
  return (
    <TableRow data-navigates="true" className="cursor-pointer" onClick={onSelect}>
      {cells}
    </TableRow>
  );
}

/** A value in a row. Its alignment, visibility, and whether it truncates are its column's. */
export function DataCell({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  const index = useContext(CellIndex);
  const column = useContext(TableColumns)[index];
  if (column === undefined) {
    throw new Error(`DataCell ${String(index)} has no column: a row holds one cell per column.`);
  }
  return (
    <TableCell
      className={cn(
        column.align === "end" && "text-right",
        muted && "text-muted-foreground",
        column.className,
      )}
    >
      {column.fill === true ? (
        // A grid item that clips has no minimum width, so the column can give way, while its
        // widest value still sets the column's share of the spare width. Anything that is not a
        // grid item — a flex row, a block — would hold the column open at its full width.
        // `TwoLine` reads the slot: here its secondary line gives way first.
        <div data-slot="fill-cell" className="grid">
          <div className="truncate" title={typeof children === "string" ? children : undefined}>
            {children}
          </div>
        </div>
      ) : (
        children
      )}
    </TableCell>
  );
}
