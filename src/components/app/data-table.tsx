/* oxlint-disable eslint-plugin-jsx-a11y/prefer-tag-over-role, eslint-plugin-react-perf/jsx-no-new-function-as-prop -- a table row cannot itself be a <button>, and its onKeyDown handler is scoped per rendered row */
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { Children, createContext, isValidElement, useContext, type ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
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
  /** The key the table's `sort` uses for this column. Only then is the header a sort control. */
  sort?: string;
}

/** Which column the rows are ordered by, and how to ask for another order. */
export interface DataTableSort {
  key: string;
  dir: "asc" | "desc";
  onSort: (key: string) => void;
}

/** Which slice of the records the rows are, and how to ask for another. */
export interface DataTablePagination {
  /** One-based. */
  page: number;
  pageSize: number;
  /** How many rows this page holds. */
  shown: number;
  total: number;
  /** `total` is a floor: there are more records than were counted. */
  totalCapped?: boolean;
  onPage: (page: number) => void;
}

/** A quiet line under the rows: where to look for what the table leaves out. */
export interface DataTableFooter {
  note: string;
  /** One action, an `outline` `sm` `Button`. */
  action: ReactNode;
}

const TableSort = createContext<DataTableSort | undefined>(undefined);

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
  sort,
  pagination,
  footer,
  children,
}: {
  label: string;
  columns: readonly DataColumn[];
  empty: { title: string; description?: string; action?: ReactNode };
  isEmpty: boolean;
  /** Makes the headers of columns with a `sort` key into sort controls. */
  sort?: DataTableSort;
  /** The rows are one page of many: the card ends in the range shown and page controls. */
  pagination?: DataTablePagination;
  /** The rows are a summary: the card ends in a pointer to what they leave out. */
  footer?: DataTableFooter;
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
    <TableSort.Provider value={sort}>
      <TableShell
        label={label}
        columns={columns}
        {...(pagination === undefined ? {} : { pagination })}
        {...(footer === undefined ? {} : { footer })}
      >
        {children}
      </TableShell>
    </TableSort.Provider>
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
  pagination,
  footer,
  children,
}: {
  label: string;
  columns: readonly DataColumn[];
  pagination?: DataTablePagination;
  footer?: DataTableFooter;
  children: ReactNode;
}) {
  const sort = useContext(TableSort);
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
                {...(sort === undefined || column.sort === undefined
                  ? {}
                  : { "aria-sort": ariaSort(sort, column.sort) })}
              >
                <HeaderLabel column={column} sort={sort} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableColumns.Provider value={columns}>{children}</TableColumns.Provider>
        </TableBody>
      </Table>
      {pagination === undefined ? null : <Pagination label={label} {...pagination} />}
      {footer === undefined ? null : (
        <div className="flex h-11 items-center justify-between gap-4 border-t px-4">
          <p className="truncate text-xs text-muted-foreground">{footer.note}</p>
          <div className="shrink-0">{footer.action}</div>
        </div>
      )}
    </div>
  );
}

function HeaderLabel({ column, sort }: { column: DataColumn; sort: DataTableSort | undefined }) {
  if (column.header === "") return <span className="sr-only">Actions</span>;
  if (sort === undefined || column.sort === undefined) return column.header;
  return <SortButton column={column} sortKey={column.sort} sort={sort} />;
}

function ariaSort(sort: DataTableSort, key: string): "ascending" | "descending" | "none" {
  if (sort.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

/**
 * A header that orders the rows. It reads as the header it replaces — the same size and the same
 * quiet colour — and only the arrow on the active column says the rows are ordered by it. Hover
 * promotes the colour, as every other quiet control does.
 */
function SortButton({
  column,
  sortKey,
  sort,
}: {
  column: DataColumn;
  sortKey: string;
  sort: DataTableSort;
}) {
  const active = sort.key === sortKey;
  const Arrow = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => sort.onSort(sortKey)}
      className={cn(
        "-mx-1 inline-flex items-center gap-1 rounded-sm px-1 transition-colors duration-150 hover:text-foreground",
        active && "text-foreground",
        column.align === "end" && "flex-row-reverse",
      )}
    >
      {column.header}
      {active ? <Arrow aria-hidden="true" className="size-3" /> : null}
    </button>
  );
}

/**
 * The end of a paged table: which records are on screen, and the way to the next and previous
 * pages. The range is the one fact a reader checks before paging, so it is the line and the
 * controls are two quiet arrows.
 */
function Pagination({
  label,
  page,
  pageSize,
  shown,
  total,
  totalCapped = false,
  onPage,
}: DataTablePagination & { label: string }) {
  const first = shown === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = first + Math.max(shown - 1, 0);
  // Past a capped count the total says nothing about what follows; a full page says there may be more.
  const hasNext = totalCapped ? shown === pageSize : page * pageSize < total;
  return (
    <nav
      aria-label={`${label} pages`}
      className="flex h-11 items-center justify-between gap-4 border-t px-4"
    >
      <p className="text-xs text-muted-foreground tabular-nums">
        {formatCount(first)}–{formatCount(last)} of {formatCount(Math.max(total, last))}
        {totalCapped ? "+" : ""}
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next page"
          disabled={!hasNext}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
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
export function DataRow({
  children,
  onSelect,
  selected = false,
}: {
  children: ReactNode;
  onSelect?: () => void;
  /** The row's record is the one open beside the table. */
  selected?: boolean;
}) {
  // Each cell learns its column from its position, so a cell never restates how its column
  // reads. A cell left out with `cond ? <DataCell /> : null` drops out here too.
  const cells = Children.toArray(children).map((cell, index) => (
    <CellIndex.Provider key={isValidElement(cell) ? cell.key : index} value={index}>
      {cell}
    </CellIndex.Provider>
  ));
  const state = selected ? { "data-state": "selected", "aria-current": true } : {};
  if (onSelect === undefined) return <TableRow {...state}>{cells}</TableRow>;
  return (
    <TableRow data-navigates="true" className="cursor-pointer" onClick={onSelect} {...state}>
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
