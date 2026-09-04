/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- dynamic tenant URLs are assembled from server-resolved route metadata */
import {
  ArrowLeft,
  Blocks,
  Cable,
  Cpu,
  Gauge,
  History,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { Page } from "../components/app/page.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { PanelSkeleton } from "../components/app/loading.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
} from "../components/ui/sidebar.js";
import type { ActiveAccountState } from "../auth/organization-contract.js";
import { createOrganization, selectOrganization, signOut } from "../auth/functions.js";
import { ErrorSummary } from "../auth/account-states.js";
import { ActiveAccountProvider } from "../auth/active-account.js";
import type { Result } from "../contract/respond.js";
import { ACCOUNT_MUTATION_KEY, useAccountMutationError } from "../auth/account-mutation.js";
import { useTenantContextMutationPending } from "../auth/tenant-mutation.js";
import {
  RouteTenantProvider,
  useOptionalRouteTenant,
  useRouteTenantStatus,
} from "../projects/context.js";
import { SidebarHelp } from "../auth/sidebar-help.js";
import { TrialNotice } from "../auth/trial-notice.js";
import { NavigationGroup, type NavigationItem } from "./navigation-group.js";
import { SidebarIdentity } from "./sidebar-switcher.js";
import {
  AccountMenu,
  OrganizationSwitcher,
  ProjectSwitcher,
  type RouteTenant,
} from "./switchers.js";
import { SiteHeader } from "./site-header.js";
import { SiteHeaderActionsProvider } from "./site-header-actions.js";

type ActiveAccount = ActiveAccountState;
type AccountCommandResult = Result<{
  state: "sessionExpired" | "organizationRequired" | "complete";
}>;
type CreateOrganizationCommandResult = Result<{
  state: "sessionExpired" | "complete";
  organizationSlug?: string;
}>;

export function DashboardShell({ account }: { account: ActiveAccount }) {
  const createOrganizationCommand = useAccountCommand(
    useServerFn(createOrganization) as (
      input: Parameters<typeof createOrganization>[0],
    ) => Promise<CreateOrganizationCommandResult>,
  );
  const signOutCommand = useAccountCommand(
    useServerFn(signOut) as (
      input: Parameters<typeof signOut>[0],
    ) => Promise<Result<Record<string, never>>>,
  );
  const selectOrganizationCommand = useAccountCommand(
    useServerFn(selectOrganization) as (
      input: Parameters<typeof selectOrganization>[0],
    ) => Promise<AccountCommandResult>,
  );
  const create = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: createOrganizationCommand,
    onSuccess: (result) => {
      if (result.status === "ok" && result.data.organizationSlug !== undefined) {
        window.location.assign(`/o/${result.data.organizationSlug}/triggers`);
      }
    },
  });
  const select = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: ({ input }: { input: Parameters<typeof selectOrganization>[0]; slug: string }) =>
      selectOrganizationCommand(input),
    onSuccess: (result, variables) => {
      if (result.status === "ok") window.location.assign(`/o/${variables.slug}/triggers`);
    },
  });
  const leave = useMutation({
    mutationKey: ACCOUNT_MUTATION_KEY,
    mutationFn: signOutCommand,
  });
  const tenantContextMutationsPending = useTenantContextMutationPending();
  const tenantContextTransitioning = create.isPending || select.isPending || leave.isPending;
  const failed = useAccountMutationError();
  const createAccount = useCallback((name: string) => create.mutate({ data: { name } }), [create]);
  const selectAccount = useCallback(
    (organizationId: string, slug: string) =>
      select.mutate({ input: { data: { organizationId } }, slug }),
    [select],
  );
  const leaveAccount = useCallback(() => leave.mutate({}), [leave]);
  return (
    <SidebarProvider>
      <RouteTenantProvider>
        <DashboardContent
          account={account}
          busy={tenantContextMutationsPending}
          transitioning={tenantContextTransitioning}
          error={failed}
          onCreateOrganization={createAccount}
          onSelectOrganization={selectAccount}
          onSignOut={leaveAccount}
        />
      </RouteTenantProvider>
    </SidebarProvider>
  );
}

