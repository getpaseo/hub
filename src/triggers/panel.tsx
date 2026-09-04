/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- focused trigger screens bind one document, and a row's link, timestamp, and action are that row's own slots */
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- generated routes cannot express server-resolved organization URLs */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, Braces, FileText, LockKeyhole, Plus } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Card } from "../components/app/card.js";
import { Combobox, type ComboboxOption } from "../components/app/combobox.js";
import { CheckboxField } from "../components/app/checkbox-field.js";
import { CopyButton } from "../components/app/copy-field.js";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { Disclosure } from "../components/app/disclosure.js";
import { FailureAlert, WarningAlert } from "../components/app/failure-alert.js";
import { FormActions } from "../components/app/form-actions.js";
import { FieldSkeleton, FormField } from "../components/app/form-field.js";
import { LoadingLine, Spinner } from "../components/app/loading.js";
import { PageHeader, PageHeaderSkeleton } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Steps } from "../components/app/steps.js";
import { SegmentedControl, type SegmentedOption } from "../components/app/segmented-control.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";
import { SiteHeaderActions } from "../shell/site-header-actions.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import { CodeEditor } from "../projects/configuration/code-editor.js";
import { useRouteTenant } from "../projects/context.js";
import type { Result } from "../contract/respond.js";
import {
  mergeTriggerForm,
  parseEditorEvent,
  projectTriggerForm,
  triggerFormErrors,
  type TriggerFieldErrors,
  type TriggerFormValue,
} from "./configuration/editor.js";
import { saveTrigger, triggerSnapshot, type TriggerSnapshot } from "./functions.js";
import { daemonProviderSnapshot } from "../daemons/functions.js";
import type { HubProviderSnapshot, HubProviderSnapshotEntry } from "../hub/protocol.js";
import { selectedProviderModel } from "./provider-catalog.js";

type BrowserTrigger = TriggerSnapshot["triggers"][number];
type EditorMode = "form" | "yaml";

/** Every form value the operator types into a control, i.e. everything but the event and the switch. */
type TriggerTextField = Exclude<
  {
    [Key in keyof TriggerFormValue]: TriggerFormValue[Key] extends string ? Key : never;
  }[keyof TriggerFormValue],
  "event"
>;

const TRIGGER_COLUMNS = [
  { header: "Trigger" },
  { header: "Event", className: "hidden md:table-cell" },
  { header: "Target", className: "hidden lg:table-cell" },
  { header: "Last triggered", className: "hidden xl:table-cell" },
  { header: "Status" },
] as const;

/** The event names the form supports, and how each one reads in a sentence. */
const EVENT_LABELS: Record<string, string> = {
  "slack.mention": "Slack mention",
  "discord.mention": "Discord mention",
  "github.issue_comment": "GitHub issue comment",
  "linear.issue_created": "Linear issue created",
  "manual.run": "Manual run",
};

// The picker names the event, with its identifier underneath: an operator matching a trigger to
// a YAML document needs the identifier, and a table scanning past it does not.
const EVENT_OPTIONS: readonly ComboboxOption[] = Object.entries(EVENT_LABELS).map(
  ([value, label]) => ({ value, label, detail: value, keywords: [value] }),
);

const TRIGGERS_DESCRIPTION = "Launch agents on your compute when organization events arrive.";
const TRIGGER_EDITOR_DESCRIPTION = "One event launches one agent on your compute.";

