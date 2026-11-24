/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- one screen binds one URL; a row's link, glyph, and status are that row's own slots */
import { useServerFn } from "@tanstack/react-start";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Button } from "../components/ui/button.js";
import {
  DataCell,
  DataRow,
  DataTable,
  DataTableSkeleton,
  type DataColumn,
} from "../components/app/data-table.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import {
  FilterBar,
  FilterSearch,
  FilterSelect,
  type FilterOption,
} from "../components/app/filter-bar.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { SegmentedControl } from "../components/app/segmented-control.js";
import { StatusLine } from "../components/app/status-line.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import { useRouteTenant } from "../projects/context.js";
import { useSnapshotQuery, type Snapshot } from "../queries/index.js";
import { PROVIDER_EVENT_DROP_REASON_CODES } from "../triggers/drop-reason.js";
import { ActivityDetail } from "./detail-drawer.js";
import { activitySnapshot, type ActivitySnapshot } from "./functions.js";
import { DROP_REASONS, RANGE_LABELS, formatDuration, runStatusTone } from "./presentation.js";
import {
  ACTIVITY_PROVIDERS,
  ACTIVITY_RANGES,
  FAILED_RUN_STATUSES,
  RUN_STATUSES,
  activityProviderLabel,
  activityQuery,
  hasFilters,
  withFilters,
  withPage,
  withSelected,
  withSort,
  withView,
  withoutFilters,
  type ActivitySearch,
  type ActivityView,
} from "./query-contract.js";

const ROUTE = "/_shell/o/$organizationSlug/activity";
const PATH = "/o/$organizationSlug/activity";
const DESCRIPTION = "Trigger runs and the events no trigger matched";
const ALL = "all";

const RUN_COLUMNS: readonly DataColumn[] = [
  { header: "Trigger", fill: true },
  { header: "Source", className: "hidden md:table-cell" },
  { header: "Status", sort: "status" },
  { header: "Daemon", className: "hidden lg:table-cell" },
  { header: "Duration", align: "end", sort: "duration" },
  { header: "Received", align: "end", sort: "received_at" },
];

const UNMATCHED_COLUMNS: readonly DataColumn[] = [
  { header: "Event", fill: true },
  { header: "Provider", className: "hidden sm:table-cell" },
  { header: "Reason" },
  { header: "Delivery", className: "hidden lg:table-cell" },
  { header: "Received", align: "end", sort: "received_at" },
];

const VIEW_OPTIONS = [
  { value: "runs", label: "Runs" },
  { value: "unmatched", label: "Unmatched events" },
] as const;

const RANGE_OPTIONS: readonly FilterOption[] = ACTIVITY_RANGES.map((range) => ({
  value: range,
  label: RANGE_LABELS[range],
}));

const PROVIDER_OPTIONS: readonly FilterOption[] = [
  { value: ALL, label: "All" },
  ...ACTIVITY_PROVIDERS.map((provider) => ({
    value: provider,
    label: activityProviderLabel(provider),
  })),
];

const ANY_FAILURE = FAILED_RUN_STATUSES.join(",");
const STATUS_OPTIONS: readonly FilterOption[] = [
  { value: ALL, label: "All" },
  { value: ANY_FAILURE, label: "Any failure" },
  ...RUN_STATUSES.map((status) => ({ value: status, label: statusLabel(status) })),
];

const REASON_OPTIONS: readonly FilterOption[] = [
  { value: ALL, label: "All" },
  ...PROVIDER_EVENT_DROP_REASON_CODES.map((reason) => ({
    value: reason,
    label: DROP_REASONS[reason].label,
  })),
];

/**
 * Everything that happened in the organization: the runs its triggers started, and the events
 * that arrived and started nothing. The URL is the whole state of the screen, so every control
 * here writes the URL and reads it back; nothing is held only in a component.
 */
export function ActivityPanel() {
  const tenant = useRouteTenant();
  const organizationSlug = tenant.organization.slug;
  const search: ActivitySearch = useSearch({ from: ROUTE });
  const navigate = useNavigate({ from: PATH });
  const go = (next: ActivitySearch, options: { replace?: boolean } = {}) => {
    void navigate({ search: next, replace: options.replace ?? false });
  };
  const load = useServerFn(activitySnapshot);
  // The open record is not part of the list: opening one must not reload the rows beside it.
  const { selected, ...listSearch } = search;
  const snapshot = useSnapshotQuery({
    queryKey: ["activity", organizationSlug, listSearch],
    queryFn: () => load({ data: { organizationSlug, search: { ...listSearch } } }),
    keepPrevious: true,
  });
  const query = activityQuery(search);

  return (
    <>
      <PageHeader title="Activity" description={DESCRIPTION} />
      <div className="grid gap-4">
        <SegmentedControl
          label="Show"
          value={query.view}
          options={VIEW_OPTIONS}
          onChange={(view) => go(withView(search, view))}
        />
        <ActivityFilters
          search={search}
          snapshot={snapshot.status === "success" ? snapshot.data : undefined}
          onChange={go}
        />
        <ActivityList snapshot={snapshot} view={query.view} search={search} onChange={go} />
      </div>
      {selected === undefined ? null : (
        <ActivityDetail
          organizationSlug={organizationSlug}
          kind={query.view === "runs" ? "run" : "unmatched"}
          id={selected}
          neighbours={neighbours(
            snapshot.status === "success" ? snapshot.data : undefined,
            selected,
          )}
          onSelect={(id) => go(withSelected(search, id), { replace: true })}
          onClose={() => go(withSelected(search, undefined))}
          onFilter={(patch) => go(withFilters(search, patch))}
        />
      )}
    </>
  );
}