function DashboardContent({
  account,
  busy,
  transitioning,
  error,
  onCreateOrganization,
  onSelectOrganization,
  onSignOut,
}: {
  account: ActiveAccount;
  busy: boolean;
  transitioning: boolean;
  error: string | undefined;
  onCreateOrganization: (name: string) => void;
  onSelectOrganization: (organizationId: string, slug: string) => void;
  onSignOut: () => void;
}) {
  const tenant = useOptionalRouteTenant() ?? undefined;
  const instance = useInstanceScope(account.isInstanceOperator);
  return (
    <>
      <AppSidebar
        account={account}
        tenant={tenant}
        instance={instance}
        busy={busy}
        onCreateOrganization={onCreateOrganization}
        onSelectOrganization={onSelectOrganization}
        onSignOut={onSignOut}
      />
      <SiteHeaderActionsProvider>
        <SidebarInset>
          <SiteHeader
            scope={instance ? "Instance" : (tenant?.organization.name ?? account.organization.name)}
            {...(instance || tenant?.project == null ? {} : { project: tenant.project.name })}
          />
          {/* The app's one content inset. Screens never pad themselves. */}
          <div className="flex flex-1 flex-col p-4 md:p-8">
            <Page>
              <ErrorSummary message={error} />
              <PageContent account={account} tenant={tenant} transitioning={transitioning} />
            </Page>
          </div>
        </SidebarInset>
      </SiteHeaderActionsProvider>
    </>
  );
}

function useAccountCommand<TInput, TResult extends Result<unknown>>(
  command: (input: TInput) => Promise<TResult>,
): (input: TInput) => Promise<TResult> {
  const queryClient = useQueryClient();
  return useCallback(
    async (input: TInput) => {
      const result = await command(input);
      if (result.status === "ok") {
        await queryClient.invalidateQueries({ queryKey: ["account"] });
      }
      return result;
    },
    [command, queryClient],
  );
}

/**
 * The page slot. Switching organization and resolving the tenant behind a URL both replace what
 * is inside it and nothing else — the sidebar and site header stay put, because the app is not
 * going anywhere while a read is in flight.
 */
function PageContent({
  account,
  tenant,
  transitioning,
}: {
  account: ActiveAccount;
  tenant: RouteTenant | undefined;
  transitioning: boolean;
}) {
  const status = useRouteTenantStatus();
  // One name for the slot, whichever read is in flight: switching organization and resolving the
  // tenant behind a URL are the same wait to someone listening to the page.
  if (transitioning || status.state === "pending") {
    return <PanelSkeleton label="Loading account context" />;
  }
  if (status.state === "failed") {
    return <FailureAlert title={status.title} error={status.message} fallback={status.message} />;
  }
  return (
    <ActiveAccountProvider account={account}>
      <div key={tenant?.project?.id ?? "organization"}>
        <Outlet />
      </div>
    </ActiveAccountProvider>
  );
}

