import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { DataCell, DataRow, DataTable, type DataColumn } from "../components/app/data-table.js";
import { PageHeader } from "../components/app/page.js";
import { Section } from "../components/app/section.js";
import { StatusPill } from "../components/app/status-pill.js";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { useRouteTenant } from "../projects/context.js";
import type { EntitlementsDashboard } from "./dashboard.js";
import { entitlementsSnapshot } from "./functions.js";

type EntitlementsSnapshot = Awaited<ReturnType<EntitlementsDashboard["snapshot"]>>;

const ENTITLEMENT_COLUMNS: readonly DataColumn[] = [
  { header: "Entitlement" },
  { header: "Granted" },
  { header: "Override" },
  { header: "Effective" },
  { header: "", align: "end" },
];
const ENTITLEMENTS_EMPTY = { title: "No entitlements" };

export function OrganizationEntitlementsPanel() {
  const tenant = useRouteTenant();
  const load = useServerFn(entitlementsSnapshot);
  const query = useQuery({
    queryKey: ["entitlements", tenant.account.id, tenant.organization.id],
    queryFn: () => load({ data: { organizationSlug: tenant.organization.slug } }),
  });

  if (query.isPending) return <EntitlementsLoading />;
  if (query.isError || query.data.status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Entitlements unavailable</AlertTitle>
        <AlertDescription>
          {query.data?.status === "error"
            ? query.data.error.message
            : "We couldn't load this organization's entitlements."}
        </AlertDescription>
      </Alert>
    );
  }
  return <EntitlementsContent snapshot={query.data.data} />;
}

function EntitlementsContent({ snapshot }: { snapshot: EntitlementsSnapshot }) {
  const { effective, granted, overrides } = snapshot.entitlements;
  return (
    <>
      <PageHeader
        title="Entitlements"
        description={`What ${snapshot.organization.name} is currently allowed to do.`}
      />
      <Section
        title="Entitlements"
        description="Effective values, granted by your plan and adjusted by any manual overrides."
      >
        <DataTable
          label="Entitlements"
          columns={ENTITLEMENT_COLUMNS}
          isEmpty={false}
          empty={ENTITLEMENTS_EMPTY}
        >
          <DataRow>
            <DataCell>Seats</DataCell>
            <DataCell muted>{seatLimitLabel(granted.seats.max)}</DataCell>
            <DataCell muted>
              {overrides.seats?.max === undefined ? "—" : seatLimitLabel(overrides.seats.max)}
            </DataCell>
            <DataCell>{seatLimitLabel(effective.seats.max)}</DataCell>
            <DataCell align="end">{null}</DataCell>
          </DataRow>
          <DataRow>
            <DataCell>Members can invite</DataCell>
            <DataCell muted>
              <InviteBadge canInvite={granted.canInviteMembers} />
            </DataCell>
            <DataCell muted>
              {overrides.canInviteMembers === undefined ? (
                "—"
              ) : (
                <InviteBadge canInvite={overrides.canInviteMembers} />
              )}
            </DataCell>
            <DataCell>
              <InviteBadge canInvite={effective.canInviteMembers} />
            </DataCell>
            <DataCell align="end">{null}</DataCell>
          </DataRow>
        </DataTable>
      </Section>
    </>
  );
}

function InviteBadge({ canInvite }: { canInvite: boolean }) {
  return (
    <StatusPill tone={canInvite ? "success" : "neutral"} dot={false}>
      {canInvite ? "Allowed" : "Not allowed"}
    </StatusPill>
  );
}

function seatLimitLabel(max: number | null): string {
  return max === null ? "Unlimited" : String(max);
}

function EntitlementsLoading() {
  return (
    <section aria-label="Loading entitlements" aria-busy="true" className="grid gap-6">
      <Skeleton className="h-12 w-64" />
      <Skeleton className="h-48 w-full" />
    </section>
  );
}