function tableLabel(view: ActivityView): string {
  return view === "runs" ? "Runs" : "Unmatched events";
}

/** The records above and below the open one, when it is on the page being shown. */
function neighbours(
  snapshot: ActivitySnapshot | undefined,
  selected: string,
): { previous?: string; next?: string } {
  const ids = snapshot?.list.rows.map((row) => row.id) ?? [];
  const index = ids.indexOf(selected);
  if (index === -1) return {};
  return {
    ...(index > 0 ? { previous: ids[index - 1] } : {}),
    ...(index < ids.length - 1 ? { next: ids[index + 1] } : {}),
  };
}

function ActivityFilters({
  search,
  snapshot,
  onChange,
}: {
  search: ActivitySearch;
  snapshot: ActivitySnapshot | undefined;
  onChange: (next: ActivitySearch) => void;
}) {
  const query = activityQuery(search);
  const filter = (patch: Parameters<typeof withFilters>[1]) => onChange(withFilters(search, patch));
  const choose = (value: string) => (value === ALL ? undefined : value);
  return (
    <FilterBar label="Filters">
      <FilterSearch
        label={query.view === "runs" ? "Search runs" : "Search events"}
        placeholder={query.view === "runs" ? "Search runs" : "Search events"}
        value={query.q ?? ""}
        onSearch={(q) => filter({ q: q === "" ? undefined : q })}
      />
      <FilterSelect
        label="Range"
        value={query.range}
        options={RANGE_OPTIONS}
        onChange={(range) => filter({ range })}
      />
      <FilterSelect
        label="Provider"
        value={search.provider ?? ALL}
        options={withCurrent(PROVIDER_OPTIONS, search.provider, () =>
          query.providers.map(activityProviderLabel).join(", "),
        )}
        onChange={(provider) => filter({ provider: choose(provider) })}
      />
      {query.view === "runs" ? (
        <>
          <FilterSelect
            label="Status"
            value={search.status ?? ALL}
            options={withCurrent(STATUS_OPTIONS, search.status, () =>
              query.statuses.map(statusLabel).join(", "),
            )}
            onChange={(status) => filter({ status: choose(status) })}
          />
          <FilterSelect
            label="Trigger"
            value={search.trigger ?? ALL}
            options={[
              { value: ALL, label: "All" },
              ...(snapshot?.filters.triggers ?? []).map((trigger) => ({
                value: trigger.id,
                label: trigger.name,
              })),
            ]}
            onChange={(trigger) => filter({ trigger: choose(trigger) })}
          />
          <FilterSelect
            label="Daemon"
            value={search.daemon ?? ALL}
            options={[
              { value: ALL, label: "All" },
              ...(snapshot?.filters.daemons ?? []).map((daemon) => ({
                value: daemon.id,
                label: daemon.slug,
              })),
            ]}
            onChange={(daemon) => filter({ daemon: choose(daemon) })}
          />
        </>
      ) : (
        <FilterSelect
          label="Reason"
          value={search.reason ?? ALL}
          options={REASON_OPTIONS}
          onChange={(reason) => filter({ reason: choose(reason) })}
        />
      )}
      {hasFilters(search) ? (
        <Button variant="ghost" onClick={() => onChange(withoutFilters(search))}>
          Clear filters
        </Button>
      ) : null}
    </FilterBar>
  );
}

/**
 * A link can ask for a combination the menu does not list, e.g. two sources. The menu then shows
 * that combination as its current value instead of a blank trigger.
 */
function withCurrent(
  options: readonly FilterOption[],
  value: string | undefined,
  label: () => string,
): readonly FilterOption[] {
  if (value === undefined || options.some((option) => option.value === value)) return options;
  return [...options, { value, label: label() }];
}

const UNFILTERED_EMPTY = {
  runs: (range: string) => ({
    title: `No runs in ${range}`,
    description: "Runs appear here when a trigger starts an agent",
  }),
  unmatched: (range: string) => ({
    title: `No unmatched events in ${range}`,
    description: "Every event that arrived started a run",
  }),
};

/** The list as its query stands: the same table while it loads, the failure, or the rows. */
function ActivityList({
  snapshot,
  view,
  search,
  onChange,
}: {
  snapshot: Snapshot<ActivitySnapshot> & { refetch: () => void; isFetching: boolean };
  view: ActivityView;
  search: ActivitySearch;
  onChange: (next: ActivitySearch) => void;
}) {
  if (snapshot.status === "pending") {
    return (
      <DataTableSkeleton
        label={tableLabel(view)}
        columns={view === "runs" ? RUN_COLUMNS : UNMATCHED_COLUMNS}
        rows={8}
      />
    );
  }
  if (snapshot.status === "error") {
    return (
      <FailureAlert
        title="Activity unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load this organization's activity"
        onRetry={snapshot.refetch}
      />
    );
  }
  return (
    <ActivityTable
      snapshot={snapshot.data}
      search={search}
      busy={snapshot.isFetching}
      onChange={onChange}
    />
  );
}