function AppSidebar({
  account,
  tenant,
  instance,
  busy,
  onCreateOrganization,
  onSelectOrganization,
  onSignOut,
}: {
  account: ActiveAccount;
  tenant: RouteTenant | undefined;
  instance: boolean;
  busy: boolean;
  onCreateOrganization: (name: string) => void;
  onSelectOrganization: (organizationId: string, slug: string) => void;
  onSignOut: () => void;
}) {
  // The sidebar header stacks one switcher per level of where you are: organization, then
  // project. The body lists destinations for the innermost level only. Anything outside the
  // organization → project chain — instance, account — enters through the footer account menu.
  // Location accumulates; destinations swap.
  const project = tenant?.project ?? null;
  const organization = tenant?.organization ?? account.organization;
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {instance ? (
              <SidebarIdentity
                media={INSTANCE_MARK}
                primary="Instance"
                secondary="Administration"
              />
            ) : (
              <OrganizationSwitcher
                account={account}
                organization={organization}
                role={tenant?.membership.role ?? account.membership.role}
                busy={busy}
                onCreateOrganization={onCreateOrganization}
                onSelectOrganization={onSelectOrganization}
              />
            )}
          </SidebarMenuItem>
          {instance || tenant === undefined || tenant.project === null ? null : (
            <SidebarMenuItem>
              <ProjectSwitcher tenant={tenant} />
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <Destinations instance={instance} organization={organization} project={project} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <TrialNotice organizationSlug={organization.slug} />
          <SidebarHelp />
          <SidebarMenuItem>
            <AccountMenu
              email={account.account.email}
              name={account.account.name}
              operator={account.isInstanceOperator}
              busy={busy}
              onSignOut={onSignOut}
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** The innermost level's destinations, and only those. Each group owns its own way back out. */
function Destinations({
  instance,
  organization,
  project,
}: {
  instance: boolean;
  organization: { name: string; slug: string };
  project: { slug: string } | null;
}) {
  if (instance) {
    return (
      <NavigationGroup
        label="Instance"
        back={wayBack(`/o/${organization.slug}/triggers`, `Back to ${organization.name}`)}
        items={INSTANCE_DESTINATIONS}
      />
    );
  }
  if (project === null) {
    return (
      <NavigationGroup
        label="Organization"
        items={destinations(`/o/${organization.slug}`, ORGANIZATION_SECTIONS)}
      />
    );
  }
  return (
    <NavigationGroup
      label="Project"
      back={wayBack(`/o/${organization.slug}/projects`, "All projects")}
      items={destinations(`/o/${organization.slug}/projects/${project.slug}`, PROJECT_SECTIONS)}
    />
  );
}

const INSTANCE_MARK = <ShieldCheck aria-hidden="true" className="size-4" />;

/** Going up is not a sibling of going across, so it is always the same item with the same arrow. */
function wayBack(to: string, label: string): NavigationItem {
  return { to, label, icon: ArrowLeft };
}

interface SectionDestination {
  section: string;
  label: string;
  icon: NavigationItem["icon"];
  subtree?: boolean;
}

function destinations(base: string, sections: readonly SectionDestination[]): NavigationItem[] {
  return sections.map((entry) => ({
    to: `${base}/${entry.section}`,
    label: entry.label,
    icon: entry.icon,
    ...(entry.subtree === undefined ? {} : { subtree: entry.subtree }),
  }));
}

// Work, then administration. Team, API keys, Usage, and Billing are configured once and read
// occasionally, so they sit behind Settings rather than competing with the three surfaces an
// operator opens daily.
const ORGANIZATION_SECTIONS: readonly SectionDestination[] = [
  { section: "triggers", label: "Triggers", icon: Zap, subtree: true },
  { section: "activity", label: "Activity", icon: History },
  { section: "daemons", label: "Daemons", icon: Cpu },
  { section: "connections", label: "Connections", icon: Cable },
  { section: "settings", label: "Settings", icon: Settings, subtree: true },
];
const PROJECT_SECTIONS: readonly SectionDestination[] = [
  { section: "overview", label: "Overview", icon: Gauge },
  { section: "configuration", label: "Configuration", icon: SlidersHorizontal },
  { section: "activity", label: "Activity", icon: History },
  { section: "settings", label: "Settings", icon: Settings },
];
// The instance is the deployment, so its surfaces sit outside `/o/` and there is no tenant in
// their paths. That also makes the path the only thing that can say you are on one.
const INSTANCE_DESTINATIONS: readonly NavigationItem[] = [
  { to: "/apps", label: "Apps", icon: Blocks },
  { to: "/operator", label: "Operator", icon: ShieldCheck },
];

/**
 * Instance scope is a property of the user, not of a tenant, so a non-operator on an instance
 * route keeps the organization sidebar and their way back out — the route itself refuses them.
 */
function useInstanceScope(operator: boolean): boolean {
  const onInstanceRoute = useRouterState({
    select: (state) =>
      INSTANCE_DESTINATIONS.some((destination) => destination.to === state.location.pathname),
  });
  return operator && onInstanceRoute;
}
