export interface BillingPlanPresentation {
  name: string;
  features: readonly { key: string; label: string; tooltip: string | null }[];
  priceTooltips: { monthly: string | null; annual: string | null };
}

export type BillingPlanPresentations = Readonly<Record<string, BillingPlanPresentation>>;

export const HUB_PLAN_PRESENTATIONS: BillingPlanPresentations = {
  free: {
    name: "Free",
    features: [],
    priceTooltips: { monthly: null, annual: null },
  },
  hosted: {
    name: "Hosted",
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
