import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { BillingPanel } from "../../../../../billing/ui/panel.js";
import { billingConfigured } from "../../../../../server/capabilities.js";

// Hosted-only. The loader 404s on a self-hosted instance so the page behaves as if unregistered
// there — see the plan's "no config means billing routes are never registered". When configured,
// it renders the billing section (current plan + the plan dialog).
//
// This route is the billing feature's dashboard mount point — analogous to a composition root —
// so it is exempted from the src/billing/ import boundary in oxlint.json, which lets the whole
// feature (server + UI) live under src/billing/ and be deleted as one directory.
export const Route = createFileRoute("/_shell/o/$organizationSlug/settings/billing")({
  // `?plans` arrives from surfaces that hit a plan limit — the locked invite control on Team — so
  // the picker is open on arrival instead of asking the customer to find it again.
  validateSearch: z.object({ plans: z.boolean().optional() }),
  loader: async () => {
    const { configured } = await billingConfigured();
    if (!configured) throw notFound();
  },
  component: BillingRoute,
});

function BillingRoute() {
  const { plans } = Route.useSearch();
  return <BillingPanel openPlans={plans === true} />;
}
