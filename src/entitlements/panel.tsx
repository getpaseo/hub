import { useCallback, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { TriangleAlert } from "lucide-react";
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
import type { EntitlementPatch, OverrideKey } from "./catalog.js";
import type { EntitlementsDashboard } from "./dashboard.js";
import {
  entitlementsClearOverride,
  entitlementsOverride,
  entitlementsSnapshot,
} from "./functions.js";

type EntitlementsSnapshot = Awaited<ReturnType<EntitlementsDashboard["snapshot"]>>;
type OverrideResult = Awaited<ReturnType<typeof entitlementsOverride>>;
type ClearOverrideResult = Awaited<ReturnType<typeof entitlementsClearOverride>>;

/**
 * Which entitlement an override dialog is editing, carrying the value to prefill and whether an
 * override is currently set (which is what unlocks "Reset to plan default"). `key` is the
 * override identity the clear path removes.
 */
type OverrideTarget =
  | { kind: "seats"; key: OverrideKey; hasOverride: boolean; max: number | null }
  | { kind: "canInviteMembers"; key: OverrideKey; hasOverride: boolean; value: boolean }
  | { kind: "executionsMonthly"; key: OverrideKey; hasOverride: boolean; limit: number | null };

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
  const seatsOverridden = overrides.seats?.max !== undefined;
  const editSeats = useCallback(
    () =>
      setTarget({
        kind: "seats",
        key: "seats",
        hasOverride: seatsOverridden,
        max: effective.seats.max,
      }),
    [effective.seats.max, seatsOverridden],
  );
  const invitesOverridden = overrides.canInviteMembers !== undefined;
  const editInvites = useCallback(
    () =>
      setTarget({
        kind: "canInviteMembers",
        key: "canInviteMembers",
        hasOverride: invitesOverridden,
        value: effective.canInviteMembers,
      }),
    [effective.canInviteMembers, invitesOverridden],
  );
  const effectiveExecutionsLimit = effective.meters["executions.monthly"].limit;
  const executionsOverridden = overrides.meters?.["executions.monthly"]?.limit !== undefined;
  const editExecutionsMonthly = useCallback(
    () =>
      setTarget({
        kind: "executionsMonthly",
        key: "executions.monthly",
        hasOverride: executionsOverridden,
        limit: effectiveExecutionsLimit,
      }),
    [effectiveExecutionsLimit, executionsOverridden],
  );

  return (
    <>
      <PageHeader
        title="Entitlements"
        description={`What ${snapshot.organization.name} is currently allowed to do.`}
      />
      <OverLimitBanner overages={snapshot.overages} />
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

/**
 * Shown after a downgrade leaves an organization above a plan cap. Grandfathering means nothing
 * was deleted, so the tone is a warning, not an error: it says what is over and by how much, and
 * what the admin can do, without alarming them about data they still have. Renders nothing when
 * every cap has headroom.
 */
function OverLimitBanner({ overages }: { overages: EntitlementsSnapshot["overages"] }) {
  if (overages.length === 0) return null;
  return (
    <Alert aria-label="Over plan limit" className="border-warning/40 bg-warning-surface">
      <TriangleAlert className="text-warning" />
      <AlertTitle>You're over your plan's limits</AlertTitle>
      <AlertDescription>
        {overages.map((overage) => (
          <p key={overage.entitlement}>{overageSentence(overage)}</p>
        ))}
        <p>
          Your existing seats are kept — nothing was removed. To add more, upgrade your plan or
          remove members and pending invitations to fit.
        </p>
      </AlertDescription>
    </Alert>
  );
}

/** `seats` is the only cap today, so the noun is fixed; the loop above already handles more. */
function overageSentence(overage: EntitlementsSnapshot["overages"][number]): string {
  return `You have ${overage.current} seats in use, but your current plan includes ${overage.limit}.`;
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
  const onSaved = useCallback(
    async (status: "ok" | "error") => {
      if (status !== "ok") return;
      await queryClient.invalidateQueries({ queryKey: ["entitlements"] });
      onClose();
    },
    [onClose, queryClient],
  );
  const save = useMutation({
    mutationFn: useServerFn(entitlementsOverride) as (
      input: Parameters<typeof entitlementsOverride>[0],
    ) => Promise<OverrideResult>,
    onSuccess: (result) => onSaved(result.status),
  });
  const clear = useMutation({
    mutationFn: useServerFn(entitlementsClearOverride) as (
      input: Parameters<typeof entitlementsClearOverride>[0],
    ) => Promise<ClearOverrideResult>,
    onSuccess: (result) => onSaved(result.status),
  });
  const saveError = save.data?.status === "error" ? save.data.error.message : undefined;
  const clearError = clear.data?.status === "error" ? clear.data.error.message : undefined;
  const error = saveError ?? clearError;
  const pending = save.isPending || clear.isPending;

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // Which submit button was pressed decides set vs clear; reading it off the native
      // SubmitEvent keeps the reason field's `required` validation firing for both buttons.
      const native = event.nativeEvent;
      const submitter = native instanceof SubmitEvent ? native.submitter : null;
      const data = new FormData(
        event.currentTarget,
        submitter instanceof HTMLButtonElement ? submitter : null,
      );
      const reason = formText(data, "reason").trim();
      if (data.get("intent") === "clear") {
        clear.mutate({ data: { organizationSlug: slug, key: target.key, reason } });
        return;
      }
      save.mutate({ data: { organizationSlug: slug, patch: patchFrom(target, data), reason } });
    },
    [clear, save, slug, target],
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
            Overrides are hand-set and survive plan changes. Every override — and every reset back
            to the plan default — is recorded in the audit trail with the reason you give.
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
            {target.hasOverride && (
              <Button
                type="submit"
                name="intent"
                value="clear"
                variant="outline"
                disabled={pending}
              >
                Reset to plan default
              </Button>
            )}
            <Button type="submit" name="intent" value="save" disabled={pending}>
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
