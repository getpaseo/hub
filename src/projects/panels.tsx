/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop, typescript-eslint/no-unsafe-type-assertion -- route links and mutation controls are intentionally scoped to each rendered tenant snapshot */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { CONNECTION_MUTATION_KEY } from "../auth/tenant-mutation.js";
import { ConfirmAction, ConfirmMenuItem } from "../components/app/confirm-action.js";
import { DataCell, DataRow, DataTable, type DataColumn } from "../components/app/data-table.js";
import { PageHeader } from "../components/app/page.js";
import { RowActions } from "../components/app/row-actions.js";
import { Section } from "../components/app/section.js";
import { StatusPill } from "../components/app/status-pill.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import { cn } from "../lib/utils.js";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { DaemonsPanel } from "../daemons/account-daemons.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Field, FieldLabel } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.js";
import { Skeleton } from "../components/ui/skeleton.js";
import type { Result } from "../contract/respond.js";
import {
  connectionStatus,
  disconnectConnection,
  startConnection,
  type ConnectionDisconnectResult,
  type ConnectionStatus,
} from "../connections/functions.js";
import {
  EventRow,
  ExecutionDetailSheet,
  ExecutionRow,
  outcomeKey,
  TriggerDetailSheet,
  type ExecutionItem,
  type OutcomeKey,
  type TriggerItem,
} from "./activity-rows.js";
import { useRouteTenant } from "./context.js";
import type { ProjectDashboard } from "./dashboard.js";
import { RepositoryCombobox, type ComboboxRepository } from "./repository-combobox.js";
import {
  archiveProject,
  availableGitHubRepositories,
  createProject,
  organizationSnapshot,
  projectSnapshot,
  saveManualConfiguration,
  switchConfigurationToManual,
  syncProjectConfiguration,
  updateProjectSlug,
  useGitHubConfiguration,
} from "./functions.js";

type OrganizationSnapshot = Awaited<ReturnType<ProjectDashboard["organizationSnapshot"]>>;
type ProjectSnapshot = Awaited<ReturnType<ProjectDashboard["projectSnapshot"]>>;
type CommandResult = Result<{ state: "complete" }>;

