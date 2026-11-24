/**
 * Activity's URL is its state. Everything a reader can filter, sort, page, or open lives in the
 * query string, so a refresh or a pasted link reproduces exactly what they were looking at, and
 * every other surface deep-links into Activity by building one of these.
 *
 * Two shapes, one contract:
 * - `ActivitySearch` is the URL as written: strings, defaults omitted, nothing a link would not say.
 * - `ActivityQuery` is the same state with every default filled in, which the server reads.
 */

import {
  PROVIDER_EVENT_DROP_REASON_CODES,
  type ProviderEventDropReasonCode,
} from "../triggers/drop-reason.js";

export const ACTIVITY_VIEWS = ["runs", "unmatched"] as const;
export type ActivityView = (typeof ACTIVITY_VIEWS)[number];

export const ACTIVITY_RANGES = ["24h", "7d", "30d", "all"] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

export const ACTIVITY_PROVIDERS = [
  "github",
  "discord",
  "slack",
  "linear",
  "schedule",
  "webhook",
  "manual",
] as const;
export type ActivityProvider = (typeof ACTIVITY_PROVIDERS)[number];

export const RUN_STATUSES = ["running", "succeeded", "failed", "timed_out", "rejected"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Every way a run can end badly. Home's failure count and its link into Activity agree on it. */
export const FAILED_RUN_STATUSES = [
  "failed",
  "timed_out",
  "rejected",
] as const satisfies readonly RunStatus[];

export const ACTIVITY_SORTS = ["received_at", "duration", "status"] as const;
export type ActivitySort = (typeof ACTIVITY_SORTS)[number];

/** Sorts that only exist for runs: an unmatched event has no duration and no status. */
const RUN_ONLY_SORTS: ReadonlySet<ActivitySort> = new Set(["duration", "status"]);

export const ACTIVITY_PAGE_SIZE = 25;
export const ACTIVITY_SEARCH_MAX = 120;

export interface ActivitySearch {
  view?: "unmatched";
  range?: Exclude<ActivityRange, "7d">;
  /** Comma-separated providers. */
  provider?: string;
  trigger?: string;
  daemon?: string;
  /** Comma-separated run statuses. */
  status?: string;
  reason?: ProviderEventDropReasonCode;
  q?: string;
  sort?: Exclude<ActivitySort, "received_at">;
  dir?: "asc";
  page?: number;
  selected?: string;
}

export interface ActivityQuery {
  view: ActivityView;
  range: ActivityRange;
  providers: readonly ActivityProvider[];
  trigger: string | null;
  daemon: string | null;
  statuses: readonly RunStatus[];
  reason: ProviderEventDropReasonCode | null;
  q: string | null;
  sort: ActivitySort;
  dir: "asc" | "desc";
  page: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The URL as the router hands it over, reduced to what Activity understands. Anything malformed
 * or meaningless for the view is dropped rather than refused: a stale bookmark still opens.
 */
export function parseActivitySearch(raw: Readonly<Record<string, unknown>>): ActivitySearch {
  const view = raw["view"] === "unmatched" ? "unmatched" : "runs";
  const search: ActivitySearch = {};
  if (view === "unmatched") search.view = "unmatched";
  const range = member(ACTIVITY_RANGES, raw["range"]);
  if (range !== undefined && range !== "7d") search.range = range;
  const providers = list(ACTIVITY_PROVIDERS, raw["provider"]);
  if (providers.length > 0) search.provider = providers.join(",");
  if (view === "runs") {
    const trigger = uuid(raw["trigger"]);
    if (trigger !== undefined) search.trigger = trigger;
    const daemon = uuid(raw["daemon"]);
    if (daemon !== undefined) search.daemon = daemon;
    const statuses = list(RUN_STATUSES, raw["status"]);
    if (statuses.length > 0) search.status = statuses.join(",");
  } else {
    const reason = member(PROVIDER_EVENT_DROP_REASON_CODES, raw["reason"]);
    if (reason !== undefined) search.reason = reason;
  }
  const q = text(raw["q"]);
  if (q !== undefined) search.q = q;
  const sort = member(ACTIVITY_SORTS, raw["sort"]);
  if (sort !== undefined && sort !== "received_at" && allowsSort(view, sort)) search.sort = sort;
  if (raw["dir"] === "asc") search.dir = "asc";
  const page = pageNumber(raw["page"]);
  if (page !== undefined && page > 1) search.page = page;
  const selected = uuid(raw["selected"]);
  if (selected !== undefined) search.selected = selected;
  return search;
}

/** The URL with every default filled in. */
export function activityQuery(search: ActivitySearch): ActivityQuery {
  return {
    view: search.view ?? "runs",
    range: search.range ?? "7d",
    providers: list(ACTIVITY_PROVIDERS, search.provider),
    trigger: search.trigger ?? null,
    daemon: search.daemon ?? null,
    statuses: list(RUN_STATUSES, search.status),
    reason: search.reason ?? null,
    q: search.q ?? null,
    sort: search.sort ?? "received_at",
    dir: search.dir ?? "desc",
    page: search.page ?? 1,
  };
}

/**
 * Switch between runs and unmatched events. Filters that mean nothing in the other view go, and
 * so do the page and the open record: both belong to the list being left.
 */
export function withView(search: ActivitySearch, view: string): ActivitySearch {
  const { page: _page, selected: _selected, ...kept } = search;
  return parseActivitySearch({ ...kept, view });
}

/** Change filters. A filtered list starts from its first page with nothing open. */
export function withFilters(
  search: ActivitySearch,
  patch: Partial<Record<ActivityFilter, string | undefined>>,
): ActivitySearch {
  const { page: _page, selected: _selected, ...kept } = search;
  return parseActivitySearch({ ...kept, ...patch });
}

/** Every filter off. The range stays: it is the window being read, not a narrowing of it. */
export function withoutFilters(search: ActivitySearch): ActivitySearch {
  return withFilters(search, {
    provider: undefined,
    trigger: undefined,
    daemon: undefined,
    status: undefined,
    reason: undefined,
    q: undefined,
  });
}

type ActivityFilter = "range" | "provider" | "trigger" | "daemon" | "status" | "reason" | "q";

/** Sort by a column: the same column again flips the direction, a new one starts descending. */
export function withSort(search: ActivitySearch, sort: string): ActivitySearch {
  const current = activityQuery(search);
  const dir = current.sort === sort && current.dir === "desc" ? "asc" : "desc";
  const { page: _page, ...kept } = search;
  return parseActivitySearch({ ...kept, sort, dir });
}

export function withPage(search: ActivitySearch, page: number): ActivitySearch {
  return parseActivitySearch({ ...search, page });
}

export function withSelected(search: ActivitySearch, selected: string | undefined): ActivitySearch {
  const { selected: _selected, ...kept } = search;
  return parseActivitySearch(selected === undefined ? kept : { ...kept, selected });
}

/** Whether the reader has narrowed the list beyond the default window. */
export function hasFilters(search: ActivitySearch): boolean {
  return (
    search.provider !== undefined ||
    search.trigger !== undefined ||
    search.daemon !== undefined ||
    search.status !== undefined ||
    search.reason !== undefined ||
    search.q !== undefined
  );
}

/** Keys in the order a link is written, so the same state is always the same URL. */
const SEARCH_KEYS = [
  "view",
  "range",
  "provider",
  "trigger",
  "daemon",
  "status",
  "reason",
  "q",
  "sort",
  "dir",
  "page",
  "selected",
] as const satisfies readonly (keyof ActivitySearch)[];

/** A link into Activity as router `Link` props: the path, and the search Activity will read. */
export function activityLink(
  organizationSlug: string,
  search: Readonly<Record<string, unknown>> = {},
): { to: string; search: ActivitySearch } {
  return {
    to: `/o/${encodeURIComponent(organizationSlug)}/activity`,
    search: parseActivitySearch(search),
  };
}

/** A link into Activity from anywhere in the organization, as one address. */
export function activityHref(
  organizationSlug: string,
  search: Readonly<Record<string, unknown>> = {},
): string {
  const link = activityLink(organizationSlug, search);
  const params = new URLSearchParams();
  for (const key of SEARCH_KEYS) {
    const value = link.search[key];
    if (value !== undefined) params.set(key, String(value));
  }
  const query = params.toString();
  return `${link.to}${query === "" ? "" : `?${query}`}`;
}

const RANGE_DAYS = { "24h": 1, "7d": 7, "30d": 30 } as const;

/** Where a range starts, or null for all time. */
export function rangeStart(range: ActivityRange, now: Date): Date | null {
  if (range === "all") return null;
  return new Date(now.getTime() - RANGE_DAYS[range] * 86_400_000);
}

const PROVIDER_LABELS: Readonly<Record<ActivityProvider, string>> = {
  github: "GitHub",
  discord: "Discord",
  slack: "Slack",
  linear: "Linear",
  schedule: "Schedule",
  webhook: "Webhook",
  manual: "Manual",
};

export function activityProviderLabel(provider: ActivityProvider): string {
  return PROVIDER_LABELS[provider];
}

export function isActivityProvider(value: string): value is ActivityProvider {
  return ACTIVITY_PROVIDERS.some((provider) => provider === value);
}

function allowsSort(view: ActivityView, sort: ActivitySort): boolean {
  return view === "runs" || !RUN_ONLY_SORTS.has(sort);
}

function member<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value);
}

/** A comma-separated set, in the contract's own order, without repeats or unknown values. */
function list<T extends string>(values: readonly T[], value: unknown): T[] {
  if (typeof value !== "string") return [];
  const given = new Set(value.split(",").map((part) => part.trim()));
  return values.filter((candidate) => given.has(candidate));
}

function uuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

function text(value: unknown): string | undefined {
  // The router decodes `?q=123` to a number; the reader typed text.
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().slice(0, ACTIVITY_SEARCH_MAX);
  return trimmed === "" ? undefined : trimmed;
}

function pageNumber(value: unknown): number | undefined {
  const page = typeof value === "string" ? Number(value) : value;
  // Not capped, so every matching record stays reachable. A page past the last returns no rows
  // after reading the matches once: the runs count reads them anyway, and unmatched receipts
  // are kept for 7 days.
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1) return undefined;
  return page;
}