export function TriggersPanel() {
  const tenant = useRouteTenant();
  const scope = { organizationSlug: tenant.organization.slug };
  const snapshot = useTriggerSnapshot(scope.organizationSlug);
  const navigate = useNavigate();
  if (snapshot.isPending) {
    return (
      <>
        <PageHeader title="Triggers" description={TRIGGERS_DESCRIPTION} />
        <DataTableSkeleton label="Triggers" columns={TRIGGER_COLUMNS} />
      </>
    );
  }
  if (snapshot.isError || snapshot.data.status === "error") {
    return <TriggerLoadError result={snapshot.data} />;
  }
  const data = snapshot.data.data;
  const triggerPath = (triggerId: string) =>
    `/o/${scope.organizationSlug}/triggers/${triggerId}` as never;
  return (
    <>
      <PageHeader title="Triggers" description={TRIGGERS_DESCRIPTION}>
        {data.canManage ? (
          <Button asChild>
            <Link to={triggerPath("new")}>
              <Plus aria-hidden="true" /> New trigger
            </Link>
          </Button>
        ) : null}
      </PageHeader>
      <div className="grid gap-6">
        {data.daemons.length === 0 ? (
          <WarningAlert
            title="Add a daemon first"
            action={
              <Button asChild variant="outline" size="sm">
                <Link to={`/o/${scope.organizationSlug}/daemons` as never}>Go to Daemons</Link>
              </Button>
            }
          >
            <p>Triggers need a daemon to run.</p>
          </WarningAlert>
        ) : null}
        <DataTable
          label="Triggers"
          columns={TRIGGER_COLUMNS}
          isEmpty={data.triggers.length === 0}
          empty={{
            title: "No triggers",
            description: "Connect a provider and daemon, then create your first trigger.",
          }}
        >
          {data.triggers.map((trigger) => (
            <DataRow
              key={trigger.id}
              onSelect={() => {
                void navigate({ to: triggerPath(trigger.id) });
              }}
            >
              <DataCell>
                <span className="flex min-w-52 items-center gap-3">
                  <span
                    className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted text-foreground"
                    role="img"
                    aria-label={`${trigger.provider} provider`}
                  >
                    <ProviderGlyph provider={trigger.provider} />
                  </span>
                  <TwoLine
                    primary={
                      <Link
                        to={triggerPath(trigger.id)}
                        className="hover:underline"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {trigger.name}
                      </Link>
                    }
                    secondary={
                      trigger.format === "legacy_multistep"
                        ? "Legacy YAML"
                        : (trigger.draft?.agent ?? "Advanced YAML")
                    }
                  />
                </span>
              </DataCell>
              <DataCell className="hidden whitespace-nowrap md:table-cell">
                <TwoLine
                  primary={eventLabel(trigger.event)}
                  {...(trigger.draft?.connection === "" || trigger.draft?.connection === undefined
                    ? {}
                    : { secondary: trigger.draft.connection })}
                />
              </DataCell>
              <DataCell className="hidden whitespace-nowrap lg:table-cell">
                {trigger.draft === null ? (
                  <span className="text-muted-foreground">Advanced configuration</span>
                ) : (
                  <TwoLine mono primary={trigger.draft.daemon} secondary={trigger.draft.cwd} />
                )}
              </DataCell>
              <DataCell className="hidden whitespace-nowrap xl:table-cell">
                {trigger.lastTriggered === null ? (
                  <span className="text-muted-foreground">Never</span>
                ) : (
                  <TwoLine
                    primary={<RelativeTime value={trigger.lastTriggered.receivedAt} />}
                    secondary={statusLabel(trigger.lastTriggered.status)}
                  />
                )}
              </DataCell>
              <DataCell>
                <StatusPill tone={trigger.enabled ? "success" : "neutral"}>
                  {trigger.enabled ? "Enabled" : "Disabled"}
                </StatusPill>
              </DataCell>
            </DataRow>
          ))}
        </DataTable>
      </div>
    </>
  );
}

export function TriggerEditorPanel({ triggerId }: { triggerId: string }) {
  const tenant = useRouteTenant();
  const organizationSlug = tenant.organization.slug;
  const snapshot = useTriggerSnapshot(organizationSlug);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const saveCommand = useServerFn(saveTrigger) as (input: {
    data: { organizationSlug: string; triggerId?: string; yaml: string };
  }) => Promise<Result<{ state: "complete" }>>;
  const save = useMutation({
    mutationFn: saveCommand,
    onSuccess: async (result) => {
      if (result.status !== "ok") return;
      await queryClient.invalidateQueries({ queryKey: ["triggers", organizationSlug] });
      await navigate({ to: `/o/${organizationSlug}/triggers` as never });
    },
  });
  if (snapshot.isPending) return <TriggerEditorSkeleton />;
  if (snapshot.isError || snapshot.data.status === "error") {
    return <TriggerLoadError result={snapshot.data} />;
  }
  const data = snapshot.data.data;
  const trigger = triggerId === "new" ? null : data.triggers.find(({ id }) => id === triggerId);
  if (trigger === undefined) {
    return (
      <FailureAlert
        title="Trigger not found"
        error={null}
        fallback="This trigger no longer exists. Return to the trigger list and choose another one."
      />
    );
  }
  const returnToList = () => {
    void navigate({ to: `/o/${organizationSlug}/triggers` as never });
  };
  return (
    <TriggerEditor
      key={trigger?.id ?? "new"}
      trigger={trigger}
      snapshot={data}
      saving={save.isPending}
      saveError={save.data?.status === "error" ? save.data.error.message : undefined}
      onCancel={returnToList}
      onSave={(yaml) =>
        save.mutate({
          data: {
            organizationSlug,
            ...(trigger?.id === undefined ? {} : { triggerId: trigger.id }),
            yaml,
          },
        })
      }
    />
  );
}

function useTriggerSnapshot(organizationSlug: string) {
  const load = useServerFn(triggerSnapshot);
  return useQuery({
    queryKey: ["triggers", organizationSlug],
    queryFn: () => load({ data: { organizationSlug } }),
  });
}

function TriggerLoadError({ result }: { result: Result<TriggerSnapshot> | undefined }) {
  return (
    <FailureAlert
      title="Triggers unavailable"
      error={result}
      fallback="Hub couldn't load this organization's triggers."
    />
  );
}

