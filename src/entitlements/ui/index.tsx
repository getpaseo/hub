/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- dynamic remedy URLs are validated by their route owners */
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Lock, type LucideIcon } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { useRouteTenant } from "../../projects/context.js";
import { billingConfigured } from "../../server/capabilities.js";
import type { UsageLimitsView } from "../../usage/dashboard.js";
import { usageSnapshot } from "../../usage/functions.js";
export { atLimit, overLimit } from "../../usage/limits.js";

export function useOrganizationLimits(enabled = true): UsageLimitsView | undefined {
  const tenant = useRouteTenant();
  const load = useServerFn(usageSnapshot);
  const query = useQuery({
    queryKey: ["usage", tenant.account.id, tenant.organization.id],
    queryFn: () => load({ data: { organizationSlug: tenant.organization.slug } }),
    enabled,
  });

  return query.data?.status === "ok" ? query.data.data.limits : undefined;
}

export interface EntitlementRemedy {
  href: string;
  clause: string;
}

/** The place this deployment gives an organization to raise or understand its limits. */
export function useEntitlementRemedy(enabled = true): EntitlementRemedy {
  const tenant = useRouteTenant();
  const load = useServerFn(billingConfigured);
  const billing = useQuery({
    queryKey: ["billing-configured"],
    queryFn: () => load(),
    staleTime: Number.POSITIVE_INFINITY,
    enabled,
  });
  const base = `/o/${tenant.organization.slug}/settings`;

  if (billing.data?.configured === true) {
    return {
      href: `${base}/billing?plans=true`,
      clause: "See the plans available to this organization.",
    };
  }
  return { href: `${base}/usage`, clause: "See the Usage page for its limits." };
}

export function LockedAction({
  limit,
  label,
  icon: Icon,
  onPress,
  busy = false,
}: {
  limit: string | null;
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  busy?: boolean;
}) {
  const remedy = useEntitlementRemedy(limit !== null);

  if (limit === null) {
    return (
      <Button type="button" onClick={onPress} disabled={busy}>
        <Icon aria-hidden="true" />
        {label}
      </Button>
    );
  }
  return (
    <Button asChild>
      <Link to={remedy.href as never} title={`${limit} ${remedy.clause}`}>
        <Lock aria-hidden="true" />
        {label}
      </Link>
    </Button>
  );
}
