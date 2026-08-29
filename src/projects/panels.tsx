/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop, typescript-eslint/no-unsafe-type-assertion -- route links and mutation controls are intentionally scoped to each rendered tenant snapshot */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, type ReactNode } from "react";
import { CONNECTION_MUTATION_KEY } from "../auth/tenant-mutation.js";
import { useActiveAccount } from "../auth/active-account.js";
import { Card, CardSkeleton } from "../components/app/card.js";
import { ConfirmAction, ConfirmMenuItem } from "../components/app/confirm-action.js";
import { CodeBlock } from "../components/app/copy-field.js";
import { DataCell, DataRow, DataTable } from "../components/app/data-table.js";
import { FormActions } from "../components/app/form-actions.js";
import { FormField } from "../components/app/form-field.js";
import { FailureAlert, NoticeAlert } from "../components/app/failure-alert.js";
import { EmptyState } from "../components/app/empty-state.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime, formatAbsolute } from "../components/app/relative-time.js";
import { RecordList, RecordRow } from "../components/app/record-list.js";
import { RowActions } from "../components/app/row-actions.js";
import { Section } from "../components/app/section.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { SummaryPanel, type SummaryRow } from "../components/app/summary-panel.js";
import { TwoLine } from "../components/app/two-line.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import { useConnectionReturn } from "../connections/result.js";
import { connectionReturnCopy, type ConnectionReturnCopy } from "../connections/result-contract.js";
import { Button } from "../components/ui/button.js";
import { DaemonsPanel } from "../daemons/account-daemons.js";
import type { Result } from "../contract/respond.js";
import {
  connectionStatus,
  disconnectConnection,
  startConnection,
  type ConnectionDisconnectResult,
  type ConnectionStatus,
} from "../connections/functions.js";
import { useRouteTenant } from "./context.js";
import type { ProjectDashboard } from "./dashboard.js";
import {
  CommandError,
  invalidateOrganization,
  invalidateScope,
  projectScope,
  queryState,
  useOrganizationSnapshot,
  useProjectCommand,
  useProjectSnapshot,
  type OrganizationSnapshot,
  type ProjectSnapshot,
} from "./panel-state.js";
import { archiveProject, activityRunSnapshot, updateProjectSlug } from "./functions.js";
const CONNECTIONS_DESCRIPTION = "Organization provider connections.";
const CONNECTION_PROVIDERS = ["github", "discord", "slack", "linear"] as const;
type ConnectionProviderName = (typeof CONNECTION_PROVIDERS)[number];

function ConnectionsLoading() {
  return (
    <>
      <PageHeader title="Connections" description={CONNECTIONS_DESCRIPTION} />
      <Section>
        {CONNECTION_PROVIDERS.map((provider) => (
          <CardSkeleton key={provider} lines={2} />
        ))}
      </Section>
    </>
  );
}