function TriggerEditor({
  trigger,
  snapshot,
  saving,
  saveError,
  onCancel,
  onSave,
}: {
  trigger: BrowserTrigger | null;
  snapshot: TriggerSnapshot;
  saving: boolean;
  saveError: string | undefined;
  onCancel: () => void;
  onSave: (yaml: string) => void;
}) {
  const legacy = trigger?.format === "legacy_multistep";
  const editor = useTriggerEditorState(trigger, snapshot, legacy, onSave);
  const title = trigger === null ? "New trigger" : trigger.name;
  const submitLabel = triggerSubmitLabel(editor.mode, trigger === null);
  // Saving is refused only for what the reader cannot act on here: a request in flight, a
  // read-only role, a legacy document. A half-filled form is something they can act on, so the
  // button stays live and pressing it says which fields are in the way.
  const saveDisabled = saving || !snapshot.canManage || legacy;
  // Nor is the YAML view a dead segment. A form that cannot serialise yet is a form with fields
  // to fix, and pressing YAML marks them instead of doing nothing at all. Only the legacy
  // document has a mode that is genuinely unreachable, and its own alert says why.
  const modeOptions: readonly SegmentedOption[] = [
    { value: "form", label: "Form", icon: FileText, disabled: legacy || !editor.canEditAsForm },
    { value: "yaml", label: "YAML", icon: Braces },
  ];
  const modeSwitch = (
    <SegmentedControl
      label="Editor mode"
      value={editor.mode}
      options={modeOptions}
      onChange={(value) => editor.switchMode(value === "yaml" ? "yaml" : "form")}
    />
  );
  return (
    <>
      {/* From `sm` up these live in the site header; the phone renders them in the page, where
          the mode switch sits above the form and the buttons are pinned within thumb reach. */}
      <SiteHeaderActions>
        {modeSwitch}
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Discard
        </Button>
        <Button
          type="submit"
          form="trigger-editor-form"
          size="sm"
          disabled={saveDisabled}
          aria-busy={saving}
        >
          {saving ? <Spinner /> : null}
          {submitLabel}
        </Button>
      </SiteHeaderActions>
      <Button variant="ghost" size="sm" className="mb-4 -ml-2.5" onClick={onCancel}>
        <ArrowLeft aria-hidden="true" /> Triggers
      </Button>
      <PageHeader
        title={title}
        status={{
          label: editor.form.enabled ? "Enabled" : "Disabled",
          tone: editor.form.enabled ? "success" : "neutral",
        }}
        description={TRIGGER_EDITOR_DESCRIPTION}
      />
      <div className="grid gap-6">
        <TriggerCompatibilityAlert
          legacy={legacy}
          advanced={editor.mode === "yaml" && editor.yamlOnly}
          reason={editor.mode === "yaml" ? editor.blocked : undefined}
        />
        {saveError === undefined ? null : (
          <FailureAlert
            title="Trigger not saved"
            error={saveError}
            fallback="Hub couldn't save this trigger."
          />
        )}
        {editor.mode === "form" ? <TriggerRefusalSummary errors={editor.errors} /> : null}
        <div className="sm:hidden">{modeSwitch}</div>
        {/*
          The document decides what is missing, not the browser. Left to constraint validation an
          empty required input opens a native bubble on the first field and stops there, in the
          platform's own type, saying nothing about the daemon or the agent — which are comboboxes
          it cannot see at all. One refusal, one summary, one mark per field.
        */}
        <form id="trigger-editor-form" noValidate className="grid gap-6" onSubmit={editor.submit}>
          {editor.mode === "yaml" ? (
            <div className="grid h-160 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border bg-card">
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <span className="truncate font-mono text-xs">trigger.yaml</span>
                <CopyButton label="Trigger YAML" value={editor.yaml} />
              </div>
              <CodeEditor
                value={editor.yaml}
                language="yaml"
                readOnly={!snapshot.canManage || legacy}
                label="Trigger YAML"
                onChange={editor.setYaml}
              />
            </div>
          ) : (
            <TriggerForm
              form={editor.form}
              errors={editor.errors}
              triggerId={trigger?.id}
              snapshot={snapshot}
              onChange={editor.setForm}
            />
          )}
          <FormActions pinned>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={saveDisabled} aria-busy={saving}>
              {saving ? <Spinner /> : null}
              {submitLabel}
            </Button>
          </FormActions>
        </form>
      </div>
    </>
  );
}

function triggerSubmitLabel(mode: EditorMode, creating: boolean) {
  if (mode === "yaml") return "Save YAML";
  return creating ? "Create trigger" : "Save changes";
}

/**
 * The editor holds one trigger in two representations and keeps them convertible. Whether a
 * conversion is possible is a fact about the document, not an accident discovered when the reader
 * clicks: the unavailable mode is disabled and the reason is on screen, so neither switching nor
 * saving can fail with a surprise.
 */
