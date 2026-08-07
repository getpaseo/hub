import { createFileRoute } from "@tanstack/react-router";
import { handleBillingPlans } from "../../../server/runtime.js";

// Public, unauthenticated, read-only. Returns an empty list on a self-hosted instance that has
// never synced a Stripe catalog — see the plan's "Stripe is the plan catalog's source of
// truth" section and docs/public-api.md.
export const Route = createFileRoute("/api/billing/plans")({
  server: {
    handlers: {
      GET: async () => Response.json({ plans: await handleBillingPlans() }),
    },
  },
});