export function OrganizationConnectionsPanel() {
  const tenant = useRouteTenant();
  const { isInstanceOperator } = useActiveAccount();
  const queryClient = useQueryClient();
  const scope = { organizationSlug: tenant.organization.slug };
  const snapshot = useOrganizationSnapshot(<ConnectionsLoading />);
  const loadStatus = useServerFn(connectionStatus);
  const statusQuery = useQuery({
    queryKey: ["connection-status", tenant.account.id, tenant.organization.id],
    queryFn: () => loadStatus({ data: scope }),
  });
  const [returned, setReturned] = useConnectionReturn();
  const connect = useMutation({
    mutationKey: CONNECTION_MUTATION_KEY,
    mutationFn: useServerFn(startConnection),
  });
  const disconnect = useMutation({
    mutationKey: CONNECTION_MUTATION_KEY,
    mutationFn: useServerFn(disconnectConnection) as (
      input: Parameters<typeof disconnectConnection>[0],
    ) => Promise<Result<{ result: ConnectionDisconnectResult }>>,
    onSuccess: async (response, variables) => {
      if (response.status !== "ok") return;
      setReturned({ provider: variables.data.provider, result: response.data.result });
      await Promise.all([
        invalidateOrganization(queryClient, scope.organizationSlug),
        queryClient.invalidateQueries({
          queryKey: ["connection-status", tenant.account.id, tenant.organization.id],
        }),
      ]);
    },
  });
  if (!snapshot.ok) return snapshot.element;
  const status = queryState<ConnectionStatus>(
    statusQuery,
    "Connections unavailable",
    <ConnectionsLoading />,
  );
  if (!status.ok) return status.element;
  const data = snapshot.data;
  const connectProvider = (
    provider: ConnectionProviderName,
    linearAgentSessions = false,
  ) => {
    connect.mutate(
      {
        data: {
          ...scope,
          provider,
          ...(provider === "linear" && linearAgentSessions ? { linearAgentSessions: true } : {}),
        },
      },
      {
        onSuccess: (response) => {
          if (response.status === "ok") window.location.assign(response.data.url);
        },
      },
    );
  };
  const rows = connectionRows(data);
  const busy = connect.isPending || disconnect.isPending;
  const connectionActionLabel = (provider: ConnectionProviderName) => {
    if (
      (provider === "slack" || provider === "linear") &&
      status.data[provider].status === "requiresReauthorization"
    ) {
      return "Reauthorize";
    }
    if (
      provider === "github" &&
      rows.some(
        (connection) => connection.provider === "github" && connection.status === "suspended",
      )
    ) {
      return "Reconnect";
    }
    return "Connect";
  };
  const providerAction = (provider: ConnectionProviderName): ReactNode => {
    if (!data.capabilities.manageResources) return undefined;
    // An app nobody has given Hub credentials for cannot be connected from here, and only an
    // instance operator can change that. Everyone else is told nothing about instance
    // credentials: a state they cannot act on is not news, and a card with only a name on it is
    // the page talking about work they cannot do.
    if (status.data[provider].status === "notConfigured") {
      if (!isInstanceOperator) return undefined;
      return (
        <Button variant="outline" size="sm" asChild>
          <Link to={"/apps" as never}>Set up the {providerLabel(provider)} app</Link>
        </Button>
      );
    }
    return (
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          disabled={busy}
          variant="outline"
          size="sm"
          onClick={() => connectProvider(provider)}
        >
          {connectionActionLabel(provider)} {providerLabel(provider)}
        </Button>
        {provider === "linear" ? (
          <Button
            disabled={busy}
            variant="outline"
            size="sm"
            onClick={() => connectProvider(provider, true)}
          >
            Connect for Agent Sessions
          </Button>
        ) : null}
      </div>
    );
  };
  // A provider block that can neither be acted on nor list anything says only its own name.
  // That is every provider for someone who cannot connect one, and four of them is the whole
  // page talking about work the reader cannot do.
  const shown = CONNECTION_PROVIDERS.map((provider) => ({
    provider,
    connections: rows.filter((connection) => connection.provider === provider),
    action: providerAction(provider),
  })).filter((block) => block.action !== undefined || block.connections.length > 0);
  // Whose problem the empty page is: an instance with no provider apps is the operator's, an
  // organization that has connected nothing is its owners'.
  const nothingToConnect = CONNECTION_PROVIDERS.every(
    (provider) => status.data[provider].status === "notConfigured",
  )
    ? "This Hub has no provider apps set up yet. Ask whoever runs it to add one."
    : "An organization owner connects the providers this organization can use.";
  return (
    <>
      <PageHeader title="Connections" description={CONNECTIONS_DESCRIPTION} />
      {returned === undefined ? null : (
        <ConnectionReturnBanner copy={connectionReturnCopy(returned)} />
      )}
      <CommandError mutations={[connect, disconnect]} />
      <Section>
        {shown.length === 0 ? (
          <EmptyState title="No connections" description={nothingToConnect} />
        ) : (
          shown.map(({ provider, connections, action }) => (
            <ProviderConnections
              key={provider}
              provider={provider}
              connections={connections}
              canManage={data.capabilities.manageResources}
              busy={busy}
              action={action}
              onRevoke={(connectionId) =>
                disconnect.mutate({ data: { ...scope, provider, connectionId } })
              }
            />
          ))
        )}
      </Section>
      <Section
        title="Known unrouted events"
        description="Events received for this organization that were not routed to a workflow."
      >
        <ActivityTable activity={data.unroutedEvents} label="Unrouted events" showReason />
      </Section>
    </>
  );
}