function useTriggerEditorState(
  trigger: BrowserTrigger | null,
  snapshot: TriggerSnapshot,
  legacy: boolean,
  onSave: (yaml: string) => void,
) {
  const initialForm = trigger?.draft ?? defaultForm(snapshot);
  const initialYaml = trigger?.yaml ?? "";
  const initialProjection = useMemo(() => projectTriggerForm(initialYaml), [initialYaml]);
  const [mode, setMode] = useState<EditorMode>(
    trigger === null || (initialProjection.status === "editable" && !legacy) ? "form" : "yaml",
  );
  const [yaml, setYaml] = useState(initialYaml);
  const [form, setForm] = useState<TriggerFormValue>(
    initialProjection.status === "editable" ? initialProjection.value : initialForm,
  );
  // What the mode the reader is *not* in would receive. In form mode that is the YAML the form
  // serialises to; in YAML mode it is the form the document projects onto.
  const other = useMemo(
    () => (mode === "form" ? mergeTriggerForm(yaml, form) : projectTriggerForm(yaml)),
    [mode, yaml, form],
  );
  const blocked = other.status === "ok" || other.status === "editable" ? undefined : other.reason;
  // Nothing is marked wrong until the reader asks for something the form cannot do yet: a blank
  // new trigger is not a page of errors, it is a page nobody has filled in. Once they have asked,
  // the marks stay and follow what they type.
  const [refused, setRefused] = useState(false);
  const errors = useMemo(() => triggerFormErrors(form), [form]);
  const refuse = () => setRefused(true);
  const switchMode = (next: EditorMode) => {
    if (next === mode) return;
    if (other.status === "ok") setYaml(other.yaml);
    else if (other.status === "editable") setForm(other.value);
    else {
      refuse();
      return;
    }
    setMode(next);
    window.scrollTo({ top: 0 });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === "yaml") onSave(yaml);
    else if (other.status === "ok") onSave(other.yaml);
    else refuse();
  };
  return {
    mode,
    yaml,
    form,
    errors: refused ? errors : NO_FIELD_ERRORS,
    // Legacy workflows are explained by their own alert; repeating the schema error underneath it
    // would say the same thing twice in less useful words.
    blocked: legacy ? undefined : blocked,
    canEditAsForm: mode === "form" || other.status === "editable",
    yamlOnly: initialProjection.status === "yaml_only",
    setYaml,
    setForm,
    switchMode,
    submit,
  };
}

const NO_FIELD_ERRORS: TriggerFieldErrors = {};

/**
 * Everything standing between this form and a saved trigger, said once at the top.
 *
 * The marks beside the fields are only useful to a reader who can already see them: the field
 * in the way may be three sections below the button that was pressed, it is always off screen on
 * a phone, and one of them — the daemon, when the organization has none — has no control on the
 * page to be marked at all. The summary takes the keyboard when it arrives, so pressing a button
 * that cannot do anything yet always answers in the same place.
 */
function TriggerRefusalSummary({ errors }: { errors: TriggerFieldErrors }) {
  const reasons = Object.values(errors);
  const [first] = reasons;
  if (first === undefined) return null;
  return (
    <FailureAlert
      title="This trigger is not ready to save"
      error={reasons.length === 1 ? first : "Fix these fields and submit again."}
      fallback="This trigger is missing something the document needs."
      details={
        reasons.length === 1 ? undefined : (
          <ul className="grid gap-1">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )
      }
      focusOnArrival
    />
  );
}

/**
 * Why the form view is not available for this document, said once. The `reason` is the schema's
 * own words about the YAML on screen, which is also the reason the Form segment above is
 * disabled — a control that cannot be pressed is explained on the page, not in a tooltip.
 */
function TriggerCompatibilityAlert({
  legacy,
  advanced,
  reason,
}: {
  legacy: boolean;
  advanced: boolean;
  reason: string | undefined;
}) {
  if (!legacy && !advanced && reason === undefined) return null;
  return (
    <WarningAlert title={compatibilityTitle(legacy, advanced)}>
      {legacy ? (
        <p>
          This workflow remains runnable. Copy this YAML and use the migration guide to replace it
          with one self-contained trigger per event. Form editing is disabled.
        </p>
      ) : (
        <p>
          {advanced
            ? "This YAML uses features the form cannot represent. Edit it directly; Hub will preserve every advanced field."
            : "This YAML cannot be edited as a form until it parses against the trigger schema."}
        </p>
      )}
      {legacy || reason === undefined ? null : <p>{reason}</p>}
    </WarningAlert>
  );
}

function compatibilityTitle(legacy: boolean, advanced: boolean): string {
  if (legacy) return "Legacy multi-step workflow";
  return advanced ? "Advanced trigger" : "Form editing unavailable";
}

/** The error slot a field carries, absent while that field is fine. */
function fieldError(errors: TriggerFieldErrors, key: keyof TriggerFormValue) {
  const error = errors[key];
  return error === undefined ? {} : { error };
}

