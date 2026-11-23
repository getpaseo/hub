import { Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { TabNav, type TabNavItem } from "../components/app/tab-nav.js";
import { billingConfigured } from "../server/capabilities.js";
import { useRouteTenant } from "../projects/context.js";

/**
 * Organization administration. Each section keeps its own `<h1>` and actions, so this contributes
 * only the strip that says which sections exist — the sidebar stops at "Settings" and this is
 * where the choice between Team, API keys, Usage, and Billing is made.
 */
export function OrganizationSettingsLayout() {
  const tenant = useRouteTenant();
  const base = `/o/${tenant.organization.slug}/settings`;
  // Billing is hosted-only: the tab appears solely when the instance is billing-configured, so a
  // self-hosted deployment shows no billing surface at all (the route also 404s there).
  const loadBillingConfigured = useServerFn(billingConfigured);
  const billing = useQuery({
    queryKey: ["billing-configured"],
    queryFn: () => loadBillingConfigured(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const manageResources = tenant.capabilities.manageResources;
  const billingShown = billing.data?.configured === true;
  const sections = useMemo<TabNavItem[]>(
    () =>
      [
        { to: `${base}/team`, label: "Team", shown: true },
        { to: `${base}/api-keys`, label: "API keys", shown: manageResources },
        { to: `${base}/usage`, label: "Usage", shown: true },
        { to: `${base}/billing`, label: "Billing", shown: billingShown },
      ]
        .filter((section) => section.shown)
        .map(({ to, label }) => ({ to, label })),
    [base, billingShown, manageResources],
  );
  return (
    <>
      <TabNav label="Organization settings" items={sections} />
      <Outlet />
    </>
  );
}