/**
 * One integration, top to bottom: what it is, the one way to connect it, and the accounts it is
 * already connected to. A provider with nothing connected is the same card without a list, so
 * the page reads as the same four blocks whatever state the organization is in.
 */
function ProviderConnections({
  provider,
  connections,
  canManage,
  busy,
  action,
  onRevoke,
}: {
  provider: ConnectionProviderName;
  connections: readonly ConnectionRecord[];
  canManage: boolean;
  busy: boolean;
  action: ReactNode;
  onRevoke: (connectionId: string) => void;
}) {
  const label = providerLabel(provider);
  return (
    <Card
      icon={<ProviderGlyph provider={provider} />}
      title={label}
      {...(action === undefined ? {} : { action })}
    >
      {connections.length === 0 ? null : (
        <RecordList label={`${label} connections`}>
          {connections.map((connection) => (
            <RecordRow
              key={connection.id}
              status={
                <StatusPill
                  tone={
                    connection.status === "suspended" ||
                    connection.status === "requiresReauthorization"
                      ? "warning"
                      : "success"
                  }
                >
                  {connectionStatusLabel(connection.status)}
                </StatusPill>
              }
              actions={
                canManage ? (
                  <RowActions label={`Actions for ${connection.name}`}>
                    <ConfirmMenuItem
                      busy={busy}
                      destructive
                      label="Revoke"
                      title={`Revoke ${connection.name}?`}
                      description="Projects using this credential will stop receiving new events."
                      confirmLabel="Revoke connection"
                      cancelLabel="Cancel"
                      onConfirm={() => onRevoke(connection.id)}
                    />
                  </RowActions>
                ) : undefined
              }
            >
              <TwoLine primary={connection.name} secondary={connection.externalId} mono />
            </RecordRow>
          ))}
        </RecordList>
      )}
    </Card>
  );
}

export function OrganizationDaemonsPanel() {
  const tenant = useRouteTenant();
  return (
    <DaemonsPanel
      accountId={tenant.account.id}
      organizationId={tenant.organization.id}
      organizationSlug={tenant.organization.slug}
    />
  );
}

export function ProjectOverviewPanel() {
  const tenant = useRouteTenant();
  const snapshot = useProjectSnapshot();
  if (!snapshot.ok) return snapshot.element;
  const data = snapshot.data;
  const base = `/o/${tenant.organization.slug}/projects/${data.project.slug}`;
  return (
    <>
      <PageHeader
        title="Overview"
        description={`Setup and recent operations for ${data.project.name}.`}
      />
      <Section className="sm:grid-cols-2">
        <SetupCard
          label="Configuration"
          ready={data.configuration.activeRevision !== null}
          detail={
            data.configuration.activeRevision === null
              ? "No active revision"
              : `Revision ${String(data.configuration.activeRevision.version)}`
          }
        />
        <SetupCard
          label="Connections"
          ready={
            data.connections.github.length +
              data.connections.discord.length +
              data.connections.slack.length +
              data.connections.linear.length >
            0
          }
          detail={`${String(data.connections.github.length + data.connections.discord.length + data.connections.slack.length + data.connections.linear.length)} organization connections`}
        />
      </Section>
      <Section
        title="Recent activity"
        action={
          <Button variant="link" asChild>
            <Link to={`${base}/activity` as never}>View all</Link>
          </Button>
        }
      >
        <ActivityTable
          activity={data.activity.slice(0, 5)}
          label="Recent activity"
          detailBasePath={`${base}/activity`}
        />
      </Section>
    </>
  );
}

