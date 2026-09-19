/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop, typescript-eslint/no-unsafe-type-assertion -- controls are scoped to the rendered project snapshot */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Combobox, type ComboboxOption } from "../../components/app/combobox.js";
import { FailureAlert, NoticeAlert } from "../../components/app/failure-alert.js";
import { FormField } from "../../components/app/form-field.js";
import { LoadingLine } from "../../components/app/loading.js";
import { PageHeader } from "../../components/app/page.js";
import { RelativeTime, formatAbsolute } from "../../components/app/relative-time.js";
import { SegmentedControl, type SegmentedOption } from "../../components/app/segmented-control.js";
import { StatusLine } from "../../components/app/status-line.js";
import { StatusPill } from "../../components/app/status-pill.js";
import { ProviderGlyph } from "../../connections/provider-glyph.js";
import { TwoLine } from "../../components/app/two-line.js";
import { Button } from "../../components/ui/button.js";
import type { Result } from "../../contract/respond.js";
import { cn } from "../../lib/utils.js";
import { useRouteTenant } from "../context.js";
import type { ManualConfigurationSaveResult } from "../dashboard.js";
import {
  availableGitHubRepositories,
  saveManualConfiguration,
  switchConfigurationToManual,
  syncProjectConfiguration,
  useGitHubConfiguration,
} from "../functions.js";
import {
  CommandError,
  projectScope,
  useProjectCommand,
  useProjectSnapshot,
  type ProjectSnapshot,
} from "../panel-state.js";
import { CodeEditor } from "./code-editor.js";
import {
  addPartial,
  addWorkflow,
  configurationDraft,
  documentsOf,
  editSelected,
  isModified,
  PartialPathUnavailable,
  removePartial,
  removeWorkflow,
  selectDocument,
  selectedDocument,
  type ConfigurationDraft,
} from "./draft.js";

type Configuration = ProjectSnapshot["configuration"];

/** A repository this project's connections can read, as the source picker needs it. */
export interface AvailableRepository {
  connectionId: string;
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
}

export function ProjectConfigurationPanel() {
  const tenant = useRouteTenant();
  if (tenant.project === null) throw new Error("configuration route has no project");
  return <ProjectConfigurationScreen key={tenant.project.id} />;
}

function ProjectConfigurationScreen() {
  const tenant = useRouteTenant();
  const queryClient = useQueryClient();
  const scope = projectScope(tenant);
  const snapshot = useProjectSnapshot();
  const sync = useProjectCommand(syncProjectConfiguration, queryClient, scope);
  const manual = useProjectCommand(switchConfigurationToManual, queryClient, scope);
  const save = useProjectCommand<
    Parameters<typeof saveManualConfiguration>[0],
    ManualConfigurationSaveResult
  >(saveManualConfiguration, queryClient, scope);
  const configure = useProjectCommand(useGitHubConfiguration, queryClient, scope);
  const loadRepositories = useServerFn(availableGitHubRepositories);
  const repositories = useQuery({
    queryKey: ["github-repositories", tenant.organization.id, tenant.project?.id],
    queryFn: () => loadRepositories({ data: scope }),
  });
  const [sourceMode, setSourceMode] = useState<"manual" | "github" | null>(null);
  const [stagedRepository, setStagedRepository] = useState<AvailableRepository | null>(null);
  if (!snapshot.ok) return snapshot.element;
  const data = snapshot.data;
  const configuration = data.configuration;
  const mode = sourceMode ?? configuration.authority;
  const selectMode = (next: "manual" | "github") => {
    setSourceMode(next);
    setStagedRepository(null);
    if (next === "manual" && configuration.authority === "github") manual.mutate({ data: scope });
  };
  return (
    <>
      <PageHeader
        title="Configuration"
        description={`Setup and source for ${data.project.name}.`}
      />
      <CommandError mutations={[sync, manual, save, configure]} />
      <ManualConfigurationResult result={save.data} />
      <ConfigurationWorkbench
        key={configuration.activeRevision?.id ?? "none"}
        configuration={configuration}
        editable={data.capabilities.manageResources && configuration.authority === "manual"}
        savePending={save.isPending || manual.isPending}
        onSave={(draft) =>
          save.mutate({
            data: { ...scope, files: [...draft.files] },
          })
        }
        source={
          <ConfigurationSource
            configuration={configuration}
            manageResources={data.capabilities.manageResources}
            mode={mode}
            onSelectMode={selectMode}
            switchToManualPending={manual.isPending}
            repositories={repositories.data?.status === "ok" ? repositories.data.data : []}
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
          />
        }
      />
    </>
  );
}

