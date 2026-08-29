import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Sparkles } from "lucide-react";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { cn } from "../../lib/utils.js";
import type { BillingPlanPriceInterval } from "../../db/types.js";
import type { PublicBillingPlan } from "../../server/runtime.js";
import { billingCheckout } from "./functions.js";
import {
  intervalLabel,
  offeredIntervals,
  planAction,
  planPrice,
  recommendedPlanSlug,
  trialFootnote,
  TRIAL_DAYS,
} from "./presentation.js";

type CheckoutResult = Awaited<ReturnType<typeof billingCheckout>>;

/**
 * The plan picker. One modal, three bands: what the offer is, which interval to price it at, and
 * the plans themselves. The grid and the modal width are both driven by how many plans the
 * catalog publishes, so two plans read as a pair rather than two thirds of a three-column layout.
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
  const error = checkout.data?.status === "error" ? checkout.data.error.message : undefined;
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
  const recommended = recommendedPlanSlug(plans, interval, currentPlanSlug);

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          "max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0",
          dialogWidth(plans.length),
        )}
      >
        <div className="grid justify-items-center gap-5 px-6 pt-6 pb-5">
          {/* The badge reads the brand as text, so it uses `text-link`, not `text-primary` — the
              fill colour only reaches 2.7:1 against this surface. See the palette note in
              styles.css. */}
          {trialEligible && (
            <Badge variant="secondary" className="gap-1.5 px-3 py-1 text-link dark:bg-primary/15">
              <Sparkles aria-hidden="true" className="size-3" />
              {TRIAL_DAYS} days free · No card required
            </Badge>
          )}
          <DialogHeader className="items-center gap-1.5 text-center">
            <DialogTitle className="text-lg">Choose your plan</DialogTitle>
            <DialogDescription className="max-w-md text-balance">
              {trialEligible
                ? "Nothing is charged until the trial ends, and you can add a card later."
                : "Stripe handles payment and invoices. Cancel at any time."}
            </DialogDescription>
          </DialogHeader>
          {intervals.length > 1 && (
            <IntervalSwitch intervals={intervals} value={interval} onSelect={setInterval} />
          )}
        </div>
        <div className={cn("grid gap-3 px-6 pb-6", planColumns(plans.length))}>
          {plans.map((plan) => (
            <PlanCard
              key={plan.slug}
              plan={plan}
              interval={interval}
              isCurrent={plan.slug === currentPlanSlug}
              isRecommended={plan.slug === recommended}
              // A recommendation only means something against alternatives; the badge and the
              // ring would be decoration on a catalog that publishes one plan.
              isHighlighted={plan.slug === recommended && plans.length > 1}
              trialEligible={trialEligible}
              pending={checkout.isPending}
              onChoose={choose}
            />
          ))}
        </div>
        {error !== undefined && (
          <div className="px-6 pb-6">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A centred segmented control. Deliberately content-width: it is a choice between two words,
 * not a page-wide toolbar. The selected chip is a raised surface, so the one green thing in the
 * dialog stays the action the customer is here to take. */
function IntervalSwitch({
  intervals,
  value,
  onSelect,
}: {
  intervals: readonly BillingPlanPriceInterval[];
  value: BillingPlanPriceInterval;
  onSelect: (value: BillingPlanPriceInterval) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Billing interval"
      className="inline-flex items-center gap-1 rounded-lg border bg-muted/50 p-1"
    >
      {intervals.map((interval) => (
        <IntervalOption
          key={interval}
          value={interval}
          active={interval === value}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function IntervalOption({
  value,
  active,
  onSelect,
}: {
  value: BillingPlanPriceInterval;
  active: boolean;
  onSelect: (value: BillingPlanPriceInterval) => void;
}) {
  const select = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-pressed={active}
      onClick={select}
      className={cn(
        "min-w-24 px-4 text-muted-foreground hover:text-foreground",
        active && "bg-background text-foreground shadow-sm hover:bg-background",
      )}
    >
      {intervalLabel(value)}
    </Button>
  );
}

function PlanCard({
  plan,
  interval,
  isCurrent,
  isRecommended,
  isHighlighted,
  trialEligible,
  pending,
  onChoose,
}: {
  plan: PublicBillingPlan;
  interval: BillingPlanPriceInterval;
  isCurrent: boolean;
  /** The plan the picker leads with — it carries the filled call to action. */
  isRecommended: boolean;
  /** Whether to say so visually, which only reads as a recommendation next to another plan. */
  isHighlighted: boolean;
  trialEligible: boolean;
  pending: boolean;
  onChoose: (planSlug: string) => void;
}) {
  const price = plan.prices[interval];
  const action = planAction({ planName: plan.name, price, isCurrent, trialEligible });
  const footnote = trialFootnote(price, interval, trialEligible);
  const { amount, unit } = planPrice(price, interval);
  const choose = useCallback(() => onChoose(plan.slug), [onChoose, plan.slug]);

  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border bg-card p-5 text-card-foreground",
        isHighlighted && "border-primary/50 bg-primary/[0.04] ring-1 ring-primary/25",
      )}
    >
      <div className="flex min-h-6 items-start justify-between gap-2">
        <h3 className="text-sm font-medium">{plan.name}</h3>
        <PlanBadge isCurrent={isCurrent} isRecommended={isHighlighted} />
      </div>
      <p className="mt-3 text-3xl leading-none font-semibold tracking-tight">{amount}</p>
      <p className="mt-1.5 text-xs text-muted-foreground">{unit}</p>
      {/* Stacked on a phone, the plan you are already on collapses to a marker: its feature list
          is the one thing on the screen nobody needs to read, and it costs a full scroll. */}
      <ul
        className={cn(
          "mt-5 grid flex-1 content-start gap-2 text-sm text-muted-foreground",
          isCurrent && "hidden sm:grid",
        )}
      >
        {plan.marketingFeatures.map((feature) => (
          <li key={feature} className="flex items-start gap-2">
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      {/* The footnote sits above the button so every column's button shares one bottom edge,
          however much a plan has to explain about what happens after the trial. */}
      <div className="mt-6 grid gap-2">
        {footnote !== null && (
          <p className="text-center text-xs text-balance text-muted-foreground">{footnote}</p>
        )}
        <Button
          type="button"
          variant={isRecommended ? "default" : "outline"}
          aria-label={action.name}
          className="w-full"
          disabled={action.disabled || pending}
          onClick={choose}
        >
          {action.label}
        </Button>
      </div>
    </div>
  );
}

/** At most one badge per plan, and being the current plan outranks being recommended. */
function PlanBadge({ isCurrent, isRecommended }: { isCurrent: boolean; isRecommended: boolean }) {
  if (isCurrent) return <Badge variant="secondary">Current</Badge>;
  if (isRecommended) return <Badge>Recommended</Badge>;
  return null;
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