export function ProjectActivityPanel() {
  const tenant = useRouteTenant();
  const snapshot = useProjectSnapshot();
  if (!snapshot.ok) return snapshot.element;
  return (
    <>
      <PageHeader title="Activity" description="Provider events routed to this project." />
      <ActivityTable
        activity={snapshot.data.activity}
        label="Project activity"
        detailBasePath={`/o/${tenant.organization.slug}/projects/${tenant.project?.slug}/activity`}
      />
    </>
  );
}

type RunActivity = Awaited<ReturnType<ProjectDashboard["activityRunSnapshot"]>>["activity"];

export function ProjectActivityRunPanel({ runId }: { runId: string }) {
  const tenant = useRouteTenant();
  const load = useServerFn(activityRunSnapshot);
  const scope = {
    organizationSlug: tenant.organization.slug,
    projectSlug: tenant.project?.slug ?? "",
    runId,
  };
  const query = useQuery({
    queryKey: ["project-activity-run", tenant.account.id, tenant.organization.id, runId],
    queryFn: () => load({ data: scope }),
  });
  const snapshot = queryState<Awaited<ReturnType<ProjectDashboard["activityRunSnapshot"]>>>(
    query,
    "Run unavailable",
  );
  if (!snapshot.ok) return snapshot.element;
  const activity = snapshot.data.activity;
  return (
    <>
      <PageHeader
        title="Run detail"
        description={`${activity.provider} · ${activity.configuredTriggerName}`}
      />
      <Section title="Invocation">
        <SummaryPanel label="Invocation" rows={invocationRows(activity)} />
      </Section>
      <Section title="Steps" description="Ordered durable step state and structured outputs.">
        <DataTable
          label="Run steps"
          columns={[
            { header: "Step" },
            { header: "Status" },
            { header: "Deadline" },
            { header: "Structured output" },
            { header: "Failure reason" },
          ]}
          isEmpty={activity.steps.length === 0}
          empty={{ title: "No steps" }}
        >
          {activity.steps.map((step) => (
            <DataRow key={step.id}>
              <DataCell>
                <span>
                  {step.ordinal + 1}. {step.stepId}
                </span>
              </DataCell>
              <DataCell>
                <StatusPill tone={executionTone(step.status)}>
                  {statusLabel(step.status)}
                </StatusPill>
              </DataCell>
              <DataCell muted>
                <span className="font-mono text-xs">
                  {step.deadlineAt === null ? "—" : formatAbsolute(step.deadlineAt)}
                  {step.deadlineKind === null ? "" : ` · ${step.deadlineKind}`}
                  {step.idleDeadlineAt === null
                    ? ""
                    : ` · idle ${formatAbsolute(step.idleDeadlineAt)}`}
                </span>
              </DataCell>
              <DataCell>
                <JsonValue value={step.output} />
              </DataCell>
              <DataCell muted>{step.failureReason ?? "—"}</DataCell>
            </DataRow>
          ))}
        </DataTable>
      </Section>
    </>
  );
}