/**
 * The screen: source and files on the left rail, the open document on the right.
 * Mounted per active revision, so activating one reopens the editor on it and an
 * invalid save leaves the operator's draft untouched.
 */
function ConfigurationWorkbench({
  configuration,
  editable,
  savePending,
  onSave,
  source,
}: {
  configuration: Configuration;
  editable: boolean;
  savePending: boolean;
  onSave: (draft: ConfigurationDraft) => void;
  source: React.ReactNode;
}) {
  const revision = configuration.activeRevision;
  const [baseline] = useState(() => configurationDraft({ files: revision?.files ?? [] }));
  const [draft, setDraft] = useState(baseline);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState<"workflow" | "partial" | null>(null);
  const [pathError, setPathError] = useState<string | null>(null);
  const document = selectedDocument(draft);
  const modified = isModified(draft, baseline);
  const stopEditing = () => {
    setEditing(false);
    setAdding(null);
    setPathError(null);
  };
  return (
    <section
      aria-label="Configuration editor"
      // The workbench is a fixed-height pane: the rail and the document each scroll inside it,
      // so a long configuration never turns the page into two nested scrollbars. The row tracks
      // are bounded like the columns are — an `auto` row would size to the open document and push
      // the editor past the pane, where `overflow-hidden` would clip it with nothing left to
      // scroll. `CodeEditor` fills whatever height it is given.
      className="grid h-160 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border bg-card md:grid-cols-[17rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]"
    >
      <div className="flex flex-col gap-5 overflow-y-auto border-b p-4 md:border-r md:border-b-0">
        {source}
        <RevisionSummary revision={revision} />
        <FileList
          draft={draft}
          editing={editing}
          adding={adding}
          pathError={pathError}
          onSelect={(id) => setDraft(selectDocument(draft, id))}
          onStartAdding={(kind) => {
            setAdding(kind);
            setPathError(null);
          }}
          onAdd={(kind, path) => {
            try {
              setDraft(kind === "workflow" ? addWorkflow(draft, path) : addPartial(draft, path));
              setAdding(null);
              setPathError(null);
            } catch (error) {
              if (!(error instanceof PartialPathUnavailable)) throw error;
              setPathError(error.message);
            }
          }}
          onCancelAdding={() => {
            setAdding(null);
            setPathError(null);
          }}
          onRemove={(path) =>
            setDraft(
              path.endsWith(".yml") ? removeWorkflow(draft, path) : removePartial(draft, path),
            )
          }
        />
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <span className="truncate font-mono text-xs">{document.label}</span>
          <StatusPill tone={editing ? "warning" : "neutral"} dot={false}>
            {editing ? "Editing" : "Read-only"}
          </StatusPill>
          <span className="flex-1" />
          {!editable && configuration.authority === "github" ? (
            <span className="text-xs text-muted-foreground">
              GitHub-managed. Switch the source to Manual to change it here.
            </span>
          ) : null}
          {editable && !editing ? (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
          ) : null}
          {editing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={savePending}
                onClick={() => {
                  setDraft(baseline);
                  stopEditing();
                }}
              >
                Discard
              </Button>
              <Button
                size="sm"
                disabled={savePending}
                aria-busy={savePending}
                onClick={() => onSave(draft)}
              >
                Save and activate
              </Button>
            </>
          ) : null}
        </div>
        <div className="min-h-0 flex-1">
          <CodeEditor
            value={document.content}
            language={document.language}
            readOnly={!editing}
            label={document.isPartial ? document.label : "Configuration YAML"}
            onChange={(content) => setDraft(editSelected(draft, content))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <span>{revisionState(revision)}</span>
          {modified ? (
            <StatusPill tone="warning" dot={false}>
              Unsaved changes
            </StatusPill>
          ) : null}
          <span className="flex-1" />
          <span>{`${String(draft.files.length)} file${draft.files.length === 1 ? "" : "s"}`}</span>
        </div>
      </div>
    </section>
  );
}

function revisionState(revision: Configuration["activeRevision"]): string {
  if (revision === null) return "Not activated";
  return revision.validation === "valid" ? "Valid" : "Invalid";
}