function ActivityTable({
  snapshot,
  search,
  busy,
  onChange,
}: {
  snapshot: ActivitySnapshot;
  search: ActivitySearch;
  busy: boolean;
  onChange: (next: ActivitySearch) => void;
}) {
  const query = activityQuery(search);
  const { list } = snapshot;
  const filtered = hasFilters(search);
  const sort = {
    key: query.sort,
    dir: query.dir,
    onSort: (key: string) => onChange(withSort(search, key)),
  };
  const pagination = {
    page: list.page,
    pageSize: list.pageSize,
    shown: list.rows.length,
    total: list.total,
    totalCapped: list.totalCapped,
    onPage: (page: number) => onChange(withPage(search, page)),
  };
  const open = (id: string) => onChange(withSelected(search, id));
  const selectedLink = (id: string) => ({ to: ".", search: withSelected(search, id) }) as const;
  const empty = filtered
    ? {
        title:
          list.view === "runs" ? "No runs match these filters" : "No events match these filters",
        action: (
          <Button variant="outline" onClick={() => onChange(withoutFilters(search))}>
            Clear filters
          </Button>
        ),
      }
    : UNFILTERED_EMPTY[list.view](RANGE_LABELS[query.range].toLowerCase());

  return (
    <div aria-busy={busy} className="grid gap-2">
      {list.view === "unmatched" ? (
        <StatusLine>Events no trigger matched are kept for 7 days</StatusLine>
      ) : null}
      {list.view === "runs" ? (
        <DataTable
          label="Runs"
          columns={RUN_COLUMNS}
          isEmpty={list.rows.length === 0 && list.page === 1}
          empty={empty}
          sort={sort}
          pagination={pagination}
        >
          {list.rows.map((run) => (
            <DataRow
              key={run.id}
              selected={run.id === search.selected}
              onSelect={() => open(run.id)}
            >
              <DataCell>
                <TwoLine
                  media={<ProviderGlyph provider={run.provider} />}
                  primary={
                    <Link
                      {...selectedLink(run.id)}
                      className="hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {run.triggerName}
                    </Link>
                  }
                  {...(run.repo === null ? {} : { secondary: run.repo })}
                />
              </DataCell>
              <DataCell>
                <span className="font-mono text-xs text-muted-foreground">{run.source}</span>
              </DataCell>
              <DataCell>
                <StatusPill tone={runStatusTone(run.status)}>{statusLabel(run.status)}</StatusPill>
              </DataCell>
              <DataCell>
                {run.daemon === null ? (
                  <span className="text-extra-muted-foreground">None</span>
                ) : (
                  <TwoLine
                    primary={run.daemon.slug}
                    {...(run.agent === null
                      ? {}
                      : { secondary: run.agent.model ?? run.agent.provider })}
                  />
                )}
              </DataCell>
              <DataCell>{formatDuration(run.durationMs)}</DataCell>
              <DataCell muted>
                <RelativeTime value={run.receivedAt} />
              </DataCell>
            </DataRow>
          ))}
        </DataTable>
      ) : (
        <DataTable
          label="Unmatched events"
          columns={UNMATCHED_COLUMNS}
          isEmpty={list.rows.length === 0 && list.page === 1}
          empty={empty}
          sort={sort}
          pagination={pagination}
        >
          {list.rows.map((event) => (
            <DataRow
              key={event.id}
              selected={event.id === search.selected}
              onSelect={() => open(event.id)}
            >
              <DataCell>
                <TwoLine
                  media={<ProviderGlyph provider={event.provider} />}
                  primary={
                    <Link
                      {...selectedLink(event.id)}
                      className="hover:underline"
                      onClick={(click) => click.stopPropagation()}
                    >
                      {event.source}
                    </Link>
                  }
                  {...(event.repo === null ? {} : { secondary: event.repo })}
                />
              </DataCell>
              <DataCell>{activityProviderLabel(event.provider)}</DataCell>
              <DataCell>
                <StatusPill tone={DROP_REASONS[event.reason].tone}>
                  {DROP_REASONS[event.reason].label}
                </StatusPill>
              </DataCell>
              <DataCell>
                <span className="font-mono text-xs text-muted-foreground">
                  {shortDelivery(event.deliveryId)}
                </span>
              </DataCell>
              <DataCell muted>
                <RelativeTime value={event.receivedAt} />
              </DataCell>
            </DataRow>
          ))}
        </DataTable>
      )}
    </div>
  );
}

/** Enough of a delivery ID to match it against a provider's delivery log; the drawer has all of it. */
function shortDelivery(deliveryId: string): string {
  return deliveryId.length <= 16 ? deliveryId : `${deliveryId.slice(0, 16)}…`;
}