export function ProjectGeneralSettingsPanel() {
  const tenant = useRouteTenant();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const scope = projectScope(tenant);
  const snapshot = useProjectSnapshot();
  const updateSlug = useProjectCommand(updateProjectSlug, queryClient, scope);
  // Archiving deletes the route this panel is standing on: the project stops resolving
  // for every project URL. Leave for the project list before invalidating, or the
  // refetch lands on a project route that can no longer answer.
  const archiveProjectFn = useServerFn(archiveProject);
  const archive = useMutation({
    mutationFn: archiveProjectFn,
    onSuccess: async (result) => {
      if (result.status !== "ok") return;
      await navigate({ to: `/o/${tenant.organization.slug}/projects` as never });
      await invalidateScope(queryClient, scope);
    },
  });
  if (!snapshot.ok) return snapshot.element;
  const data = snapshot.data;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const slug = formString(new FormData(event.currentTarget), "slug");
    updateSlug.mutate(
      { data: { ...scope, slug } },
      {
        onSuccess: (result) => {
          if (result.status === "ok")
            void navigate({
              to: `/o/${tenant.organization.slug}/projects/${slug}/settings` as never,
            });
        },
      },
    );
  };
  return (
    <SettingsPage>
      <CommandError mutations={[updateSlug, archive]} />
      {data.capabilities.manageResources ? (
        <>
          <Section
            title="Project URL"
            description="Changing the slug deliberately breaks old project URLs."
          >
            <form
              aria-label="Change project slug"
              className="grid max-w-md gap-4"
              onSubmit={submit}
            >
              <FormField
                id="project-slug"
                label="Project slug"
                kind="text"
                name="slug"
                defaultValue={data.project.slug}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                required
              />
              <FormActions>
                <Button type="submit">Save slug</Button>
              </FormActions>
            </form>
          </Section>
          <Section title="Archive project">
            <ConfirmAction
              label="Archive project"
              title={`Archive ${data.project.name}?`}
              description="Routing is released; running recovery and history remain."
              confirmLabel="Archive project"
              cancelLabel="Cancel"
              busy={archive.isPending}
              onConfirm={() => archive.mutate({ data: scope })}
            />
          </Section>
        </>
      ) : null}
    </SettingsPage>
  );
}

function SettingsPage({ children }: { children: ReactNode }) {
  const tenant = useRouteTenant();
  if (tenant.project === null) throw new Error("settings route has no project");
  return (
    <>
      <PageHeader title="Settings" description={`Project settings for ${tenant.project.name}.`} />
      {children}
    </>
  );
}

function SetupCard({ label, ready, detail }: { label: string; ready: boolean; detail: string }) {
  return (
    <Card
      title={label}
      action={
        <StatusPill tone={ready ? "success" : "neutral"}>
          {ready ? "Ready" : "Setup needed"}
        </StatusPill>
      }
    >
      <p className="text-sm text-muted-foreground">{detail}</p>
    </Card>
  );
}

/** What one run amounts to, in the order an operator reads it: what was asked, then what happened. */
function invocationRows(activity: RunActivity): readonly SummaryRow[] {
  return [
    { label: "Prompt", value: <CodeBlock label="Prompt">{activity.prompt}</CodeBlock> },
    { label: "Typed inputs", value: <JsonValue value={activity.inputs} /> },
    { label: "Composed routing values", value: <JsonValue value={activity.values} /> },
    {
      label: "Run status",
      value: (
        <StatusPill tone={executionTone(activity.status)}>
          {statusLabel(activity.status)}
        </StatusPill>
      ),
    },
    {
      label: "Run deadline",
      value: (
        <span className="font-mono text-xs">
          {activity.deadlineAt === null ? "—" : formatAbsolute(activity.deadlineAt)}
          {activity.deadlineKind === null ? "" : ` · ${activity.deadlineKind}`}
        </span>
      ),
    },
    { label: "Failure reason", value: activity.failureReason ?? "—" },
    { label: "Delivery", value: <span className="font-mono text-xs">{activity.deliveryId}</span> },
  ];
}

function JsonValue({ value }: { value: unknown }) {
  return <CodeBlock>{JSON.stringify(value, null, 2) ?? "—"}</CodeBlock>;
}

function executionTone(status: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out") return "danger";
  if (status === "dropped") return "warning";
  return "neutral";
}