function RevisionSummary({ revision }: { revision: Configuration["activeRevision"] }) {
  return (
    <div className="grid gap-1.5">
      <RailLabel>Active revision</RailLabel>
      {revision === null ? (
        <StatusLine>No active configuration.</StatusLine>
      ) : (
        <div className="rounded-md border px-2.5 py-2">
          <TwoLine
            primary={`Revision ${String(revision.version)}`}
            secondary={
              <>
                {revision.sourceKind === "github" ? "GitHub-managed" : "Manual"} ·{" "}
                <RelativeTime value={revision.createdAt} />
              </>
            }
          />
        </div>
      )}
    </div>
  );
}

function FileList({
  draft,
  editing,
  adding,
  pathError,
  onSelect,
  onStartAdding,
  onAdd,
  onCancelAdding,
  onRemove,
}: {
  draft: ConfigurationDraft;
  editing: boolean;
  adding: "workflow" | "partial" | null;
  pathError: string | null;
  onSelect: (id: string) => void;
  onStartAdding: (kind: "workflow" | "partial") => void;
  onAdd: (kind: "workflow" | "partial", path: string) => void;
  onCancelAdding: () => void;
  onRemove: (path: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        <RailLabel>Files</RailLabel>
        {editing && adding === null ? (
          <span className="flex gap-3">
            <Button type="button" variant="link" onClick={() => onStartAdding("workflow")}>
              Add workflow
            </Button>
            <Button type="button" variant="link" onClick={() => onStartAdding("partial")}>
              Add partial
            </Button>
          </span>
        ) : null}
      </div>
      <ul aria-label="Configuration files" className="grid gap-0.5">
        {documentsOf(draft).map((document) => (
          <li key={document.id} className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              aria-current={document.id === draft.selectedId}
              onClick={() => onSelect(document.id)}
              className={cn(
                "min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left font-mono text-xs",
                document.id === draft.selectedId
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60",
                document.isPartial ? "pl-4" : "",
              )}
            >
              {document.id}
            </button>
            {editing && (document.isPartial || document.isWorkflow) ? (
              <button
                type="button"
                aria-label={`Remove ${document.id}`}
                className="rounded px-1 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(document.id)}
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {adding !== null ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const path = form.get("filePath");
            onAdd(adding, typeof path === "string" ? path : "");
          }}
        >
          <FormField
            id="configuration-file-path"
            label={adding === "workflow" ? "Workflow file name" : "Partial path"}
            kind="text"
            name="filePath"
            placeholder={adding === "workflow" ? "triage.yml" : "triage/preamble.md"}
            {...(pathError === null ? {} : { error: pathError })}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm">
              Add
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancelAdding}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Workflow YAML lives directly under <span className="font-mono">.paseo/workflows/</span>;
        shared prompt files live under <span className="font-mono">partials/</span>. Saving
        activates the complete bundle.
      </p>
    </div>
  );
}

function ConfigurationSource({
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
}: {
  configuration: Configuration;
  manageResources: boolean;
  mode: "manual" | "github";
  onSelectMode: (mode: "manual" | "github") => void;
  switchToManualPending: boolean;
  repositories: AvailableRepository[];
  repositoriesLoading: boolean;
  stagedRepository: AvailableRepository | null;
  onStageRepository: (repository: AvailableRepository) => void;
  onSaveRepository: () => void;
  saveRepositoryPending: boolean;
  onSync: () => void;
  syncPending: boolean;
}) {
  const currentRepository: AvailableRepository | null =
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
      <div className="grid gap-1.5">
        <RailLabel>Source</RailLabel>
        <p className="text-sm">
          {currentRepository === null ? "Manual" : `GitHub · ${currentRepository.fullName}`}
        </p>
      </div>
    );
  }

  const manualUnavailable =
    configuration.authority === "github" && configuration.activeRevision === null;
  const selected = stagedRepository ?? currentRepository;

  return (
    <div className="grid gap-2">
      <RailLabel>Source</RailLabel>
      <SegmentedControl
        label="Configuration source mode"
        value={mode}
        options={
          [
            {
              value: "manual",
              label: "Manual",
              disabled: switchToManualPending || manualUnavailable,
              ...(manualUnavailable
                ? { hint: "Sync a GitHub revision before switching to Manual." }
                : { hint: "Edited in Hub. Saving activates a new revision." }),
            },
            {
              value: "github",
              label: "GitHub",
              icon: GITHUB_GLYPH,
              disabled: switchToManualPending,
            },
          ] satisfies readonly SegmentedOption[]
        }
        onChange={(next) => onSelectMode(next as "manual" | "github")}
      />
      {mode === "github" ? (
        <div className="grid gap-2">
          <Combobox
            id="configuration-repository"
            label="Repository"
            value={selected === null ? "" : repositoryKey(selected)}
            options={repositoryOptions(repositories, selected)}
            onChange={(option) => onStageRepository(option.repository)}
            placeholder="Select repository…"
            loading={repositoriesLoading}
            disabled={saveRepositoryPending}
            empty="No repositories found."
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={stagedRepository === null || saveRepositoryPending}
              aria-busy={saveRepositoryPending}
              onClick={onSaveRepository}
            >
              Save
            </Button>
            {configuration.authority === "github" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={syncPending}
                aria-busy={syncPending}
                onClick={onSync}
              >
                Sync now
              </Button>
            ) : null}
          </div>
          {syncPending ? <LoadingLine>Syncing…</LoadingLine> : null}
          {configuration.authority === "github" ? (
            <StatusLine>
              {configuration.lastSyncAttempt === null
                ? "No synchronization attempt yet."
                : `${syncOutcome(configuration.lastSyncAttempt.outcome)} at ${formatAbsolute(configuration.lastSyncAttempt.createdAt)}${configuration.lastSyncAttempt.commitSha === null ? "" : ` · ${configuration.lastSyncAttempt.commitSha.slice(0, 12)}`}`}
            </StatusLine>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The provider's own mark, not a lucide stand-in: the segment names GitHub, so it wears it. */
const GITHUB_GLYPH = <ProviderGlyph provider="github" />;

interface RepositoryOption extends ComboboxOption {
  repository: AvailableRepository;
}

/** A repository is identified by the connection that can read it, not by its name alone. */
function repositoryKey(repository: AvailableRepository): string {
  return `${repository.connectionId}:${String(repository.repositoryId)}`;
}

/**
 * The repositories on offer, with the one already in use always among them. The list arrives
 * after the page does, and a repository the picker cannot find reads as unavailable — which is
 * right for a repository that has gone away and wrong for one that simply has not loaded yet.
 */
function repositoryOptions(
  repositories: readonly AvailableRepository[],
  selected: AvailableRepository | null,
): readonly RepositoryOption[] {
  const options = repositories.map(
    (repository): RepositoryOption => ({
      value: repositoryKey(repository),
      label: repository.fullName,
      detail: repository.defaultBranch,
      repository,
    }),
  );
  if (selected === null || options.some((option) => option.value === repositoryKey(selected))) {
    return options;
  }
  return [
    {
      value: repositoryKey(selected),
      label: selected.fullName,
      detail: selected.defaultBranch,
      repository: selected,
    },
    ...options,
  ];
}

/**
 * What the last save did. An activation is an announcement — the revision it produced is already
 * on screen below — and a refusal is the one thing the operator has to act on, so it lists every
 * line of YAML that stopped it rather than running them together into one sentence.
 */
function ManualConfigurationResult({
  result,
}: {
  result: Result<ManualConfigurationSaveResult> | undefined;
}) {
  if (result?.status !== "ok") return null;
  if (result.data.outcome === "activated") {
    return (
      // The banner owns the distance to the workbench it sits over; no caller spaces it.
      <div className="mb-6">
        <NoticeAlert tone="success">
          {`Configuration saved and activated as Revision ${String(result.data.revision.version)}.`}
        </NoticeAlert>
      </div>
    );
  }
  return (
    <div className="mb-6">
      <FailureAlert
        title="Configuration couldn't be activated"
        error={null}
        fallback="Correct the YAML and try again. The active revision was not changed."
        details={
          <ul className="grid list-disc gap-1 pl-4">
            {result.data.errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        }
      />
    </div>
  );
}

/** The quiet name above a group of controls in the editor's rail. */
function RailLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

function syncOutcome(outcome: string) {
  if (outcome === "activated") return "Activated";
  if (outcome === "invalid") return "Invalid revision; active revision preserved";
  if (outcome === "superseded") return "Superseded push ignored";
  return "Fetch failed; active revision preserved";
}