function TriggerForm({
  form,
  errors,
  triggerId,
  snapshot,
  onChange,
}: {
  form: TriggerFormValue;
  /** What each field still needs, once the reader has asked for something it blocks. */
  errors: TriggerFieldErrors;
  triggerId: string | undefined;
  snapshot: TriggerSnapshot;
  onChange: (value: TriggerFormValue) => void;
}) {
  const provider = form.event.split(".")[0];
  const connections = snapshot.connections.filter((connection) => connection.provider === provider);
  const githubConnections = snapshot.connections.filter(
    (connection) => connection.provider === "github",
  );
  const connectionOptions = connections.map((connection) => ({
    value: connection.slug,
    label: connection.label,
  }));
  const daemonOptions = snapshot.daemons.map((daemon) => ({
    value: daemon.slug,
    label: daemon.slug,
    detail: daemon.presence,
  }));
  const githubConnectionOptions = [
    { value: "", label: "Do not inject a GitHub token" },
    ...githubConnections.map((connection) => ({
      value: connection.slug,
      label: connection.label,
    })),
  ];
  const githubEnabled = form.githubConnection !== "";
  const [githubExpanded, setGithubExpanded] = useState(githubEnabled);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const everyone = form.allowedUsers.trim() === "*";
  const update = <Key extends keyof TriggerFormValue>(key: Key, value: TriggerFormValue[Key]) =>
    onChange({ ...form, [key]: value });
  const text = (key: TriggerTextField) => (value: string) => update(key, value);
  const selectedDaemon = snapshot.daemons.find((daemon) => daemon.slug === form.daemon);
  const noDaemons = snapshot.daemons.length === 0;
  const providerCatalog = useDaemonProviderCatalog(
    snapshot.organization.slug,
    selectedDaemon?.id,
    form.cwd,
  );
  return (
    <div className="grid gap-6">
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id="trigger-name"
            label="Trigger name"
            description="Lowercase identifier with hyphens, for example slack-triage."
            kind="text"
            name="name"
            value={form.name}
            onChange={text("name")}
            required
            {...fieldError(errors, "name")}
          />
          <FormField
            id="trigger-id"
            label="Trigger ID"
            description="Immutable identifier within this organization."
            kind="text"
            name="id"
            value={triggerId ?? "Assigned when saved"}
            disabled
          />
        </div>
        <CheckboxField
          id="trigger-enabled"
          label="Enabled"
          description="A disabled trigger keeps its configuration and stops responding to events."
          checked={form.enabled}
          onChange={(checked) => update("enabled", checked)}
        />
      </Card>

      {/*
        The four decisions a trigger is made of, in the order the run makes them: what arrives,
        who may send it, where it lands, what runs there. A step whose decision does not exist —
        a manual run has no audience — is not rendered, and `Steps` renumbers the rest.
      */}
      <Steps>
        <Card title={EDITOR_STEPS.event.title} description={EDITOR_STEPS.event.description}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="trigger-event" label="When this happens">
              {(control) => (
                <Combobox
                  {...control}
                  value={form.event}
                  options={EVENT_OPTIONS}
                  placeholder="Select an event"
                  empty="No events found."
                  onChange={(option) => update("event", parseEditorEvent(option.value))}
                />
              )}
            </FormField>
            {form.event === "manual.run" ? null : (
              <FormField
                id="trigger-connection"
                label="Connection"
                description="The organization connection that receives the event."
                required
                {...fieldError(errors, "connection")}
              >
                {(control) => (
                  <Combobox
                    {...control}
                    required
                    value={form.connection}
                    options={connectionOptions}
                    placeholder="Select a connection"
                    empty="No connections found."
                    onChange={(option) => update("connection", option.value)}
                  />
                )}
              </FormField>
            )}
          </div>
        </Card>

        {form.event === "manual.run" ? null : (
          <Card title={EDITOR_STEPS.access.title} description={EDITOR_STEPS.access.description}>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField id="trigger-audience" label="Audience">
                {() => (
                  <SegmentedControl
                    label="Audience"
                    value={everyone ? "everyone" : "specific"}
                    options={AUDIENCE_OPTIONS}
                    onChange={(value) => update("allowedUsers", value === "everyone" ? "*" : "")}
                  />
                )}
              </FormField>
              {everyone ? null : (
                <FormField
                  id="trigger-allowed-users"
                  label="User IDs"
                  description="Comma-separated provider user IDs."
                  kind="text"
                  name="allowedUsers"
                  value={form.allowedUsers}
                  onChange={text("allowedUsers")}
                  required
                  {...fieldError(errors, "allowedUsers")}
                />
              )}
            </div>
          </Card>
        )}

        <Card
          title={EDITOR_STEPS.target.title}
          description={noDaemons ? NO_DAEMON_DESCRIPTION : EDITOR_STEPS.target.description}
          {...(noDaemons
            ? {
                action: (
                  <Button asChild variant="outline" size="sm">
                    <Link to={`/o/${snapshot.organization.slug}/daemons` as never}>
                      Go to Daemons
                    </Link>
                  </Button>
                ),
              }
            : {})}
        >
          {noDaemons ? null : (
            <>
              <FormField
                id="trigger-daemon"
                label="Run on daemon"
                required
                {...fieldError(errors, "daemon")}
              >
                {(control) => (
                  <Combobox
                    {...control}
                    required
                    value={form.daemon}
                    options={daemonOptions}
                    placeholder="Select a daemon"
                    empty="No daemons found."
                    onChange={(option) =>
                      onChange({
                        ...form,
                        daemon: option.value,
                        agent: "",
                        mode: "",
                        thinkingOptionId: "",
                        providerOptions: "",
                      })
                    }
                  />
                )}
              </FormField>
              {selectedDaemon === undefined ? null : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    id="trigger-cwd"
                    label="Working directory"
                    description="Absolute path on the daemon."
                    kind="text"
                    name="cwd"
                    value={form.cwd}
                    onChange={text("cwd")}
                    required
                    {...fieldError(errors, "cwd")}
                  />
                  <FormField
                    id="trigger-max-runtime"
                    label="Maximum runtime"
                    description="Hard deadline for the agent, for example 2h."
                    kind="text"
                    name="maxRuntime"
                    value={form.maxRuntime}
                    onChange={text("maxRuntime")}
                    required
                    {...fieldError(errors, "maxRuntime")}
                  />
                  <FormField
                    id="trigger-idle-timeout"
                    label="Idle timeout"
                    description="Stop an unresponsive agent, for example 10m."
                    kind="text"
                    name="idleTimeout"
                    value={form.idleTimeout}
                    onChange={text("idleTimeout")}
                    required
                    {...fieldError(errors, "idleTimeout")}
                  />
                </div>
              )}
            </>
          )}
        </Card>

        {/*
          The agent step keeps its place while it waits: its models are the selected daemon's own
          answer, so before there is a daemon the step says what it is waiting for rather than
          disappearing and taking the shape of the trigger with it.
        */}
        <Card
          title={EDITOR_STEPS.agent.title}
          description={
            selectedDaemon === undefined ? NO_AGENT_DESCRIPTION : EDITOR_STEPS.agent.description
          }
        >
          {selectedDaemon === undefined ? null : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <ProviderCatalogFields
                  form={form}
                  errors={errors}
                  entries={providerCatalog.entries}
                  loading={providerCatalog.loading}
                  onChange={onChange}
                />
              </div>
              {providerCatalog.loading ? (
                <LoadingLine>{`Loading providers from ${form.daemon}…`}</LoadingLine>
              ) : null}
              {providerCatalog.error === undefined ? null : (
                <FailureAlert
                  title="Providers unavailable"
                  error={providerCatalog.error}
                  fallback="Hub couldn't load this daemon's providers."
                  onRetry={providerCatalog.refresh}
                />
              )}
              <PromptEditor
                value={form.prompt}
                {...fieldError(errors, "prompt")}
                onChange={(prompt) => update("prompt", prompt)}
              />
              <Disclosure
                id="trigger-provider-options"
                open={optionsExpanded}
                onOpenChange={setOptionsExpanded}
                title="Advanced provider options"
                description="Fields the form does not model, passed through to the provider."
              >
                <FormField
                  id="trigger-provider-options-json"
                  label="Provider options (JSON)"
                  description="Passed to the provider on your daemon. YAML-only agent fields remain untouched."
                  kind="multiline"
                  name="providerOptions"
                  value={form.providerOptions}
                  onChange={text("providerOptions")}
                  placeholder={'{"sandbox_mode":"workspace-write"}'}
                  {...fieldError(errors, "providerOptions")}
                />
              </Disclosure>
              <Disclosure
                id="trigger-github"
                open={githubExpanded}
                onOpenChange={setGithubExpanded}
                title="GitHub access"
                description="Give the run a short-lived token scoped to the repositories you name."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    id="trigger-github-connection"
                    label="GitHub connection"
                    description="Mints a short-lived, restricted GH_TOKEN for this run."
                  >
                    {(control) => (
                      <Combobox
                        {...control}
                        value={form.githubConnection}
                        options={githubConnectionOptions}
                        placeholder="Select a GitHub connection"
                        empty="No GitHub connections found."
                        onChange={(option) => update("githubConnection", option.value)}
                      />
                    )}
                  </FormField>
                  {githubEnabled ? (
                    <>
                      <FormField
                        id="trigger-github-repositories"
                        label="GitHub repositories"
                        description="Comma-separated owner/repository names."
                        kind="text"
                        name="githubRepositories"
                        value={form.githubRepositories}
                        onChange={text("githubRepositories")}
                        required
                      />
                      <FormField
                        id="trigger-github-duration"
                        label="GitHub token lifetime"
                        description="At most 1h."
                        kind="text"
                        name="githubDuration"
                        value={form.githubDuration}
                        onChange={text("githubDuration")}
                        required
                      />
                      <FormField
                        id="trigger-github-permissions"
                        label="GitHub permissions (JSON)"
                        description="Defaults to read-only repository contents when empty."
                        kind="multiline"
                        name="githubPermissions"
                        value={form.githubPermissions}
                        onChange={text("githubPermissions")}
                        placeholder={'{"contents":"write","pull_requests":"write"}'}
                        {...fieldError(errors, "githubPermissions")}
                      />
                    </>
                  ) : null}
                </div>
              </Disclosure>
            </>
          )}
        </Card>
      </Steps>

      <Card>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LockKeyhole aria-hidden="true" className="size-4 shrink-0 text-link" />
          Hub launches the agent on your daemon. Keys, provider configuration, and sandboxing stay
          on your compute.
        </p>
      </Card>
    </div>
  );
}

