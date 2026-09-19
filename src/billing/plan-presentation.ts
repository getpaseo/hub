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
 * Feature copy never states a figure. Seats and the monthly execution allowance are rendered
 * from the plan's `included` facts, which the catalog sync flattens out of the validated
 * template — so the number a customer reads is the number enforcement stamps, and editing a
 * plan in the Stripe dashboard changes both at once. Anything written here is copy that no
 * template can contradict.
 */
export const HUB_PLAN_PRESENTATIONS: BillingPlanPresentations = {
  free: {
    name: "Free",
    features: [
      {
        key: "managed-triggers",
        label: "Managed GitHub, Slack, and Discord triggers",
        tooltip: null,
      },
      { key: "daemon-location", label: "Daemons run on your machines", tooltip: null },
    ],
    priceTooltips: { monthly: null, annual: null },
  },
  hosted: {
    name: "Pro",
    features: [
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
