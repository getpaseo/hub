/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the generated route type cannot express a server-resolved organization slug */
import { useCallback, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardSkeleton } from "../../components/app/card.js";
import { FailureAlert } from "../../components/app/failure-alert.js";
import { PageHeader } from "../../components/app/page.js";
import { Section } from "../../components/app/section.js";
import { StatusPill } from "../../components/app/status-pill.js";
import { Button } from "../../components/ui/button.js";
import { useRouteTenant } from "../../projects/context.js";
import type { BillingOverviewView, PublicBillingPlan } from "../../server/runtime.js";
import { billingOverview, billingPortal } from "./functions.js";
import { PlanDialog } from "./plan-dialog.js";
import {
  FeatureList,
  NO_SUBSCRIPTION,
  subscriptionSummary,
  type SubscriptionSummary,
} from "./presentation.js";

type PortalResult = Awaited<ReturnType<typeof billingPortal>>;

export function BillingPanel({ openPlans }: { openPlans: boolean }) {
  const tenant = useRouteTenant();
  const load = useServerFn(billingOverview);
  const query = useQuery({
    queryKey: ["billing", tenant.account.id, tenant.organization.id],
    queryFn: () => load({ data: { organizationSlug: tenant.organization.slug } }),
  });

  if (query.isPending) return <BillingLoading name={tenant.organization.name} />;
  if (query.isError || query.data.status === "error") {
    return (
      <FailureAlert
        title="Billing unavailable"
        error={query.data}
        fallback="Hub did not receive the billing state. Check your connection and reload the page."
      />
    );
  }
  return (
    <BillingContent
      overview={query.data.data}
      slug={tenant.organization.slug}
      openPlans={openPlans}
    />
  );
}

/**
 * One card, read top to bottom: who you are on this plan, what the plan includes, and the way out
 * to Stripe. The three read as one object because they are one card, not three — a subscription is
 * a single fact with a single set of consequences.
 */
function BillingContent({
  overview,
  slug,
  openPlans,
}: {
  overview: BillingOverviewView;
  slug: string;
  openPlans: boolean;
}) {
  const { subscription, plans, canManage } = overview;
  const action = planPickerAction({ canManage, subscription, plans });
  // The picker only opens on arrival when there is one to open: a member who follows the link
  // from a locked control lands on the page and reads it, rather than facing a dialog offering
  // a purchase they cannot make.
  const [dialogOpen, setDialogOpen] = useState(openPlans && action !== null);
  const openDialog = useCallback(() => setDialogOpen(true), []);
  const closeDialog = useCallback(() => setDialogOpen(false), []);
  const summary = subscriptionSummary(subscription);
  const currentPlan = plans.find((plan) => plan.slug === subscription.planSlug);

  return (
    <>
      <PageHeader
        title="Billing"
        description={`Plan and billing for ${overview.organization.name}.`}
      >
        <Button variant="outline" size="sm" asChild>
          <Link to={`/o/${slug}/settings/usage` as never}>View usage</Link>
        </Button>
      </PageHeader>
      <Section title="Plan">
        <Card>
          <PlanIdentity summary={summary} action={action} onOpenPicker={openDialog} />
          {currentPlan !== undefined && <PlanIncludes plan={currentPlan} />}
          {canManage && subscription.manageable && <PortalBand slug={slug} />}
        </Card>
      </Section>
      {dialogOpen && (
        <PlanDialog
          plans={plans}
          slug={slug}
          currentPlanSlug={subscription.planSlug}
          trialEligible={subscription.trialEligible}
          onClose={closeDialog}
        />
      )}
    </>
  );
}

/**
 * The button that opens the picker, or null when opening it would offer nothing. An organization
 * with no subscription is offered the one thing there is to do; a subscribed one is offered a
 * change only when the catalog publishes something to change to. Manage billing, in the band
 * below, is the way to leave.
 */
function planPickerAction({
  canManage,
  subscription,
  plans,
}: {
  canManage: boolean;
  subscription: BillingOverviewView["subscription"];
  plans: readonly PublicBillingPlan[];
}): string | null {
  if (!canManage) return null;
  if (subscription.planSlug === null) return "Subscribe";
  return plans.length > 1 ? "Change plan" : null;
}

function PlanIdentity({
  summary,
  action,
  onOpenPicker,
}: {
  summary: SubscriptionSummary;
  action: string | null;
  onOpenPicker: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="grid min-w-0 gap-2">
        {/* The pill is wrapped because a bare inline-flex stretches to the full grid track. */}
        {summary.status !== null && (
          <div>
            <StatusPill tone={summary.status.tone}>{summary.status.label}</StatusPill>
          </div>
        )}
        <p className="text-2xl">{summary.planName ?? NO_SUBSCRIPTION}</p>
        {summary.detail !== null && (
          <p className="text-sm text-muted-foreground">{summary.detail}</p>
        )}
      </div>
      {action !== null && (
        <Button type="button" onClick={onOpenPicker}>
          {action}
        </Button>
      )}
    </div>
  );
}

/** What the organization is actually entitled to right now, in the plan author's own words. */
function PlanIncludes({ plan }: { plan: PublicBillingPlan }) {
  if (plan.features.length === 0) return null;
  return <FeatureList features={plan.features} className="sm:grid-cols-2 sm:gap-x-6" />;
}

function PortalBand({ slug }: { slug: string }) {
  const open = useMutation({
    mutationFn: useServerFn(billingPortal) as (
      input: Parameters<typeof billingPortal>[0],
    ) => Promise<PortalResult>,
    onSuccess: (result) => {
      if (result.status === "ok" && result.data.url !== null) redirectTo(result.data.url);
    },
  });
  const failed = open.data?.status === "error";
  const start = useCallback(() => open.mutate({ data: { organizationSlug: slug } }), [open, slug]);

  return (
    <div className="grid justify-items-start gap-3">
      <Button type="button" variant="outline" size="sm" onClick={start} disabled={open.isPending}>
        Manage billing
      </Button>
      {failed && (
        <FailureAlert
          title="Billing portal unavailable"
          error={open.data}
          fallback="Hub could not open the billing portal. Try again in a moment."
        />
      )}
    </div>
  );
}

/** A web-only dashboard, so a plain navigation to the Stripe (or fixture) URL is correct. */
function redirectTo(url: string): void {
  window.location.assign(url);
}

function BillingLoading({ name }: { name: string }) {
  return (
    <>
      <PageHeader title="Billing" description={`Plan and billing for ${name}.`} />
      <Section title="Plan">
        <CardSkeleton lines={4} />
      </Section>
    </>
  );
}