export function ProjectsPanel() {
  const tenant = useRouteTenant();
  const queryClient = useQueryClient();
  const scope = { organizationSlug: tenant.organization.slug };
  const snapshot = useOrganizationSnapshot();
  const [connectionResult] = useState(consumeConnectionResult);
  const [creating, setCreating] = useState(false);
  const create = useProjectCommand(createProject, queryClient, scope);
  const archive = useProjectCommand(archiveProject, queryClient, scope);
  if (!snapshot.ok) return snapshot.element;
  const data = snapshot.data;
  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      data: {
        ...scope,
        name: formString(form, "name"),
        slug: formString(form, "slug"),
      },
    });
    setCreating(false);
  };
  return (
    <>
      <PageHeader
        title="Projects"
        description={`Operational boundaries in ${data.organization.name}.`}
      >
        {data.capabilities.manageResources ? (
          <Button onClick={() => setCreating(true)}>New project</Button>
        ) : null}
      </PageHeader>
      {connectionResult === undefined ? null : (
        <Alert role="status" className="mb-6">
          <AlertDescription>{connectionResultCopy(connectionResult)}</AlertDescription>
        </Alert>
      )}
      <CommandError mutations={[create, archive]} />
      <DataTable
        label="Projects"
        columns={[
          { header: "Project" },
          { header: "Status" },
          { header: "Created" },
          { header: "" },
        ]}
        isEmpty={data.projects.length === 0}
        empty={{ title: "No projects" }}
      >
        {data.projects.map((project) => (
          <DataRow key={project.id}>
            <DataCell>
              {project.status === "active" ? (
                <Link
                  className="font-medium hover:underline"
                  to={`/o/${data.organization.slug}/projects/${project.slug}/overview` as never}
                >
                  {project.name}
                </Link>
              ) : (
                <span className="font-medium">{project.name}</span>
              )}
              <span className="block font-mono text-xs text-muted-foreground">{project.slug}</span>
            </DataCell>
            <DataCell>
              <StatusPill tone={project.status === "active" ? "success" : "neutral"}>
                {project.status === "active" ? "Active" : "Archived"}
              </StatusPill>
            </DataCell>
            <DataCell muted>{formatDate(project.createdAt)}</DataCell>
            <DataCell align="end">
              {data.capabilities.manageResources && project.status === "active" ? (
                <RowActions label={`Actions for ${project.name}`}>
                  <ConfirmMenuItem
                    destructive
                    label="Archive"
                    title={`Archive ${project.name}?`}
                    description="Routing is released. History remains available from this list."
                    confirmLabel="Archive project"
                    cancelLabel="Cancel"
                    onConfirm={() =>
                      archive.mutate({ data: { ...scope, projectSlug: project.slug } })
                    }
                  />
                </RowActions>
              ) : null}
            </DataCell>
          </DataRow>
        ))}
      </DataTable>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
          </DialogHeader>
          <form aria-label="Create project" className="grid gap-5" onSubmit={submitCreate}>
            <LabeledInput label="Project name" name="name" required />
            <LabeledInput
              label="Project slug"
              name="slug"
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              required
            />
            <DialogFooter>
              <Button type="submit">Create project</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function OrganizationConnectionsPanel() {
  const tenant = useRouteTenant();
  const queryClient = useQueryClient();
  const scope = { organizationSlug: tenant.organization.slug };
  const snapshot = useOrganizationSnapshot();
  const loadStatus = useServerFn(connectionStatus);
  const statusQuery = useQuery({
    queryKey: ["connection-status", tenant.account.id, tenant.organization.id],
    queryFn: () => loadStatus({ data: scope }),
  });
  const [result, setResult] = useState(consumeConnectionResult);
  const [selectedTrigger, setSelectedTrigger] = useState<TriggerItem>();
  const connect = useMutation({
    mutationKey: CONNECTION_MUTATION_KEY,
    mutationFn: useServerFn(startConnection),
  });
  const disconnect = useMutation({
    mutationKey: CONNECTION_MUTATION_KEY,
    mutationFn: useServerFn(disconnectConnection) as (
      input: Parameters<typeof disconnectConnection>[0],
    ) => Promise<Result<{ result: ConnectionDisconnectResult }>>,
    onSuccess: async (response) => {
      if (response.status !== "ok") return;
      setResult(response.data.result);
      await Promise.all([
        invalidateOrganization(queryClient, scope.organizationSlug),
        queryClient.invalidateQueries({
          queryKey: ["connection-status", tenant.account.id, tenant.organization.id],
        }),
      ]);
    },
  });
  if (!snapshot.ok) return snapshot.element;
  const status = queryState<ConnectionStatus>(statusQuery, "Connections unavailable");
  if (!status.ok) return status.element;
  const data = snapshot.data;
  const connectProvider = (provider: "github" | "discord" | "slack") => {
    connect.mutate(
      { data: { ...scope, provider } },
      {
        onSuccess: (response) => {
          if (response.status === "ok") window.location.assign(response.data.url);
        },
      },
    );
  };
  const rows = connectionRows(data);
  const busy = connect.isPending || disconnect.isPending;
  const connectionActionLabel = (provider: "github" | "discord" | "slack") => {
    if (provider === "slack" && status.data.slack.status === "requiresReauthorization") {
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
  return (
    <>
      <PageHeader title="Connections" description="Organization provider connections." />
      {result === undefined ? null : (
        <Alert role="status" className="mb-6">
          <AlertDescription>{connectionResultCopy(result)}</AlertDescription>
        </Alert>
      )}
      <CommandError mutations={[connect, disconnect]} />
      <Section title="Connections">
        <DataTable
          label="Connections"
          columns={[
            { header: "Connection" },
            { header: "Provider" },
            { header: "Status" },
            { header: "" },
          ]}
          isEmpty={rows.length === 0}
          empty={{ title: "No connections" }}
        >
          {rows.map((connection) => (
            <DataRow key={`${connection.provider}-${connection.id}`}>
              <DataCell>
                <span className="font-medium">{connection.name}</span>
                <span className="block font-mono text-xs text-muted-foreground">
                  {connection.externalId}
                </span>
              </DataCell>
              <DataCell>
                <span className="inline-flex items-center gap-1.5">
                  <ProviderGlyph provider={connection.provider} />
                  {providerLabel(connection.provider)}
                </span>
              </DataCell>
              <DataCell>
                <StatusPill
                  tone={
                    connection.status === "suspended" ||
                    connection.status === "requiresReauthorization"
                      ? "warning"
                      : "success"
                  }
                >
                  {statusLabel(connection.status)}
                </StatusPill>
              </DataCell>
              <DataCell align="end">
                {data.capabilities.manageResources ? (
                  <RowActions label={`Actions for ${connection.name}`}>
                    <ConfirmMenuItem
                      busy={busy}
                      destructive
                      label="Revoke"
                      title={`Revoke ${connection.name}?`}
                      description="Projects using this credential will stop receiving new events."
                      confirmLabel="Revoke connection"
                      cancelLabel="Cancel"
                      onConfirm={() =>
                        disconnect.mutate({
                          data: {
                            ...scope,
                            provider: connection.provider,
                            connectionId: connection.id,
                          },
                        })
                      }
                    />
                  </RowActions>
                ) : null}
              </DataCell>
            </DataRow>
          ))}
        </DataTable>
        {data.capabilities.manageResources ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {(["github", "discord", "slack"] as const).map((provider) => (
              <div
                key={provider}
                className="flex items-center justify-between gap-2 rounded-md border p-3"
              >
                <span className="inline-flex items-center gap-2 text-sm font-medium">
                  <ProviderGlyph provider={provider} />
                  {providerLabel(provider)}
                </span>
                {status.data[provider].status === "notConfigured" ? (
                  <StatusPill tone="neutral">Not configured</StatusPill>
                ) : (
                  <Button
                    disabled={busy}
                    variant="outline"
                    onClick={() => connectProvider(provider)}
                  >
                    {connectionActionLabel(provider)} {providerLabel(provider)}
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </Section>
      <Section
        title="Known unrouted events"
        description="Events whose credential belongs to this organization but no project route was available."
      >
        <ActivityTable
          activity={data.unroutedEvents}
          label="Unrouted events"
          onSelect={setSelectedTrigger}
        />
      </Section>
      <TriggerDetailSheet
        trigger={selectedTrigger}
        onOpenChange={(open) => {
          if (!open) setSelectedTrigger(undefined);
        }}
      />
    </>
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
  const [selectedTrigger, setSelectedTrigger] = useState<TriggerItem>();
  const [selectedExecution, setSelectedExecution] = useState<ExecutionItem>();
  if (!snapshot.ok) return snapshot.element;
  const data = snapshot.data;
  const base = `/o/${tenant.organization.slug}/projects/${data.project.slug}`;
  const scope = { organizationSlug: tenant.organization.slug, projectSlug: data.project.slug };
  return (
    <>
      <PageHeader
        title="Overview"
        description={`Setup and recent operations for ${data.project.name}.`}
      />
      <div className="mb-8 grid gap-3 sm:grid-cols-2">
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
              data.connections.slack.length >
            0
          }
          detail={`${String(data.connections.github.length + data.connections.discord.length + data.connections.slack.length)} organization connections`}
        />
      </div>
      <Section
        title="Recent activity"
        action={
          <Link className="text-sm hover:underline" to={`${base}/activity` as never}>
            View all
          </Link>
        }
      >
        <ActivityTable
          activity={data.activity.slice(0, 5)}
          label="Recent activity"
          onSelect={setSelectedTrigger}
        />
      </Section>
      <Section
        title="Recent executions"
        action={
          <Link className="text-sm hover:underline" to={`${base}/executions` as never}>
            View all
          </Link>
        }
      >
        <ExecutionTable
          executions={data.executions.slice(0, 5)}
          activity={data.activity}
          label="Recent executions"
          onSelect={setSelectedExecution}
          onSelectTrigger={setSelectedTrigger}
        />
      </Section>
      <TriggerDetailSheet
        trigger={selectedTrigger}
        scope={scope}
        onOpenChange={(open) => {
          if (!open) setSelectedTrigger(undefined);
        }}
      />
      <ExecutionDetailSheet
        execution={selectedExecution}
        scope={scope}
        onOpenChange={(open) => {
          if (!open) setSelectedExecution(undefined);
        }}
      />
    </>
  );
}

export function ProjectConfigurationPanel() {
  const tenant = useRouteTenant();
  const queryClient = useQueryClient();
  const scope = projectScope(tenant);
  const snapshot = useProjectSnapshot();
  const sync = useProjectCommand(syncProjectConfiguration, queryClient, scope);
  const manual = useProjectCommand(switchConfigurationToManual, queryClient, scope);
  const save = useProjectCommand(saveManualConfiguration, queryClient, scope);
  const configure = useProjectCommand(useGitHubConfiguration, queryClient, scope);
  const loadRepositories = useServerFn(availableGitHubRepositories);
  const repositories = useQuery({
    queryKey: ["github-repositories", tenant.organization.id, tenant.project?.id],
    queryFn: () => loadRepositories({ data: scope }),
  });
  const [sourceMode, setSourceMode] = useState<"manual" | "github" | null>(null);
  const [stagedRepository, setStagedRepository] = useState<ComboboxRepository | null>(null);
  if (!snapshot.ok) return snapshot.element;
  const data = snapshot.data;
  const configuration = data.configuration;
  const mode = sourceMode ?? configuration.authority;
  const selectMode = (next: "manual" | "github") => {
    setSourceMode(next);
    setStagedRepository(null);
    if (next === "manual" && configuration.authority === "github") {
      manual.mutate({ data: scope });
    }
  };
  const submitManual = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate({
      data: { ...scope, rawYaml: formString(new FormData(event.currentTarget), "rawYaml") },
    });
  };
  const availableRepositories = repositories.data?.status === "ok" ? repositories.data.data : [];
  return (
    <>
      <PageHeader
        title="Configuration"
        description={`Setup and source for ${data.project.name}.`}
      />
      <CommandError mutations={[sync, manual, save, configure]} />
      <Section title="Active revision">
        <div className="rounded-lg border bg-card p-5">
          {configuration.activeRevision === null ? (
            <p role="status">No active configuration.</p>
          ) : (
            <div className="grid gap-2">
              <p className="font-medium">Revision {configuration.activeRevision.version}</p>
              <p className="text-sm text-muted-foreground">
                {configuration.activeRevision.sourceKind === "github" ? "GitHub-managed" : "Manual"}{" "}
                · {formatDate(configuration.activeRevision.createdAt)}
              </p>
              {configuration.activeRevision.rawYaml === null ? null : (
                <pre className="max-h-72 overflow-auto rounded-md bg-muted p-4 text-xs">
                  {configuration.activeRevision.rawYaml}
                </pre>
              )}
            </div>
          )}
        </div>
      </Section>
      <ConfigurationSourceSection
        configuration={configuration}
        manageResources={data.capabilities.manageResources}
        mode={mode}
        onSelectMode={selectMode}
        switchToManualPending={manual.isPending}
        repositories={availableRepositories}
        repositoriesLoading={repositories.isPending}
        stagedRepository={stagedRepository}
        onStageRepository={setStagedRepository}
        onSaveRepository={() => {
          if (stagedRepository === null) return;
          configure.mutate(
            {
              data: {
                ...scope,
                connectionId: stagedRepository.connectionId,
                repositoryId: stagedRepository.repositoryId,
              },
            },
            { onSuccess: () => setStagedRepository(null) },
          );
        }}
        saveRepositoryPending={configure.isPending}
        onSync={() => sync.mutate({ data: scope })}
        syncPending={sync.isPending}
        onSubmitManual={submitManual}
        saveManualPending={save.isPending}
      />
    </>
  );
}

function ConfigurationSourceSection({
  configuration,
  manageResources,
  mode,
  onSelectMode,
  switchToManualPending,
  repositories,
  repositoriesLoading,
  stagedRepository,
  onStageRepository,
  onSaveRepository,
  saveRepositoryPending,
  onSync,
  syncPending,
  onSubmitManual,
  saveManualPending,
}: {
  configuration: ProjectSnapshot["configuration"];
  manageResources: boolean;
  mode: "manual" | "github";
  onSelectMode: (mode: "manual" | "github") => void;
  switchToManualPending: boolean;
  repositories: ComboboxRepository[];
  repositoriesLoading: boolean;
  stagedRepository: ComboboxRepository | null;
  onStageRepository: (repository: ComboboxRepository) => void;
  onSaveRepository: () => void;
  saveRepositoryPending: boolean;
  onSync: () => void;
  syncPending: boolean;
  onSubmitManual: (event: FormEvent<HTMLFormElement>) => void;
  saveManualPending: boolean;
}) {
  const currentRepository: ComboboxRepository | null =
    configuration.sourceState.kind === "github"
      ? {
          connectionId: configuration.sourceState.githubConnectionId,
          repositoryId: configuration.sourceState.githubRepositoryId,
          fullName: configuration.sourceState.githubRepositoryFullName,
          defaultBranch: configuration.sourceState.githubDefaultBranch,
        }
      : null;

  if (!manageResources) {
    return (
      <Section title="Configuration source">
        <p className="rounded-lg border bg-card p-5 text-sm text-muted-foreground">
          {currentRepository === null ? "Manual" : `GitHub · ${currentRepository.fullName}`}
        </p>
      </Section>
    );
  }

  const manualUnavailable =
    configuration.authority === "github" && configuration.activeRevision === null;

  return (
    <Section
      title="Configuration source"
      description="Where this project's configuration comes from."
    >
      <div
        role="radiogroup"
        aria-label="Configuration source mode"
        className="inline-flex w-fit gap-1 rounded-md border bg-muted p-1"
      >
        <SourceModeButton
          active={mode === "manual"}
          disabled={switchToManualPending || manualUnavailable}
          title={
            manualUnavailable ? "Sync a GitHub revision before switching to manual." : undefined
          }
          onClick={() => onSelectMode("manual")}
        >
          Manual
        </SourceModeButton>
        <SourceModeButton
          active={mode === "github"}
          disabled={switchToManualPending}
          onClick={() => onSelectMode("github")}
        >
          <ProviderGlyph provider="github" />
          GitHub
        </SourceModeButton>
      </div>
      {mode === "github" ? (
        <div className="grid gap-3 rounded-lg border bg-card p-5">
          <div className="flex flex-wrap items-center gap-2">
            <RepositoryCombobox
              repositories={repositories}
              loading={repositoriesLoading}
              selected={stagedRepository ?? currentRepository}
              placeholder="Select repository…"
              disabled={saveRepositoryPending}
              onSelect={onStageRepository}
            />
            <Button
              disabled={stagedRepository === null || saveRepositoryPending}
              aria-busy={saveRepositoryPending}
              onClick={onSaveRepository}
            >
              Save
            </Button>
            {configuration.authority === "github" ? (
              <Button
                variant="outline"
                disabled={syncPending}
                aria-busy={syncPending}
                onClick={onSync}
              >
                {syncPending ? "Syncing…" : "Sync now"}
              </Button>
            ) : null}
          </div>
          {configuration.authority === "github" ? (
            <p role="status" className="text-sm text-muted-foreground">
              {configuration.lastSyncAttempt === null
                ? "No synchronization attempt yet."
                : `${syncOutcome(configuration.lastSyncAttempt.outcome)} at ${formatDate(configuration.lastSyncAttempt.createdAt)}${configuration.lastSyncAttempt.commitSha === null ? "" : ` · ${configuration.lastSyncAttempt.commitSha.slice(0, 12)}`}`}
            </p>
          ) : null}
        </div>
      ) : (
        <form aria-label="Manual configuration" className="grid gap-3" onSubmit={onSubmitManual}>
          <label className="text-sm font-medium" htmlFor="manual-configuration">
            Configuration YAML
          </label>
          <textarea
            id="manual-configuration"
            name="rawYaml"
            className="min-h-72 rounded-md border bg-background p-3 font-mono text-xs"
            defaultValue={
              configuration.activeRevision?.rawYaml ?? "environments: []\ntriggers: []\n"
            }
          />
          <div>
            <Button
              type="submit"
              disabled={saveManualPending || switchToManualPending}
              aria-busy={saveManualPending || switchToManualPending}
            >
              Save and activate
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}

function SourceModeButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  title?: string | undefined;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        active
          ? "bg-background text-foreground shadow-xs"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

const ACTIVITY_SOURCE_OPTIONS: readonly {
  value: "all" | TriggerItem["summary"]["provider"];
  label: string;
}[] = [
  { value: "all", label: "All sources" },
  { value: "github", label: "GitHub" },
  { value: "slack", label: "Slack" },
  { value: "discord", label: "Discord" },
  { value: "manual", label: "Manual" },
];

const ACTIVITY_OUTCOME_OPTIONS: readonly { value: "all" | OutcomeKey; label: string }[] = [
  { value: "all", label: "All outcomes" },
  { value: "accepted", label: "Accepted" },
  { value: "dropped", label: "Dropped" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
];

export function ProjectActivityPanel() {
  const tenant = useRouteTenant();
  const scope = projectScope(tenant);
  const snapshot = useProjectSnapshot();
  const [selectedTrigger, setSelectedTrigger] = useState<TriggerItem>();
  const [source, setSource] = useState<"all" | TriggerItem["summary"]["provider"]>("all");
  const [outcome, setOutcome] = useState<"all" | OutcomeKey>("all");
  if (!snapshot.ok) return snapshot.element;
  const activity = snapshot.data.activity.filter(
    (event) =>
      (source === "all" || event.summary.provider === source) &&
      (outcome === "all" || outcomeKey(event) === outcome),
  );
  return (
    <>
      <PageHeader title="Activity" description="Provider events routed to this project." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={source} onValueChange={(value) => setSource(value as typeof source)}>
          <SelectTrigger size="sm" aria-label="Filter activity by source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTIVITY_SOURCE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={outcome} onValueChange={(value) => setOutcome(value as typeof outcome)}>
          <SelectTrigger size="sm" aria-label="Filter activity by outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTIVITY_OUTCOME_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ActivityTable activity={activity} label="Project activity" onSelect={setSelectedTrigger} />
      <TriggerDetailSheet
        trigger={selectedTrigger}
        scope={scope}
        onOpenChange={(open) => {
          if (!open) setSelectedTrigger(undefined);
        }}
      />
    </>
  );
}

const EXECUTION_STATUS_OPTIONS: readonly {
  value: "all" | ExecutionItem["status"];
  label: string;
}[] = [
  { value: "all", label: "All statuses" },
  { value: "spawning", label: "Spawning" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
];

export function ProjectExecutionsPanel() {
  const tenant = useRouteTenant();
  const scope = projectScope(tenant);
  const snapshot = useProjectSnapshot();
  const [selectedExecution, setSelectedExecution] = useState<ExecutionItem>();
  const [selectedTrigger, setSelectedTrigger] = useState<TriggerItem>();
  const [status, setStatus] = useState<"all" | ExecutionItem["status"]>("all");
  if (!snapshot.ok) return snapshot.element;
  const executions = snapshot.data.executions.filter(
    (execution) => status === "all" || execution.status === status,
  );
  return (
    <>
      <PageHeader title="Executions" description="Durable executions owned by this project." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
          <SelectTrigger size="sm" aria-label="Filter executions by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXECUTION_STATUS_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ExecutionTable
        executions={executions}
        activity={snapshot.data.activity}
        label="Project executions"
        onSelect={setSelectedExecution}
        onSelectTrigger={setSelectedTrigger}
      />
      <ExecutionDetailSheet
        execution={selectedExecution}
        scope={scope}
        onOpenChange={(open) => {
          if (!open) setSelectedExecution(undefined);
        }}
      />
      <TriggerDetailSheet
        trigger={selectedTrigger}
        scope={scope}
        onOpenChange={(open) => {
          if (!open) setSelectedTrigger(undefined);
        }}
      />
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
  const archive = useProjectCommand(archiveProject, queryClient, scope);
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
              to: `/o/${tenant.organization.slug}/projects/${slug}/settings/general` as never,
            });
        },
      },
    );
  };
  return (
    <SettingsPage title="General">
      <CommandError mutations={[updateSlug, archive]} />
      {data.capabilities.manageResources ? (
        <>
          <Section
            title="Project URL"
            description="Changing the slug deliberately breaks old project URLs."
          >
            <form
              aria-label="Change project slug"
              className="flex max-w-md items-end gap-2"
              onSubmit={submit}
            >
              <LabeledInput
                label="Project slug"
                name="slug"
                defaultValue={data.project.slug}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                required
              />
              <Button type="submit">Save slug</Button>
            </form>
          </Section>
          <Section title="Archive project">
            <ConfirmAction
              label="Archive project"
              title={`Archive ${data.project.name}?`}
              description="Routing is released; running recovery and history remain."
              confirmLabel="Archive project"
              cancelLabel="Cancel"
              onConfirm={() =>
                archive.mutate(
                  { data: scope },
                  {
                    onSuccess: (result) => {
                      if (result.status === "ok")
                        void navigate({ to: `/o/${tenant.organization.slug}/projects` as never });
                    },
                  },
                )
              }
            />
          </Section>
        </>
      ) : null}
    </SettingsPage>
  );
}

function useOrganizationSnapshot() {
  const tenant = useRouteTenant();
  const load = useServerFn(organizationSnapshot);
  const query = useQuery({
    queryKey: ["organization", tenant.account.id, tenant.organization.id],
    queryFn: () => load({ data: { organizationSlug: tenant.organization.slug } }),
  });
  return queryState<OrganizationSnapshot>(query, "Organization unavailable");
}

function useProjectSnapshot() {
  const tenant = useRouteTenant();
  const load = useServerFn(projectSnapshot);
  const scope = projectScope(tenant);
  const query = useQuery({
    queryKey: ["project", tenant.account.id, tenant.organization.id, tenant.project?.id],
    queryFn: () => load({ data: scope }),
  });
  return queryState<ProjectSnapshot>(query, "Project unavailable");
}

function queryState<T>(
  query: { isPending: boolean; isError: boolean; data: Result<T> | undefined },
  title: string,
): { ok: true; data: T } | { ok: false; element: ReactNode } {
  if (query.isPending)
    return {
      ok: false,
      element: (
        <section
          aria-label={`Loading ${title.toLowerCase()}`}
          aria-busy="true"
          className="grid gap-5"
        >
          <Skeleton className="h-12 w-64" />
          <Skeleton className="h-72 w-full" />
        </section>
      ),
    };
  if (query.isError || query.data?.status !== "ok")
    return {
      ok: false,
      element: (
        <Alert variant="destructive">
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>
            {query.data?.status === "error" ? query.data.error.message : `${title}.`}
          </AlertDescription>
        </Alert>
      ),
    };
  return { ok: true, data: query.data.data };
}

function useProjectCommand<TInput>(
  command: (input: TInput) => Promise<CommandResult>,
  queryClient: ReturnType<typeof useQueryClient>,
  scope: { organizationSlug: string; projectSlug?: string },
) {
  return useMutation({
    mutationFn: useServerFn(command as never) as unknown as (
      input: TInput,
    ) => Promise<CommandResult>,
    onSuccess: async (result) => {
      if (result.status === "ok") await invalidateScope(queryClient, scope);
    },
  });
}

function CommandError({
  mutations,
}: {
  mutations: Array<{ data: Result<unknown> | undefined; isError: boolean }>;
}) {
  const failed = mutations.find(
    (mutation) => mutation.isError || mutation.data?.status === "error",
  );
  if (failed === undefined) return null;
  return (
    <Alert variant="destructive" className="mb-5">
      <AlertDescription>
        {failed.data?.status === "error"
          ? failed.data.error.message
          : "We couldn't complete that action."}
      </AlertDescription>
    </Alert>
  );
}

async function invalidateScope(
  queryClient: ReturnType<typeof useQueryClient>,
  scope: { organizationSlug: string; projectSlug?: string },
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["organization"] }),
    queryClient.invalidateQueries({ queryKey: ["project"] }),
    queryClient.invalidateQueries({ queryKey: ["tenant", scope.organizationSlug] }),
  ]);
}

async function invalidateOrganization(
  queryClient: ReturnType<typeof useQueryClient>,
  organizationSlug: string,
) {
  await invalidateScope(queryClient, { organizationSlug });
}

function projectScope(tenant: ReturnType<typeof useRouteTenant>) {
  if (tenant.project === null) throw new Error("project route has no project context");
  return { organizationSlug: tenant.organization.slug, projectSlug: tenant.project.slug };
}

function SettingsPage({ title, children }: { title: string; children: ReactNode }) {
  const tenant = useRouteTenant();
  if (tenant.project === null) throw new Error("settings route has no project");
  const base = `/o/${tenant.organization.slug}/projects/${tenant.project.slug}/settings`;
  return (
    <>
      <PageHeader title={title} description={`Project settings for ${tenant.project.name}.`} />
      <nav aria-label="Project settings" className="mb-6 flex flex-wrap gap-2 border-b pb-3">
        <Link className="text-sm hover:underline" to={`${base}/general` as never}>
          General
        </Link>
      </nav>
      {children}
    </>
  );
}

function SetupCard({ label, ready, detail }: { label: string; ready: boolean; detail: string }) {
  return (
    <section aria-label={label} className="rounded-lg border bg-card p-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium">{label}</h2>
        <StatusPill tone={ready ? "success" : "neutral"}>
          {ready ? "Ready" : "Setup needed"}
        </StatusPill>
      </div>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </section>
  );
}

const ACTIVITY_COLUMNS: readonly DataColumn[] = [
  { header: "Event" },
  { header: "Outcome" },
  { header: "Received", align: "end" },
];

function ActivityTable({
  activity,
  label,
  onSelect,
}: {
  activity: readonly TriggerItem[];
  label: string;
  onSelect: (event: TriggerItem) => void;
}) {
  return (
    <DataTable
      label={label}
      columns={ACTIVITY_COLUMNS}
      isEmpty={activity.length === 0}
      empty={{ title: "No activity" }}
    >
      {activity.map((event) => (
        <EventRow key={event.id} event={event} onSelect={() => onSelect(event)} />
      ))}
    </DataTable>
  );
}

const EXECUTION_COLUMNS: readonly DataColumn[] = [
  { header: "Run" },
  { header: "Status" },
  { header: "Daemon" },
  { header: "Started", align: "end" },
];

function ExecutionTable({
  executions,
  activity,
  label,
  onSelect,
  onSelectTrigger,
}: {
  executions: readonly ExecutionItem[];
  activity: readonly TriggerItem[];
  label: string;
  onSelect: (execution: ExecutionItem) => void;
  onSelectTrigger: (trigger: TriggerItem) => void;
}) {
  const activityById = useMemo(
    () => new Map(activity.map((event) => [event.id, event])),
    [activity],
  );
  return (
    <DataTable
      label={label}
      columns={EXECUTION_COLUMNS}
      isEmpty={executions.length === 0}
      empty={{ title: "No executions" }}
    >
      {executions.map((execution) => {
        const trigger =
          execution.triggerId === null ? undefined : activityById.get(execution.triggerId);
        return (
          <ExecutionRow
            key={execution.id}
            execution={execution}
            trigger={trigger}
            onSelect={() => onSelect(execution)}
            {...(trigger === undefined ? {} : { onSelectTrigger: () => onSelectTrigger(trigger) })}
          />
        );
      })}
    </DataTable>
  );
}

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
  ];
}
function providerLabel(provider: "github" | "discord" | "slack") {
  if (provider === "github") return "GitHub";
  if (provider === "discord") return "Discord";
  return "Slack";
}

function consumeConnectionResult(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const url = new URL(window.location.href);
  const result = url.searchParams.get("result") ?? undefined;
  if (url.searchParams.has("result")) {
    url.searchParams.delete("result");
    window.history.replaceState(window.history.state, "", url);
  }
  return result;
}

function connectionResultCopy(result: string): string {
  if (result === "github_connected") return "GitHub connected.";
  if (result === "discord_connected") return "Discord connected.";
  if (result === "slack_connected") return "Slack connected.";
  if (result === "github_disconnected") return "GitHub disconnected.";
  if (result === "discord_disconnected") return "Discord disconnected.";
  if (result === "slack_disconnected") return "Slack disconnected.";
  if (result === "github_approval_required") {
    return "GitHub owner approval is required. Retry after approval.";
  }
  if (result === "provider_not_configured") return "The provider is not configured.";
  return "The connection could not be completed.";
}

function statusLabel(status: string): string {
  if (status === "requiresReauthorization") return "Reauthorization required";
  return status.charAt(0).toUpperCase() + status.slice(1);
}
function syncOutcome(outcome: string) {
  if (outcome === "activated") return "Activated";
  if (outcome === "invalid") return "Invalid revision; active revision preserved";
  if (outcome === "superseded") return "Superseded push ignored";
  return "Fetch failed; active revision preserved";
}
function formString(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function LabeledInput({
  label,
  name,
  ...props
}: { label: string; name: string } & Omit<React.ComponentProps<typeof Input>, "name">) {
  const id = `field-${name}`;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} name={name} {...props} />
    </Field>
  );
}
