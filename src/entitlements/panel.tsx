import { useCallback, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { DataCell, DataRow, DataTable, type DataColumn } from "../components/app/data-table.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StatusPill } from "../components/app/status-pill.js";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Field, FieldLabel } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { useRouteTenant } from "../projects/context.js";
import type { EntitlementChangeSource } from "../db/types.js";
import type { EntitlementPatch } from "./catalog.js";
import type { EntitlementsDashboard } from "./dashboard.js";
import { entitlementsOverride, entitlementsSnapshot } from "./functions.js";

type EntitlementsSnapshot = Awaited<ReturnType<EntitlementsDashboard["snapshot"]>>;
type OverrideResult = Awaited<ReturnType<typeof entitlementsOverride>>;

/** Which entitlement an override dialog is editing, carrying the value to prefill. */
type OverrideTarget =
  | { kind: "seats"; max: number | null }
  | { kind: "canInviteMembers"; value: boolean }
  | { kind: "executionsMonthly"; limit: number | null };

const ENTITLEMENT_COLUMNS: readonly DataColumn[] = [
  { header: "Entitlement" },
  { header: "Granted" },
  { header: "Override" },
  { header: "Effective" },
  { header: "Used" },
  { header: "", align: "end" },
];
const ENTITLEMENTS_EMPTY = { title: "No entitlements" };
const AUDIT_COLUMNS: readonly DataColumn[] = [
  { header: "Change" },
  { header: "Actor" },
  { header: "Reason" },
  { header: "When", align: "end" },
];
const AUDIT_EMPTY = {
  title: "No changes yet",
  description: "Provisioning, plan stamps, and overrides appear here.",
};
const SOURCE_LABELS: Record<EntitlementChangeSource, string> = {
  provisioning: "Provisioning",
  plan_stamp: "Plan",
  override: "Override",
};

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
  return <EntitlementsContent snapshot={query.data.data} slug={tenant.organization.slug} />;
}

function EntitlementsContent({ snapshot, slug }: { snapshot: EntitlementsSnapshot; slug: string }) {
  const { effective, granted, overrides } = snapshot.entitlements;
  const canManage = snapshot.capabilities.manageResources;
  const [target, setTarget] = useState<OverrideTarget | null>(null);
  const closeEditor = useCallback(() => setTarget(null), []);
  const editSeats = useCallback(
    () => setTarget({ kind: "seats", max: effective.seats.max }),
    [effective.seats.max],
  );
  const editInvites = useCallback(
    () => setTarget({ kind: "canInviteMembers", value: effective.canInviteMembers }),
    [effective.canInviteMembers],
  );
  const effectiveExecutionsLimit = effective.meters["executions.monthly"].limit;
  const editExecutionsMonthly = useCallback(
    () => setTarget({ kind: "executionsMonthly", limit: effectiveExecutionsLimit }),
    [effectiveExecutionsLimit],
  );

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
            <DataCell muted>—</DataCell>
            <DataCell align="end">
              <OverrideAction
                canManage={canManage}
                label="Override seat limit"
                onClick={editSeats}
              />
            </DataCell>
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
            <DataCell muted>—</DataCell>
            <DataCell align="end">
              <OverrideAction
                canManage={canManage}
                label="Override members can invite"
                onClick={editInvites}
              />
            </DataCell>
          </DataRow>
          <DataRow>
            <DataCell>Executions this month</DataCell>
            <DataCell muted>{meterLimitLabel(granted.meters["executions.monthly"].limit)}</DataCell>
            <DataCell muted>
              {overrides.meters?.["executions.monthly"]?.limit === undefined
                ? "—"
                : meterLimitLabel(overrides.meters["executions.monthly"].limit)}
            </DataCell>
            <DataCell>{meterLimitLabel(effectiveExecutionsLimit)}</DataCell>
            <DataCell>{meterUsageLabel(snapshot.usage)}</DataCell>
            <DataCell align="end">
              <OverrideAction
                canManage={canManage}
                label="Override executions this month"
                onClick={editExecutionsMonthly}
              />
            </DataCell>
          </DataRow>
        </DataTable>
      </Section>
      <Section
        title="Audit trail"
        description="Every provisioning, plan stamp, and override, most recent first."
      >
        <AuditTrail history={snapshot.history} />
      </Section>
      {canManage && target !== null && (
        <OverrideDialog target={target} slug={slug} onClose={closeEditor} />
      )}
    </>
  );
}

function OverrideAction({
  canManage,
  label,
  onClick,
}: {
  canManage: boolean;
  label: string;
  onClick: () => void;
}) {
  if (!canManage) return null;
  return (
    <Button type="button" variant="outline" size="sm" aria-label={label} onClick={onClick}>
      Override
    </Button>
  );
}