const AUDIENCE_OPTIONS: readonly SegmentedOption[] = [
  { value: "everyone", label: "Everyone" },
  { value: "specific", label: "Specific people" },
];

/**
 * The trigger editor before the snapshot arrives. The back link, the step titles, and the page
 * description are the same every time, so they render for real; only the trigger's own name and
 * field values are placeholders.
 */
function TriggerEditorSkeleton() {
  return (
    <div aria-busy="true">
      <Button variant="ghost" size="sm" className="mb-4 -ml-2.5" disabled>
        <ArrowLeft aria-hidden="true" /> Triggers
      </Button>
      <PageHeaderSkeleton description={TRIGGER_EDITOR_DESCRIPTION} />
      <div className="grid gap-6">
        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldSkeleton />
            <FieldSkeleton />
          </div>
        </Card>
        <Steps>
          {Object.values(EDITOR_STEPS).map((step) => (
            <Card key={step.title} title={step.title} description={step.description}>
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldSkeleton />
                <FieldSkeleton />
              </div>
            </Card>
          ))}
        </Steps>
      </div>
    </div>
  );
}

/**
 * The four decisions a trigger is made of, named once. The form renders them as steps and the
 * skeleton stands in for them, so a reader waiting for a snapshot already sees the shape of the
 * trigger they are about to fill in.
 */
