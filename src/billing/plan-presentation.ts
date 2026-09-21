export interface BillingPlanPresentation {
  name: string;
  features: readonly { key: string; label: string; tooltip: string | null }[];
  priceTooltips: { monthly: string | null; annual: string | null };
}

export type BillingPlanPresentations = Readonly<Record<string, BillingPlanPresentation>>;

/**
 * Hub owns the customer-facing name and words for each plan; Stripe owns the prices and the
 * entitlement template. The two meet in the catalog mirror, so the name here is what every
 * surface renders regardless of what the Stripe product is called.
 *
 * Feature copy never restates a number the template already carries — an allowance edited in
 * the Stripe dashboard would leave a hardcoded "50 executions" behind. The meter and the Usage
 * page read the real figure from the organization's own stamp.
 */
export const HUB_PLAN_PRESENTATIONS: BillingPlanPresentations = {
  free: {
    name: "Free",
    features: [
      { key: "monthly-executions", label: "A monthly allowance of agent runs", tooltip: null },
      {
        key: "managed-triggers",
        label: "Managed GitHub, Slack, and Discord triggers",
        tooltip: null,
      },
      { key: "daemon-location", label: "Daemons run on your machines", tooltip: null },
      { key: "solo", label: "One seat", tooltip: null },
    ],
    priceTooltips: { monthly: null, annual: null },
  },
  hosted: {
    name: "Pro",
    features: [
      { key: "unlimited-executions", label: "Unlimited agent runs", tooltip: null },
      { key: "seats", label: "Invite your team", tooltip: null },
      { key: "hub-operation", label: "Paseo operates Hub", tooltip: null },
      {
        key: "managed-triggers",
        label: "Managed GitHub, Slack, and Discord triggers",
        tooltip: null,
      },
      { key: "daemon-location", label: "Daemons run on your machines", tooltip: null },
      {
        key: "shared-model",
        label: "Same projects, workflows, and activity",
        tooltip: null,
      },
    ],
    priceTooltips: {
      monthly:
        "Seats are Hub members and pending invitations. People who only trigger agents through GitHub, Slack, or Discord do not count as seats.",
      annual: null,
    },
  },
};