function OverrideDialog({
  target,
  slug,
  onClose,
}: {
  target: OverrideTarget;
  slug: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: useServerFn(entitlementsOverride) as (
      input: Parameters<typeof entitlementsOverride>[0],
    ) => Promise<OverrideResult>,
    onSuccess: async (result) => {
      if (result.status !== "ok") return;
      await queryClient.invalidateQueries({ queryKey: ["entitlements"] });
      onClose();
    },
  });
  const error = save.data?.status === "error" ? save.data.error.message : undefined;

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      save.mutate({
        data: {
          organizationSlug: slug,
          patch: patchFrom(target, data),
          reason: formText(data, "reason").trim(),
        },
      });
    },
    [save, slug, target],
  );
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{overrideTitle(target)}</DialogTitle>
          <DialogDescription>
            Overrides are hand-set and survive plan changes. Every override is recorded in the audit
            trail with the reason you give.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} aria-label="Override entitlement" className="grid gap-6">
          {target.kind === "seats" && <SeatsControl max={target.max} />}
          {target.kind === "canInviteMembers" && <InviteControl value={target.value} />}
          {target.kind === "executionsMonthly" && <ExecutionsMonthlyControl limit={target.limit} />}
          <Field>
            <FieldLabel htmlFor="override-reason">Reason</FieldLabel>
            <Input
              id="override-reason"
              name="reason"
              required
              maxLength={500}
              placeholder="Why is this override being made?"
            />
          </Field>
          {error !== undefined && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="submit" disabled={save.isPending}>
              Save override
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SeatsControl({ max }: { max: number | null }) {
  return (
    <Field>
      <FieldLabel htmlFor="override-seats">Seat limit</FieldLabel>
      <Input
        id="override-seats"
        name="seats"
        type="number"
        min={1}
        step={1}
        defaultValue={max === null ? "" : String(max)}
        placeholder="Leave blank for unlimited"
      />
    </Field>
  );
}

function InviteControl({ value }: { value: boolean }) {
  const [choice, setChoice] = useState(value ? "allowed" : "blocked");
  return (
    <Field>
      <FieldLabel htmlFor="override-invite">Members can invite</FieldLabel>
      <Select name="invite" value={choice} onValueChange={setChoice}>
        <SelectTrigger id="override-invite" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="allowed">Allowed</SelectItem>
          <SelectItem value="blocked">Not allowed</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
}

function ExecutionsMonthlyControl({ limit }: { limit: number | null }) {
  return (
    <Field>
      <FieldLabel htmlFor="override-executions-monthly">Executions this month</FieldLabel>
      <Input
        id="override-executions-monthly"
        name="executionsMonthly"
        type="number"
        min={1}
        step={1}
        defaultValue={limit === null ? "" : String(limit)}
        placeholder="Leave blank for unlimited"
      />
    </Field>
  );
}

function AuditTrail({ history }: { history: EntitlementsSnapshot["history"] }) {
  return (
    <DataTable
      label="Audit trail"
      columns={AUDIT_COLUMNS}
      isEmpty={history.length === 0}
      empty={AUDIT_EMPTY}
    >
      {history.map((entry) => (
        <DataRow key={entry.id}>
          <DataCell>
            <div className="flex flex-col gap-1">
              <Badge variant={sourceBadgeVariant(entry.source)}>
                {SOURCE_LABELS[entry.source]}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {effectiveLabel(entry.effective)}
              </span>
            </div>
          </DataCell>
          <DataCell muted>{entry.actorName ?? "System"}</DataCell>
          <DataCell muted className="max-w-xs">
            <span className="block truncate" title={entry.reason ?? undefined}>
              {entry.reason ?? "—"}
            </span>
          </DataCell>
          <DataCell align="end" muted>
            <RelativeTime value={entry.createdAt} />
          </DataCell>
        </DataRow>
      ))}
    </DataTable>
  );
}

function InviteBadge({ canInvite }: { canInvite: boolean }) {
  return (
    <StatusPill tone={canInvite ? "success" : "neutral"} dot={false}>
      {canInvite ? "Allowed" : "Not allowed"}
    </StatusPill>
  );
}

function patchFrom(target: OverrideTarget, data: FormData): EntitlementPatch {
  if (target.kind === "seats") {
    const raw = formText(data, "seats").trim();
    return { seats: { max: raw === "" ? null : Number(raw) } };
  }
  if (target.kind === "executionsMonthly") {
    const raw = formText(data, "executionsMonthly").trim();
    return { meters: { "executions.monthly": { limit: raw === "" ? null : Number(raw) } } };
  }
  return { canInviteMembers: data.get("invite") === "allowed" };
}

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

function overrideTitle(target: OverrideTarget): string {
  if (target.kind === "seats") return "Override seat limit";
  if (target.kind === "executionsMonthly") return "Override executions this month";
  return "Override members can invite";
}

function effectiveLabel(effective: EntitlementsSnapshot["entitlements"]["effective"]): string {
  const invite = effective.canInviteMembers ? "Allowed" : "Not allowed";
  const executions = meterLimitLabel(effective.meters["executions.monthly"].limit);
  return `Seats: ${seatLimitLabel(effective.seats.max)} · Invites: ${invite} · Executions: ${executions}`;
}

function sourceBadgeVariant(source: EntitlementChangeSource): "default" | "secondary" | "outline" {
  if (source === "override") return "default";
  if (source === "plan_stamp") return "secondary";
  return "outline";
}

function seatLimitLabel(max: number | null): string {
  return max === null ? "Unlimited" : String(max);
}

function meterLimitLabel(limit: number | null): string {
  return limit === null ? "Unlimited" : String(limit);
}

function meterUsageLabel(usage: EntitlementsSnapshot["usage"]): string {
  return usage.limit === null ? String(usage.used) : `${usage.used}/${usage.limit}`;
}

function EntitlementsLoading() {
  return (
    <section aria-label="Loading entitlements" aria-busy="true" className="grid gap-6">
      <Skeleton className="h-12 w-64" />
      <Skeleton className="h-48 w-full" />
    </section>
  );
}
