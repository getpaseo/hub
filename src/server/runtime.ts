import type { HubOperations, HubRuntime } from "../app.js";
import type {
  OrganizationResourceReader,
  OrganizationResources,
} from "../organizations/resources.js";
import type { ProjectDashboard } from "../projects/dashboard.js";
import type { PublicApi } from "../public-api/index.js";

export interface ApplicationRuntime {
  hub: HubRuntime;
  operations: HubOperations;
  publicApi: PublicApi;
  resources: OrganizationResources | null;
  projectDashboard: ProjectDashboard | null;
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
