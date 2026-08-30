/**
 * Browser-harness Forgejo journeys. T01 composes the inert registration once.
 * T02 fills instance approval, connection, and repository enrollment journeys.
 */
export const BROWSER_FORGEJO_SCENARIOS = [
  "forgejo-not-configured",
  "forgejo-configured",
  "forgejo-instance-approval",
  "forgejo-connection-enroll",
  "forgejo-empty",
  "forgejo-error",
] as const;

export type BrowserForgejoScenario = (typeof BROWSER_FORGEJO_SCENARIOS)[number];

export interface BrowserForgejoJourney {
  scenario: BrowserForgejoScenario;
  instanceOperator: boolean;
  organizationRole: "owner" | "member" | null;
  originField: "origin";
  patField: "pat";
  patInputType: "password";
  maskedSecret: "••••";
  approveForm: "Approve Forgejo instance";
  connectForm: "Create Forgejo connection";
  enrollForm: string | null;
  emptyTitle: string | null;
  error: string | null;
}

export function browserForgejoJourney(scenario: BrowserForgejoScenario): BrowserForgejoJourney {
  if (scenario === "forgejo-instance-approval") {
    return {
      scenario,
      instanceOperator: true,
      organizationRole: null,
      originField: "origin",
      patField: "pat",
      patInputType: "password",
      maskedSecret: "••••",
      approveForm: "Approve Forgejo instance",
      connectForm: "Create Forgejo connection",
      enrollForm: null,
      emptyTitle: null,
      error: null,
    };
  }
  if (scenario === "forgejo-connection-enroll") {
    return {
      scenario,
      instanceOperator: false,
      organizationRole: "owner",
      originField: "origin",
      patField: "pat",
      patInputType: "password",
      maskedSecret: "••••",
      approveForm: "Approve Forgejo instance",
      connectForm: "Create Forgejo connection",
      enrollForm: "Enroll repositories for forgejo-bot",
      emptyTitle: null,
      error: null,
    };
  }
  if (scenario === "forgejo-empty") {
    return {
      scenario,
      instanceOperator: false,
      organizationRole: "owner",
      originField: "origin",
      patField: "pat",
      patInputType: "password",
      maskedSecret: "••••",
      approveForm: "Approve Forgejo instance",
      connectForm: "Create Forgejo connection",
      enrollForm: null,
      emptyTitle: "No approved instances",
      error: null,
    };
  }
  if (scenario === "forgejo-error") {
    return {
      scenario,
      instanceOperator: true,
      organizationRole: null,
      originField: "origin",
      patField: "pat",
      patInputType: "password",
      maskedSecret: "••••",
      approveForm: "Approve Forgejo instance",
      connectForm: "Create Forgejo connection",
      enrollForm: null,
      emptyTitle: null,
      error: "Forgejo 16.0.2 is below 16.0.3",
    };
  }
  return {
    scenario,
    instanceOperator: scenario === "forgejo-configured",
    organizationRole: scenario === "forgejo-configured" ? "owner" : null,
    originField: "origin",
    patField: "pat",
    patInputType: "password",
    maskedSecret: "••••",
    approveForm: "Approve Forgejo instance",
    connectForm: "Create Forgejo connection",
    enrollForm: null,
    emptyTitle: scenario === "forgejo-not-configured" ? "No approved instances" : null,
    error: null,
  };
}
