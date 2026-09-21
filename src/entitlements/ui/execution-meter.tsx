/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- the usage and billing routes are addressed by a server-resolved organization slug */
import { useCallback } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Gauge } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../../components/ui/sidebar.js";
import { useRouteTenant } from "../../projects/context.js";
import type { UsageLimitsView, UsageMeasure } from "../../usage/dashboard.js";
import { useEntitlementRemedy, useOrganizationLimits } from "./limits.js";

/**
 * The organization's monthly execution allowance, or undefined when there is none to show: an
 * unlimited meter (a paid plan, and every self-hosted organization by default) and limits that
 * have not arrived yet both answer the same way, so a caller renders a meter or renders nothing.
 */
export function meteredExecutions(
  limits: Pick<UsageLimitsView, "executionsMonthly"> | undefined,
): UsageMeasure | undefined {
  const executions = limits?.executionsMonthly;
  if (executions === undefined || executions.limit === null) return undefined;
  return executions;
}

/** "12 of 50 executions this month" — what is left of the allowance, in the one sentence the
 * sidebar and the billing page both show. Never clamps: a limit lowered under what was already
 * consumed reads as the overage it is. */
export function executionMeterLabel(measure: UsageMeasure): string {
  return `${measure.used} of ${measure.limit} executions this month`;
}

/** The organization's execution meter, read from the same usage snapshot the Usage page shows. */
export function useExecutionMeter(): UsageMeasure | undefined {
  return meteredExecutions(useOrganizationLimits());
}

/**
 * The sidebar's standing account of the allowance: how much of this month is spent, and the way
 * to more of it. It renders only for an organization that has a finite allowance — a paid plan
 * and a self-hosted organization have nothing to count — and the upgrade line only where the
 * deployment has something to sell, so a self-hosted footer is exactly as it was.
 *
 * Both lines lead somewhere: the count to the Usage page that explains it, the action to the plan
 * picker. Neither is a disabled control or a bare number nobody can act on.
 */
export function ExecutionMeter() {
  const tenant = useRouteTenant();
  const meter = useExecutionMeter();
  const remedy = useEntitlementRemedy();
  const { isMobile, setOpenMobile } = useSidebar();
  // On compact the sidebar is an overlay covering the destination; client-side navigation has to
  // dismiss it the way the destinations above do.
  const navigate = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (meter === undefined) return null;
  const label = executionMeterLabel(meter);
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton asChild tooltip={label}>
          <Link to={`/o/${tenant.organization.slug}/settings/usage` as never} onClick={navigate}>
            <Gauge aria-hidden="true" />
            <span>{label}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
      {remedy.action !== null && (
        <SidebarMenuItem>
          <SidebarMenuButton asChild tooltip={remedy.action}>
            <Link to={remedy.href as never} onClick={navigate}>
              <ArrowUpRight aria-hidden="true" />
              <span>{remedy.action}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
    </>
  );
}