const EDITOR_STEPS = {
  event: {
    title: "The event",
    description: "What arrives, and the connection it arrives on.",
  },
  access: {
    title: "Who can invoke it",
    description: "Everyone the connection can see, or a named list.",
  },
  target: {
    title: "Where it runs",
    description: "The daemon owns compute, credentials, and sandboxing.",
  },
  agent: {
    title: "What runs there",
    description: "The agent, its model, and the instructions it is given.",
  },
} as const;

/** What the step says while the decision above it is still missing. */
const NO_DAEMON_DESCRIPTION =
  "No daemon is connected to this organization yet, and a trigger runs on a daemon.";
const NO_AGENT_DESCRIPTION =
  "Choose a daemon first. The agents you can run are the ones it reports.";

function PromptEditor({
  value,
  error,
  onChange,
}: {
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (element === null) return;
    element.style.height = "0px";
    element.style.height = `${String(element.scrollHeight)}px`;
  }, [value]);
  const insert = (mergeTag: string) => {
    const element = textarea.current;
    if (element === null) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    onChange(`${value.slice(0, start)}${mergeTag}${value.slice(end)}`);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + mergeTag.length, start + mergeTag.length);
    });
  };
  return (
    <div className="grid gap-2">
      <FormField
        id="trigger-prompt"
        label="Instructions"
        required
        {...(error === undefined ? {} : { error })}
      >
        {(control) => (
          <Textarea
            {...control}
            ref={textarea}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            rows={8}
            spellCheck={false}
            className="min-h-48 resize-none overflow-hidden font-mono text-xs"
          />
        )}
      </FormField>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Insert merge tag:</span>
        {MERGE_TAGS.map((mergeTag) => (
          <Button
            key={mergeTag}
            type="button"
            variant="outline"
            size="xs"
            className="font-mono"
            onClick={() => insert(mergeTag)}
          >
            {mergeTag}
          </Button>
        ))}
      </div>
    </div>
  );
}

const MERGE_TAGS = ["${{ paseo.prompt }}", "${{ paseo.context }}"] as const;

