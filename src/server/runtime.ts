import type { HubOperations, HubRuntime } from "../app.js";
import type { BillingRuntime } from "../billing/index.js";
import type { BillingPlanPriceInterval } from "../db/types.js";
import type { EntitlementsDashboard } from "../entitlements/dashboard.js";
import type {
  OrganizationResourceReader,
  OrganizationResources,
} from "../organizations/resources.js";
import type { ProjectDashboard } from "../projects/dashboard.js";
import type { PublicApi } from "../public-api/index.js";

/**
 * The public plan catalog shape — name, slug, prices by interval, marketing bullets. Never
 * carries the entitlement template; see the plan's public plans endpoint section.
 */
export interface PublicBillingPlan {
  slug: string;
  name: string;
  marketingFeatures: readonly string[];
  prices: Record<BillingPlanPriceInterval, PublicBillingPlanPrice | null>;
}

export interface PublicBillingPlanPrice {
  unitAmount: number;
  currency: string;
}

export interface ApplicationRuntime {
  hub: HubRuntime;
  operations: HubOperations;
  publicApi: PublicApi;
  resources: OrganizationResources | null;
  /** HOSTED only. Null self-hosted; present when the composition root has a billing config. */
  billing: BillingRuntime | null;
  projectDashboard: ProjectDashboard | null;
  entitlementsDashboard: EntitlementsDashboard | null;
  testTriggerRoutes: boolean;
  auth(request: Request): Promise<Response>;
  browserAccount?(request: Request): Promise<Response>;
  signInEmail?(data: { email: string; password: string }, headers: Headers): Promise<void>;
  signUpEmail?(
    data: { name: string; email: string; password: string },
    headers: Headers,
    invitationId?: string,
  ): Promise<void>;
  signOut?(headers: Headers): Promise<void>;
  changePassword?(
    data: { currentPassword: string; newPassword: string },
    headers: Headers,
  ): Promise<void>;
  organizationResources(request: Request): Promise<OrganizationResourceReader>;
  webhook(request: Request): Promise<Response>;
  /** The Stripe product/price webhook. Unconfigured behaves as if the route did not exist. */
  billingWebhook(request: Request): Promise<Response>;
  /** name/slug/prices/marketing bullets only — never the entitlement template. Always readable,
   * empty on a self-hosted instance that has never synced. */
  billingPlans(): Promise<PublicBillingPlan[]>;
  providerRequest(name: string, request: Request): Promise<Response>;
  connectionStatus(request: Request): Promise<Response>;
  connectionAction(request: Request, provider: string, action: string): Promise<Response>;
  stop(): Promise<void>;
}

type ApplicationFactory = () => ApplicationRuntime | Promise<ApplicationRuntime>;

let application: Promise<ApplicationRuntime> | undefined;

export function startApplication(factory: ApplicationFactory): Promise<ApplicationRuntime> {
  application ??= Promise.resolve().then(factory);
  return application;
}

export async function stopApplication(): Promise<void> {
  const active = application;
  application = undefined;
  await (await active)?.stop();
}

export function hasApplication(): boolean {
  return application !== undefined;
}

export function getApplication(): Promise<ApplicationRuntime> {
  if (application === undefined) throw new Error("application is not started");
  return application;
}

export async function handleAuth(request: Request): Promise<Response> {
  return (await getApplication()).auth(request);
}

export async function handleWebhook(request: Request): Promise<Response> {
  return (await getApplication()).webhook(request);
}

export async function handleBillingWebhook(request: Request): Promise<Response> {
  return (await getApplication()).billingWebhook(request);
}

export async function handleBillingPlans(): Promise<PublicBillingPlan[]> {
  return (await getApplication()).billingPlans();
}

export async function handleProviderRequest(name: string, request: Request): Promise<Response> {
  return (await getApplication()).providerRequest(name, request);
}

export async function handleConnections(
  request: Request,
  operation:
    | "status"
    | "githubStart"
    | "githubDisconnect"
    | "githubSetup"
    | "githubCallback"
    | "discordStart"
    | "discordDisconnect"
    | "discordCallback"
    | "slackStart"
    | "slackDisconnect"
    | "slackCallback",
): Promise<Response> {
  const runtime = await getApplication();
  if (operation === "status") return runtime.connectionStatus(request);
  const action = CONNECTION_ACTIONS[operation];
  return runtime.connectionAction(request, action.provider, action.name);
}

const CONNECTION_ACTIONS = {
  githubStart: { provider: "github", name: "start" },
  githubDisconnect: { provider: "github", name: "disconnect" },
  githubSetup: { provider: "github", name: "setup" },
  githubCallback: { provider: "github", name: "callback" },
  discordStart: { provider: "discord", name: "start" },
  discordDisconnect: { provider: "discord", name: "disconnect" },
  discordCallback: { provider: "discord", name: "callback" },
  slackStart: { provider: "slack", name: "start" },
  slackDisconnect: { provider: "slack", name: "disconnect" },
  slackCallback: { provider: "slack", name: "callback" },
} as const;

export async function resolveOrganizationResources(
  request: Request,
): Promise<OrganizationResourceReader> {
  return (await getApplication()).organizationResources(request);
}

export async function areTestTriggerRoutesEnabled(): Promise<boolean> {
  return (await getApplication()).testTriggerRoutes;
}