function ActivityTable({
  activity,
  label,
  detailBasePath,
  showReason = false,
}: {
  activity: ReadonlyArray<
    | ProjectSnapshot["activity"][number]
    | Awaited<ReturnType<ProjectDashboard["organizationSnapshot"]>>["unroutedEvents"][number]
  >;
  label: string;
  detailBasePath?: string;
  showReason?: boolean;
}) {
  return (
    <DataTable
      label={label}
      columns={[
        { header: "Run" },
        { header: "Provider" },
        { header: "Source" },
        { header: "Status" },
        ...(showReason ? [{ header: "Reason" }] : []),
        { header: "Received" },
      ]}
      isEmpty={activity.length === 0}
      empty={{ title: "No activity" }}
    >
      {activity.map((event) => {
        const status = "status" in event ? event.status : "dropped";
        return (
          <DataRow key={event.id}>
            <DataCell>
              <TwoLine
                primary={
                  detailBasePath &&
                  "configuredTriggerName" in event &&
                  event.configuredTriggerName !== null ? (
                    <Button variant="link" asChild>
                      <Link to={`${detailBasePath}/${event.id}` as never}>
                        {event.configuredTriggerName}
                      </Link>
                    </Button>
                  ) : (
                    <span className="font-mono">{event.id.slice(0, 12)}</span>
                  )
                }
                {...(event.repo === null ? {} : { secondary: event.repo })}
              />
            </DataCell>
            <DataCell>{event.provider}</DataCell>
            <DataCell>{event.source}</DataCell>
            <DataCell>
              <StatusPill tone={executionTone(status)}>{statusLabel(status)}</StatusPill>
            </DataCell>
            {showReason ? <DataCell>{event.failureReason ?? "Unknown reason"}</DataCell> : null}
            <DataCell muted>
              <RelativeTime value={event.receivedAt} />
            </DataCell>
          </DataRow>
        );
      })}
    </DataTable>
  );
}

/**
 * What the provider sent the operator back with. A round trip that connected nothing is a failed
 * request — the operator pressed Connect and came back to a page that looks unchanged — so it is
 * reported as one rather than as news. Success is still an announcement. Either way the banner
 * owns the distance to the table below it.
 */
function ConnectionReturnBanner({ copy }: { copy: ConnectionReturnCopy }) {
  if (copy.tone === "error") {
    return (
      <FailureAlert
        standalone
        title={copy.title}
        error={copy.message}
        fallback="Hub couldn't finish the connection. Start it again from this page."
      />
    );
  }
  return (
    <NoticeAlert standalone tone="success">
      {copy.message}
    </NoticeAlert>
  );
}

type ConnectionRecord = ReturnType<typeof connectionRows>[number];

function connectionRows(data: OrganizationSnapshot) {
  return [
    ...data.connections.github.map((connection) => ({
      provider: "github" as const,
      id: connection.id,
      name: connection.slug,
      externalId: `${connection.accountLogin} · installation ${connection.installationId}`,
      status: connection.status,
    })),
    ...data.connections.discord.map((connection) => ({
      provider: "discord" as const,
      id: connection.id,
      name: connection.slug,
      externalId: `guild ${connection.guildId}`,
      status: "connected" as const,
    })),
    ...data.connections.slack.map((connection) => ({
      provider: "slack" as const,
      id: connection.id,
      name: connection.slug,
      externalId: `workspace ${connection.teamId}`,
      status: connection.requiresReauthorization
        ? ("requiresReauthorization" as const)
        : ("connected" as const),
    })),
    ...data.connections.linear.map((connection) => ({
      provider: "linear" as const,
      id: connection.id,
      name: connection.slug,
      externalId: `workspace ${connection.linearOrganizationId}`,
      status: connection.requiresReauthorization
        ? ("requiresReauthorization" as const)
        : ("connected" as const),
    })),
  ];
}
function providerLabel(provider: ConnectionProviderName) {
  if (provider === "github") return "GitHub";
  if (provider === "discord") return "Discord";
  return provider === "slack" ? "Slack" : "Linear";
}

/** The one connection status a sentence-cased machine value gets wrong. */
function connectionStatusLabel(status: string): string {
  return status === "requiresReauthorization" ? "Reauthorization required" : statusLabel(status);
}

function formString(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