function ProviderCatalogFields({
  form,
  errors,
  entries,
  loading,
  onChange,
}: {
  form: TriggerFormValue;
  errors: TriggerFieldErrors;
  entries: HubProviderSnapshotEntry[] | undefined;
  loading: boolean;
  onChange: (value: TriggerFormValue) => void;
}) {
  const selected = selectedProviderModel(entries, form.agent);
  const agentOptions = (entries ?? []).flatMap((entry) =>
    entry.status !== "ready" || !entry.enabled
      ? []
      : (entry.models ?? [])
          .filter((model) => model.isSelectable !== false)
          .map((model) => ({
            value: `${entry.provider}/${model.id}`,
            label: model.label,
            detail: `${entry.label ?? entry.provider} · ${entry.provider}/${model.id}`,
            keywords: [model.label, entry.label ?? entry.provider, model.id],
          })),
  ) satisfies ComboboxOption[];
  const modeOptions = (selected.entry?.modes ?? []).map((mode) => ({
    value: mode.id,
    label: mode.label,
  }));
  const thinkingOptions = (selected.model?.thinkingOptions ?? []).map((option) => ({
    value: option.id,
    label: option.label,
  }));
  return (
    <>
      <FormField
        id="trigger-agent"
        label="Agent"
        description="Models reported by the selected daemon."
        required
        {...fieldError(errors, "agent")}
      >
        {(control) => (
          <Combobox
            {...control}
            required
            loading={loading}
            value={form.agent}
            options={agentOptions}
            placeholder="Select a model"
            searchPlaceholder="Search models…"
            empty="No models found."
            onChange={(option) =>
              onChange({ ...form, agent: option.value, mode: "", thinkingOptionId: "" })
            }
          />
        )}
      </FormField>
      <FormField
        id="trigger-mode"
        label="Execution mode"
        description="Modes reported for the selected provider."
        required
        {...fieldError(errors, "mode")}
      >
        {(control) => (
          <Combobox
            {...control}
            required
            value={form.mode}
            options={modeOptions}
            placeholder="Select a mode"
            empty="No modes found."
            onChange={(option) => onChange({ ...form, mode: option.value })}
          />
        )}
      </FormField>
      {thinkingOptions.length === 0 ? null : (
        <FormField
          id="trigger-thinking"
          label="Thinking"
          description="Thinking options reported for the selected model."
          required
        >
          {(control) => (
            <Combobox
              {...control}
              required
              value={form.thinkingOptionId}
              options={thinkingOptions}
              placeholder="Select a thinking option"
              empty="No thinking options found."
              onChange={(option) => onChange({ ...form, thinkingOptionId: option.value })}
            />
          )}
        </FormField>
      )}
    </>
  );
}

function useDaemonProviderCatalog(
  organizationSlug: string,
  daemonId: string | undefined,
  cwd: string,
) {
  const load = useServerFn(daemonProviderSnapshot);
  const queryClient = useQueryClient();
  const queryKey = ["daemon-provider-snapshot", organizationSlug, daemonId, cwd] as const;
  const enabled = daemonId !== undefined && cwd.trim() !== "";
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: () =>
      load({
        data: { organizationSlug, daemonId: daemonId!, cwd: cwd.trim(), refresh: true },
      }),
  });
  const refresh = useMutation({
    mutationFn: () =>
      load({
        data: { organizationSlug, daemonId: daemonId!, cwd: cwd.trim(), refresh: true },
      }),
    onSuccess: (result) => queryClient.setQueryData(queryKey, result),
  });
  const result = query.data;
  const providerErrors =
    result?.status === "ok"
      ? result.data.entries
          .filter((entry) => entry.status === "error")
          .map((entry) => `${entry.label ?? entry.provider}: ${entry.error ?? "unavailable"}`)
      : [];
  return {
    entries: result?.status === "ok" ? result.data.entries : undefined,
    loading: (enabled && query.isPending) || refresh.isPending,
    error: providerCatalogError(result, query.isError, providerErrors),
    refresh: () => refresh.mutate(),
  };
}

function providerCatalogError(
  result: Result<HubProviderSnapshot> | undefined,
  queryFailed: boolean,
  providerErrors: string[],
): string | undefined {
  if (result?.status === "error") return result.error.message;
  if (queryFailed) return "Hub couldn't load this daemon's providers.";
  return providerErrors.length > 0 ? providerErrors.join(" ") : undefined;
}

function defaultForm(snapshot: TriggerSnapshot): TriggerFormValue {
  const slack = snapshot.connections.find(({ provider }) => provider === "slack");
  return {
    name: "new-trigger",
    enabled: true,
    event: slack === undefined ? "manual.run" : "slack.mention",
    connection: slack?.slug ?? "",
    allowedUsers: "*",
    daemon: "",
    cwd: "/workspace",
    agent: "",
    mode: "",
    thinkingOptionId: "",
    providerOptions: "",
    maxRuntime: "2h",
    idleTimeout: "10m",
    githubConnection: "",
    githubRepositories: "",
    githubPermissions: "",
    githubDuration: "1h",
    prompt:
      "Handle this request in the originating conversation.\n\nWhen hub.reply is available, use it for useful progress updates and your final user-facing response. Call hub.finish_execution once the request is complete.\n\nRequest:\n${{ paseo.prompt }}",
  };
}

function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event;
}
