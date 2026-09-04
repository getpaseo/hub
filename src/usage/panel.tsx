import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  DataCell,
  DataRow,
  DataTable,
  DataTableSkeleton,
  type DataColumn,
} from "../components/app/data-table.js";
import { FailureAlert, WarningAlert } from "../components/app/failure-alert.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StatusPill } from "../components/app/status-pill.js";
import type { EntitlementChangeSource } from "../db/types.js";
import { useRouteTenant } from "../projects/context.js";
import type { UsageDashboard, UsageMeasure } from "./dashboard.js";
import { usageSnapshot } from "./functions.js";
import { overLimit } from "./limits.js";

type Snapshot = Awaited<ReturnType<UsageDashboard["snapshot"]>>;

const LIMITS_TITLE = "Limits";
const LIMITS_DESCRIPTION = "What this organization is allowed, and how much is in use.";
const HISTORY_TITLE = "History";
const HISTORY_DESCRIPTION = "Every change to this organization's limits, most recent first.";
const LIMIT_COLUMNS: readonly DataColumn[] = [
  { header: "Resource" },
  { header: "Limit" },
  { header: "In use", align: "end" },
];
const HISTORY_COLUMNS: readonly DataColumn[] = [
  { header: "Change" },
  { header: "Reason" },
  { header: "Who" },
  { header: "When", align: "end" },
];
const HISTORY_EMPTY = {
  title: "No changes yet",
  description: "Limit changes to this organization appear here.",
};

// Customer-facing labels — never the operator's "override" / "entitlement" vocabulary, and no
// plan language on the two sources that occur self-hosted (provisioning and limit changes).
const SOURCE_LABELS: Record<EntitlementChangeSource, string> = {
  provisioning: "Provisioned",
  plan_stamp: "Plan update",
  override: "Limit change",
};

export function OrganizationUsagePanel() {
  const tenant = useRouteTenant();
  const load = useServerFn(usageSnapshot);
  const query = useQuery({
    queryKey: ["usage", tenant.account.id, tenant.organization.id],
    queryFn: () => load({ data: { organizationSlug: tenant.organization.slug } }),
  });

  if (query.isPending) return <UsageLoading name={tenant.organization.name} />;
  if (query.isError || query.data.status === "error") {
    return (
      <FailureAlert
        title="Usage unavailable"
        error={query.data}
        fallback="Hub did not receive the usage snapshot. Check your connection and reload the page."
      />
    );
  }
  return <UsageContent snapshot={query.data.data} />;
}

function UsageContent({ snapshot }: { snapshot: Snapshot }) {
  const { limits } = snapshot;
  return (
    <>
      <PageHeader
        title="Usage"
        description={`Limits and usage for ${snapshot.organization.name}.`}
      />
      <SeatOverLimitBanner seats={limits.seats} />
      <Section title={LIMITS_TITLE} description={LIMITS_DESCRIPTION}>
        <DataTable label="Limits" columns={LIMIT_COLUMNS} isEmpty={false} empty={LIMITS_EMPTY}>
          <DataRow>
            <DataCell>Seats</DataCell>
            <DataCell muted>{limitLabel(limits.seats.limit)}</DataCell>
            <DataCell align="end">{limits.seats.used}</DataCell>
          </DataRow>
          <DataRow>
            <DataCell>Members can invite</DataCell>
            <DataCell muted>
              <StatusPill tone={limits.canInviteMembers ? "success" : "neutral"} dot={false}>
                {limits.canInviteMembers ? "Allowed" : "Not allowed"}
              </StatusPill>
            </DataCell>
            <DataCell align="end" muted>
              —
            </DataCell>
          </DataRow>
          <DataRow>
            <DataCell>Executions this month</DataCell>
            <DataCell muted>{limitLabel(limits.executionsMonthly.limit)}</DataCell>
            <DataCell align="end">{measureUsage(limits.executionsMonthly)}</DataCell>
          </DataRow>
        </DataTable>
      </Section>
      <Section title={HISTORY_TITLE} description={HISTORY_DESCRIPTION}>
        <History history={snapshot.history} />
      </Section>
    </>
  );
}

const LIMITS_EMPTY = { title: "No limits" };

/**
 * Grandfathering means an over-limit organization keeps everything it has and only loses the
 * ability to grow. This renders on self-hosted too, so the copy names the limit and stays silent
 * on remedies — the Billing page owns any upgrade call to action, and a self-hosted limit is the
 * operator's to raise. Renders nothing while within the seat limit.
 */
function SeatOverLimitBanner({ seats }: { seats: UsageMeasure }) {
  if (!overLimit(seats)) return null;
  return (
    <WarningAlert title="You're over your seat limit">
      <p>
        You have {seats.used} seats in use, but your limit is {seats.limit}.
      </p>
      <p>
        Your existing seats are kept — nothing was removed. You can't add more until you're within
        the limit.
      </p>
    </WarningAlert>
  );
}

function History({ history }: { history: Snapshot["history"] }) {
  return (
    <DataTable
      label="History"
      columns={HISTORY_COLUMNS}
      isEmpty={history.length === 0}
      empty={HISTORY_EMPTY}
    >
      {history.map((entry) => (
        <DataRow key={entry.id}>
          <DataCell>{SOURCE_LABELS[entry.source]}</DataCell>
          <DataCell muted className="max-w-xs">
            <span className="block truncate" title={entry.reason ?? undefined}>
              {entry.reason ?? "—"}
            </span>
          </DataCell>
          <DataCell muted>{entry.actorName ?? "System"}</DataCell>
          <DataCell align="end" muted>
            <RelativeTime value={entry.createdAt} />
          </DataCell>
        </DataRow>
      ))}
    </DataTable>
  );
}

function limitLabel(limit: number | null): string {
  return limit === null ? "Unlimited" : String(limit);
}

function measureUsage(measure: UsageMeasure): string {
  return measure.limit === null ? String(measure.used) : `${measure.used}/${measure.limit}`;
}

function UsageLoading({ name }: { name: string }) {
  return (
    <>
      <PageHeader title="Usage" description={`Limits and usage for ${name}.`} />
      <Section title={LIMITS_TITLE} description={LIMITS_DESCRIPTION}>
        <DataTableSkeleton label="Limits" columns={LIMIT_COLUMNS} />
      </Section>
      <Section title={HISTORY_TITLE} description={HISTORY_DESCRIPTION}>
        <DataTableSkeleton label="History" columns={HISTORY_COLUMNS} rows={2} />
      </Section>
    </>
  );
}
