import { useCallback, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles } from "lucide-react";
import { Card } from "../../components/app/card.js";
import { FailureAlert } from "../../components/app/failure-alert.js";
import { SegmentedControl, type SegmentedOption } from "../../components/app/segmented-control.js";
import { StatusPill } from "../../components/app/status-pill.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "../../components/ui/dialog.js";
import { cn } from "../../lib/utils.js";
import type { BillingPlanPriceInterval } from "../../db/types.js";
import type { PublicBillingPlan } from "../../server/runtime.js";
import { billingCheckout } from "./functions.js";
import {
  FeatureList,
  intervalLabel,
  offeredIntervals,
  planAction,
  planPrice,
  priceForInterval,
  TRIAL_DAYS,
} from "./presentation.js";

type CheckoutResult = Awaited<ReturnType<typeof billingCheckout>>;

/**
 * The plan picker. It shows the offer and nothing else: the trial line when one is available,
 * then a card per plan, then the action. There is no heading, no framing sentence, and no
 * interval control unless the catalog actually prices more than one interval — a customer who
 * has one thing to accept should not have to read past anything to accept it.
 *
 * The grid and the modal width are driven by how many plans the catalog publishes, so a future
 * second product lays out as a pair without a redesign.
 */
export function PlanDialog({
  plans,
  slug,
  currentPlanSlug,
  trialEligible,
  onClose,
}: {
  plans: readonly PublicBillingPlan[];
  slug: string;
  currentPlanSlug: string | null;
  trialEligible: boolean;
  onClose: () => void;
}) {
  const intervals = offeredIntervals(plans);
  const [interval, setInterval] = useState<BillingPlanPriceInterval>(intervals[0] ?? "monthly");
  const checkout = useMutation({
    mutationFn: useServerFn(billingCheckout) as (
      input: Parameters<typeof billingCheckout>[0],
    ) => Promise<CheckoutResult>,
    onSuccess: (result) => {
      if (result.status === "ok") redirectTo(result.data.url);
    },
  });
  const failed = checkout.data?.status === "error";
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onClose();
    },
    [onClose],
  );
  const choose = useCallback(
    (planSlug: string) => checkout.mutate({ data: { organizationSlug: slug, planSlug, interval } }),
    [checkout, interval, slug],
  );

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent aria-describedby={undefined} className={dialogWidth(plans.length)}>
        {/* Radix requires a title for the dialog to be announced. There is nothing on this
            surface a sighted customer needs a heading for, so it is read, not shown. */}
        <DialogTitle className="sr-only">Plan</DialogTitle>
        {(trialEligible || intervals.length > 1) && (
          <div className="grid justify-items-center gap-4">
            {trialEligible && (
              <p className="flex items-center gap-1.5 text-sm">
                <Sparkles aria-hidden="true" className="size-3.5 shrink-0" />
                {TRIAL_DAYS} days free · No card required
              </p>
            )}
            {intervals.length > 1 && (
              <IntervalSwitch intervals={intervals} value={interval} onSelect={setInterval} />
            )}
          </div>
        )}
        <div className={cn("grid gap-3", planColumns(plans.length))}>
          {plans.map((plan) => (
            <PlanCard
              key={plan.slug}
              plan={plan}
              interval={interval}
              isCurrent={plan.slug === currentPlanSlug}
              trialEligible={trialEligible}
              pending={checkout.isPending}
              onChoose={choose}
            />
          ))}
        </div>
        {failed && (
          <FailureAlert
            title="Checkout unavailable"
            error={checkout.data}
            fallback="Hub could not start checkout. Try again in a moment."
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Rendered only when the catalog prices more than one interval: a choice between two words. */
function IntervalSwitch({
  intervals,
  value,
  onSelect,
}: {
  intervals: readonly BillingPlanPriceInterval[];
  value: BillingPlanPriceInterval;
  onSelect: (value: BillingPlanPriceInterval) => void;
}) {
  const options = useMemo<readonly SegmentedOption[]>(
    () => intervals.map((interval) => ({ value: interval, label: intervalLabel(interval) })),
    [intervals],
  );
  // The control speaks in strings; only an interval the catalog actually offers is accepted back,
  // so the state stays typed without asserting.
  const select = useCallback(
    (next: string) => {
      const chosen = intervals.find((interval) => interval === next);
      if (chosen !== undefined) onSelect(chosen);
    },
    [intervals, onSelect],
  );
  return (
    <SegmentedControl label="Billing interval" value={value} options={options} onChange={select} />
  );
}

function PlanCard({
  plan,
  interval,
  isCurrent,
  trialEligible,
  pending,
  onChoose,
}: {
  plan: PublicBillingPlan;
  interval: BillingPlanPriceInterval;
  isCurrent: boolean;
  trialEligible: boolean;
  pending: boolean;
  onChoose: (planSlug: string) => void;
}) {
  const price = priceForInterval(plan, interval);
  const action = planAction({ planName: plan.name, price, isCurrent, trialEligible });
  const { amount, unit } = planPrice(price, interval);
  const choose = useCallback(() => onChoose(plan.slug), [onChoose, plan.slug]);

  return (
    <Card>
      <div className="flex h-full flex-col gap-4">
        <div className="flex min-h-6 items-start justify-between gap-2">
          <h3 className="text-sm">{plan.name}</h3>
          {isCurrent && (
            <StatusPill tone="neutral" dot={false}>
              Current
            </StatusPill>
          )}
        </div>
        <div className="grid gap-1">
          <p className="text-3xl tabular-nums">{amount}</p>
          <p className="text-xs text-muted-foreground">{unit}</p>
        </div>
        {/* Stacked on a phone, the plan you are already on collapses to a marker: its feature list
            is the one thing on the screen nobody needs to read, and it costs a full scroll. */}
        <FeatureList
          features={plan.features}
          className={cn("flex-1", isCurrent && "hidden sm:grid")}
        />
        <Button
          type="button"
          aria-label={action.name}
          className="w-full"
          disabled={action.disabled || pending}
          onClick={choose}
        >
          {action.label}
        </Button>
      </div>
    </Card>
  );
}

/** Two plans read as a pair, three as a row. More than three wrap rather than shrink to slivers. */
function planColumns(count: number): string {
  if (count <= 1) return "";
  if (count === 2) return "sm:grid-cols-2";
  if (count === 3) return "sm:grid-cols-3";
  return "sm:grid-cols-2";
}

function dialogWidth(count: number): string {
  if (count <= 1) return "sm:max-w-md";
  if (count === 2) return "sm:max-w-2xl";
  return "sm:max-w-3xl";
}

/** A web-only dashboard, so a plain navigation to the Stripe (or fixture) URL is correct. */
function redirectTo(url: string): void {
  window.location.assign(url);
}
