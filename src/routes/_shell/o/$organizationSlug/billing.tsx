import { createFileRoute, notFound } from "@tanstack/react-router";
import { BillingPanel } from "../../../../billing-ui/panel.js";
import { billingConfigured } from "../../../../billing-ui/functions.js";

// Hosted-only. The loader 404s on a self-hosted instance so the page behaves as if unregistered
// there — see the plan's "no config means billing routes are never registered". When configured,
// it renders the billing section (current plan + the plan dialog).
export const Route = createFileRoute("/_shell/o/$organizationSlug/billing")({
  loader: async () => {
    const { configured } = await billingConfigured();
    if (!configured) throw notFound();
  },
  component: BillingPanel,
});
