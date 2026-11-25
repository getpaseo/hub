import {
  recurrenceSummary,
  RecurrenceSchema,
  DEFAULT_RECURRENCE,
  type Recurrence,
} from "../schedule/recurrence.js";
import { ContinuationSchema } from "../continuation.js";
import { isAlias, isNode, parseDocument, stringify, visit, type Document } from "yaml";
import { z } from "zod";
import {
  integrationProviders,
  IntegrationToolGrantsSchema,
  type IntegrationAction,
  type IntegrationProvider,
  type IntegrationToolGrants,
} from "../../integration-tools/grants.js";
import { IDENTIFIER, TriggerDocumentSchema, type TriggerDocument } from "./schema.js";

import {
  defaultAudience,
  eventDefinition,
  isEditorEvent,
  type EditorEvent,
  type QualifierValues,
  type QualifierKey,
  type TriggerAudience,
} from "./events.js";
import {
  CONTRIBUTOR_ASSOCIATIONS,
  MEMBER_ASSOCIATIONS,
  type GitHubAuthorAssociation,
} from "../github/author-association.js";

export interface IntegrationToolFormValue {
  connection: string;
  actions: IntegrationAction[];
  channels: string;
}

export interface TriggerFormValue {
  name: string;
  enabled: boolean;
  event: EditorEvent;
  connection: string;
  audience: TriggerAudience;
  /** The comma-separated people a `specific` audience names; empty for every other audience. */
  allowedUsers: string;
  qualifiers: QualifierValues;
  recurrence?: Recurrence;
  daemon: string;
  cwd: string;
  agent: string;
  mode: string;
  thinkingOptionId: string;
  providerOptions: string;
  continuationMode: string;
  continuationKey: string;
  maxRuntime: string;
  idleTimeout: string;
  /** The agent is created hidden from Paseo's sidebar and notifications. */
  background: boolean;
  /** Paseo archives the agent once the run finishes. */
  autoArchive: boolean;
  githubEnabled?: boolean;
  githubConnection: string;
  githubRepositories: string;
  githubPermissions: string;
  githubDuration: string;
  tools: Partial<Record<IntegrationProvider, IntegrationToolFormValue>>;
  prompt: string;
}

export type TriggerFormProjection =
  | { status: "editable"; value: TriggerFormValue }
  | { status: "yaml_only"; reason: string };

const ProviderOptionsSchema = z.record(z.string(), z.unknown());
const GitHubPermissionsSchema = z.record(z.string(), z.enum(["read", "write", "admin"]));

export function projectTriggerForm(yaml: string): TriggerFormProjection {
  const parsed = parseEditorDocument(yaml);
  if (!parsed.success) return { status: "yaml_only", reason: parsed.error };
  const trigger = parsed.data;
  const events = Object.entries(trigger.on);
  if (events.length !== 1) {
    return { status: "yaml_only", reason: "The form supports exactly one event" };
  }
  const [event, definition] = events[0]!;
  if (!isEditorEvent(event)) {
    return { status: "yaml_only", reason: `The form does not support the ${event} event` };
  }
  if ("choices" in trigger.run.agent) {
    return { status: "yaml_only", reason: "Agent choices can only be edited in YAML" };
  }
  if (trigger.run.tools !== undefined && integrationToolsUseYamlReferences(parsed.document)) {
    return {
      status: "yaml_only",
      reason:
        "Edit this trigger in YAML because its integration tool grants use anchors or aliases",
    };
  }
  const audience = readAudience(event, definition.filters);
  if ("reason" in audience) return { status: "yaml_only", reason: audience.reason };
  return {
    status: "editable",
    value: toFormValue(trigger, event, definition, trigger.run.agent, audience),
  };
}

type FormAudience = Pick<TriggerFormValue, "audience" | "allowedUsers">;

const ASSOCIATION_AUDIENCES: readonly {
  audience: TriggerAudience;
  associations: readonly GitHubAuthorAssociation[];
}[] = [
  { audience: "members", associations: MEMBER_ASSOCIATIONS },
  { audience: "contributors", associations: CONTRIBUTOR_ASSOCIATIONS },
];

/** The audience a document's filters amount to, or why the form has no control for it. */
function readAudience(
  event: EditorEvent,
  filters: TriggerDocument["on"][string]["filters"],
): FormAudience | { reason: string } {
  const associations = filters?.author_associations;
  const named = filters?.from_users;
  if (associations === undefined) {
    return named === undefined || (named.length === 1 && named[0] === "*")
      ? { audience: "everyone", allowedUsers: "" }
      : { audience: "specific", allowedUsers: named.join(", ") };
  }
  if (named !== undefined) {
    return {
      reason: "Edit this trigger in YAML because it combines named users with author associations",
    };
  }
  const preset = ASSOCIATION_AUDIENCES.find(
    (candidate) =>
      candidate.associations.length === new Set(associations).size &&
      candidate.associations.every((association) => associations.includes(association)),
  );
  if (preset === undefined || !eventDefinition(event).audiences.includes(preset.audience)) {
    return {
      reason: "Edit this trigger in YAML because its author associations are a custom list",
    };
  }
  return { audience: preset.audience, allowedUsers: "" };
}

/** The two filters an audience owns. A key it does not use is absent, never empty. */
function authoredAudience(value: TriggerFormValue): {
  from_users?: string[];
  author_associations?: GitHubAuthorAssociation[];
} {
  const preset = ASSOCIATION_AUDIENCES.find((candidate) => candidate.audience === value.audience);
  if (preset !== undefined) return { author_associations: [...preset.associations] };
  return { from_users: value.audience === "specific" ? commaSeparated(value.allowedUsers) : ["*"] };
}

function toFormValue(
  trigger: TriggerDocument,
  event: EditorEvent,
  definition: TriggerDocument["on"][string],
  agent: Extract<TriggerDocument["run"]["agent"], { provider: string }>,
  audience: FormAudience,
): TriggerFormValue {
  return {
    name: trigger.name,
    enabled: trigger.enabled,
    event,
    connection: definition.connection ?? "",
    ...audience,
    qualifiers: readQualifiers(event, definition.filters),
    recurrence: definition.recurrence ?? DEFAULT_RECURRENCE,
    daemon: trigger.run.target.daemon,
    cwd: trigger.run.target.cwd,
    agent: joinAgentId(agent.provider, agent.model),
    mode: agent.mode ?? "",
    thinkingOptionId: agent.thinkingOptionId ?? "",
    providerOptions: agent.options === undefined ? "" : JSON.stringify(agent.options, null, 2),
    continuationMode: trigger.run.continuation.mode,
    continuationKey: trigger.run.continuation.mode === "key" ? trigger.run.continuation.key : "",
    maxRuntime: trigger.run.max_runtime,
    idleTimeout: trigger.run.idle_timeout,
    background: trigger.run.background,
    autoArchive: trigger.run.auto_archive,
    githubConnection: trigger.run.github?.connection ?? "",
    githubRepositories: trigger.run.github?.repositories?.join(", ") ?? "",
    githubPermissions:
      trigger.run.github?.permissions === undefined
        ? ""
        : JSON.stringify(trigger.run.github.permissions, null, 2),
    githubDuration: trigger.run.github?.duration ?? "",
    tools: Object.fromEntries(
      integrationProviders.flatMap((provider) => {
        const grant = trigger.run.tools?.[provider];
        return grant === undefined
          ? []
          : [[provider, { ...grant, channels: grant.channels.join(", ") }]];
      }),
    ),
    prompt: trigger.run.prompt,
  };
}

/** Patch only form-owned YAML nodes, retaining comments, ordering, and advanced nodes. */
export function patchTriggerYaml(yaml: string, value: TriggerFormValue): string {
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  if (sameFormValue(projection.value, value)) return yaml;
  validateFormValue(value);

  const document = parseDocument(yaml, { compat: ["timestamp"] });
  assertDocument(document);
  setIfChanged(document, ["name"], value.name);
  setIfChanged(document, ["enabled"], value.enabled);

  const previousEvent = projection.value.event;
  if (previousEvent !== value.event) {
    const definition = document.getIn(["on", previousEvent], true);
    document.deleteIn(["on", previousEvent]);
    document.setIn(["on", value.event], definition ?? {});
  }
  if (eventDefinition(value.event).origin === "hub") {
    deleteIfPresent(document, ["on", value.event, "connection"]);
    deleteIfPresent(document, ["on", value.event, "filters", "from_users"]);
    deleteIfPresent(document, ["on", value.event, "filters", "author_associations"]);
  } else {
    setIfChanged(document, ["on", value.event, "connection"], value.connection);
    const audience = authoredAudience(value);
    setOptional(document, ["on", value.event, "filters", "from_users"], audience.from_users);
    setOptional(
      document,
      ["on", value.event, "filters", "author_associations"],
      audience.author_associations,
    );
  }

  setOptional(
    document,
    ["on", value.event, "recurrence"],
    value.event === "schedule.tick" ? (value.recurrence ?? DEFAULT_RECURRENCE) : undefined,
  );
  if (value.event === "schedule.tick" || value.event === "webhook.received")
    deleteIfPresent(document, ["on", value.event, "filters"]);
  const qualifiers = authoredQualifiers(value);
  const ownedKeys = new Set(
    [...eventDefinition(previousEvent).qualifiers, ...eventDefinition(value.event).qualifiers].map(
      (qualifier) => qualifier.key,
    ),
  );
  for (const key of ownedKeys) {
    setOptional(document, ["on", value.event, "filters", key], qualifiers[key]);
  }

  setIfChanged(document, ["run", "target", "daemon"], value.daemon);
  setIfChanged(document, ["run", "target", "cwd"], value.cwd);
  const agent = splitAgentId(value.agent);
  setIfChanged(document, ["run", "agent", "provider"], agent.provider);
  setOptional(document, ["run", "agent", "model"], agent.model);
  setOptional(document, ["run", "agent", "mode"], blankToUndefined(value.mode));
  setOptional(
    document,
    ["run", "agent", "thinkingOptionId"],
    blankToUndefined(value.thinkingOptionId),
  );
  setOptional(document, ["run", "agent", "options"], parseProviderOptions(value.providerOptions));
  setIfChanged(document, ["run", "continuation"], formContinuation(value));
  setIfChanged(document, ["run", "max_runtime"], value.maxRuntime.trim());
  setIfChanged(document, ["run", "idle_timeout"], value.idleTimeout.trim());
  // Written only when the reader changed them, so a document that leaves them to their defaults
  // keeps leaving them there.
  if (value.background !== projection.value.background)
    document.setIn(["run", "background"], value.background);
  if (value.autoArchive !== projection.value.autoArchive)
    document.setIn(["run", "auto_archive"], value.autoArchive);
  setOptional(document, ["run", "github"], githubAuthority(value));
  patchIntegrationToolGrants(document, projection.value, value);
  setIfChanged(document, ["run", "prompt"], value.prompt);
  return document.toString({ lineWidth: 0 });
}

export type TriggerYamlResult =
  | { status: "ok"; yaml: string }
  | { status: "incomplete"; reason: string };

/**
 * The YAML a form amounts to: the canonical document patched where one exists, a fresh document
 * where it does not.
 *
 * A half-filled trigger has no document at all — `run.target.daemon` and `run.agent.provider` have
 * no empty representation — so the caller is told which field is still missing. Handing back a
 * reason rather than throwing is what lets a screen disable the YAML view and say why beside the
 * control, instead of surfacing a stray exception somewhere far from the field that caused it.
 */
export function mergeTriggerForm(yaml: string, value: TriggerFormValue): TriggerYamlResult {
  try {
    return {
      status: "ok",
      yaml:
        projectTriggerForm(yaml).status === "editable"
          ? patchTriggerYaml(yaml, value)
          : createTriggerYaml(value),
    };
  } catch (cause) {
    return { status: "incomplete", reason: incompleteReason(cause) };
  }
}

function incompleteReason(cause: unknown): string {
  return cause instanceof Error && cause.message.trim() !== ""
    ? cause.message
    : "The trigger is invalid";
}

export function createTriggerYaml(value: TriggerFormValue): string {
  validateFormValue(value);
  const agent = splitAgentId(value.agent);
  const providerOptions = parseProviderOptions(value.providerOptions);
  const github = githubAuthority(value);
  const tools = integrationToolGrants(value);
  const definition = formEventDefinition(value);
  return stringify(
    {
      name: value.name,
      enabled: value.enabled,
      on: { [value.event]: definition },
      run: {
        target: { daemon: value.daemon, cwd: value.cwd },
        agent: {
          provider: agent.provider,
          ...(agent.model === undefined ? {} : { model: agent.model }),
          ...(value.mode.trim() ? { mode: value.mode.trim() } : {}),
          ...(blankToUndefined(value.thinkingOptionId) === undefined
            ? {}
            : { thinkingOptionId: value.thinkingOptionId.trim() }),
          ...(providerOptions === undefined ? {} : { options: providerOptions }),
        },
        continuation: formContinuation(value),
        max_runtime: value.maxRuntime.trim(),
        idle_timeout: value.idleTimeout.trim(),
        ...(value.background ? { background: true } : {}),
        ...(value.autoArchive ? {} : { auto_archive: false }),
        ...(github === undefined ? {} : { github }),
        ...(tools === undefined ? {} : { tools }),
        prompt: value.prompt,
      },
    },
    { lineWidth: 0, compat: ["timestamp"] },
  );
}

function formEventDefinition(value: TriggerFormValue): TriggerDocument["on"][string] {
  if (value.event === "schedule.tick")
    return { recurrence: value.recurrence ?? DEFAULT_RECURRENCE };
  if (eventDefinition(value.event).origin === "hub") return {};
  return {
    connection: value.connection,
    filters: { ...authoredAudience(value), ...authoredQualifiers(value) },
  };
}

function workingDirectoryErrors(value: TriggerFormValue): TriggerFieldErrors {
  const error = workingDirectoryError(value.cwd);
  return error === undefined ? {} : { cwd: error };
}

/** What is wrong with a working directory, or `undefined` when a run can start in it. */
export function workingDirectoryError(cwd: string): string | undefined {
  const directory = cwd.trim();
  if (directory.length === 0) return "Working directory is required";
  return directory.startsWith("/") ? undefined : "Working directory must be an absolute path";
}

function recurrenceErrors(value: TriggerFormValue): TriggerFieldErrors {
  if (value.event !== "schedule.tick") return {};
  const parsed = RecurrenceSchema.safeParse(value.recurrence ?? DEFAULT_RECURRENCE);
  return parsed.success ? {} : { recurrence: parsed.error.issues[0]!.message };
}

function githubAuthority(value: TriggerFormValue) {
  const connection = blankToUndefined(value.githubConnection);
  if (connection === undefined) return undefined;
  const repositories = commaSeparated(value.githubRepositories);
  const permissions = parsePermissions(value.githubPermissions);
  const duration = blankToUndefined(value.githubDuration);
  return {
    connection,
    ...(repositories.length === 0 ? {} : { repositories }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(duration === undefined ? {} : { duration }),
  };
}

function parsePermissions(value: string): Record<string, "read" | "write" | "admin"> | undefined {
  if (value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GitHub permissions must be valid JSON");
  }
  const permissions = GitHubPermissionsSchema.safeParse(parsed);
  if (!permissions.success) {
    throw new Error('GitHub permissions map a scope to "read", "write", or "admin"');
  }
  return permissions.data;
}

function authoredIntegrationToolGrants(value: TriggerFormValue) {
  const entries = integrationProviders.flatMap(
    (
      provider,
    ): [IntegrationProvider, NonNullable<IntegrationToolGrants[IntegrationProvider]>][] => {
      const grant = value.tools[provider];
      return grant === undefined
        ? []
        : [[provider, { ...grant, channels: commaSeparated(grant.channels) }]];
    },
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function integrationToolGrants(value: TriggerFormValue): IntegrationToolGrants | undefined {
  return IntegrationToolGrantsSchema.optional().parse(authoredIntegrationToolGrants(value));
}

function patchIntegrationToolGrants(
  document: Document,
  previous: TriggerFormValue,
  value: TriggerFormValue,
): void {
  const before = integrationToolGrants(previous);
  const after = integrationToolGrants(value);
  if (after === undefined) {
    deleteIfPresent(document, ["run", "tools"]);
    return;
  }
  for (const provider of integrationProviders) {
    const path = ["run", "tools", provider];
    const existing = before?.[provider];
    const updated = after[provider];
    if (updated === undefined || existing === undefined) {
      setOptional(document, path, updated);
      continue;
    }
    for (const field of ["connection", "actions", "channels"] as const) {
      if (JSON.stringify(existing[field]) !== JSON.stringify(updated[field])) {
        document.setIn([...path, field], updated[field]);
      }
    }
  }
}

function integrationToolsUseYamlReferences(document: Document): boolean {
  const run = document.get("run", true);
  if (isNode(run) && (isAlias(run) || run.anchor !== undefined)) return true;
  const tools = document.getIn(["run", "tools"], true);
  if (!isNode(tools)) return false;
  let usesReferences = false;
  const found = () => {
    usesReferences = true;
    return visit.BREAK;
  };
  visit(tools, {
    Alias: found,
    Value: (_, node) => (node.anchor === undefined ? undefined : found()),
  });
  return usesReferences;
}

const INTEGRATION_TOOL_LABELS: Record<IntegrationProvider, string> = {
  slack: "Slack",
  discord: "Discord",
};

function integrationToolErrors(value: TriggerFormValue): TriggerFieldErrors {
  const grants = IntegrationToolGrantsSchema.optional().safeParse(
    authoredIntegrationToolGrants(value),
  );
  if (grants.success) return {};
  return Object.fromEntries(
    grants.error.issues.map(({ path, message }) => {
      const [provider, field] = path;
      const key = "tools." + path.slice(0, 2).join(".");
      if (
        field === "connection" &&
        (provider === "slack" || provider === "discord") &&
        (value.tools[provider]?.connection ?? "").trim() === ""
      ) {
        return [key, `Choose a ${INTEGRATION_TOOL_LABELS[provider]} connection`];
      }
      return [key, message];
    }),
  );
}

/** What is wrong with each field, keyed by the field that has to change. */
export type TriggerFieldErrors = Partial<
  Record<
    | keyof TriggerFormValue
    | `qualifiers.${QualifierKey}`
    | `tools.${IntegrationProvider}.${keyof IntegrationToolFormValue}`,
    string
  >
>;

/**
 * Every reason this form cannot become a trigger document, addressed to the field that owns it.
 *
 * One list, because a form that refuses to submit and a form that marks its fields have to agree
 * about why: the same call feeds the errors drawn beside each control and the single sentence
 * `mergeTriggerForm` reports when the document cannot be written at all. Insertion order is the
 * order the fields appear on screen, so "the first problem" is the topmost one.
 */
function githubAccessErrors(value: TriggerFormValue): TriggerFieldErrors {
  const githubActive = value.githubEnabled ?? value.githubConnection.trim().length !== 0;
  if (!githubActive) return {};
  const errors: TriggerFieldErrors = {};
  if (value.githubConnection.trim().length === 0) {
    errors.githubConnection = "Choose a GitHub connection";
  }
  const permissions = refused(() => parsePermissions(value.githubPermissions));
  if (permissions !== undefined) errors.githubPermissions = permissions;
  return errors;
}

function triggerFormDocumentErrors(value: TriggerFormValue): TriggerFieldErrors {
  const errors: TriggerFieldErrors = {};
  const name = value.name.trim();
  if (name.length === 0) errors.name = "Trigger name is required";
  else if (!IDENTIFIER.test(name)) {
    errors.name = "Use lowercase letters, digits, and hyphens, starting with a letter";
  }
  if (eventDefinition(value.event).origin === "provider") {
    if (value.connection.trim().length === 0) errors.connection = "Connection is required";
    if (value.audience === "specific" && commaSeparated(value.allowedUsers).length === 0) {
      errors.allowedUsers = "Name at least one person";
    }
  }
  for (const qualifier of eventDefinition(value.event).qualifiers) {
    const selection = value.qualifiers[qualifier.key];
    if (qualifier.required && (selection === undefined || selection.trim().length === 0)) {
      errors[`qualifiers.${qualifier.key}`] = `${qualifier.label} is required`;
    }
  }
  Object.assign(errors, recurrenceErrors(value));
  if (value.daemon.trim().length === 0) errors.daemon = "Daemon is required";
  Object.assign(errors, workingDirectoryErrors(value));
  if (value.maxRuntime.trim().length === 0) errors.maxRuntime = "Maximum runtime is required";
  if (value.idleTimeout.trim().length === 0) errors.idleTimeout = "Idle timeout is required";
  const agent = refused(() => splitAgentId(value.agent));
  if (agent !== undefined) errors.agent = agent;
  const options = refused(() => parseProviderOptions(value.providerOptions));
  if (options !== undefined) errors.providerOptions = options;
  Object.assign(
    errors,
    githubAccessErrors(value),
    integrationToolErrors(value),
    continuationErrors(value),
  );
  if (value.prompt.trim().length === 0) errors.prompt = "Instructions are required";
  return errors;
}

/** Form-only completeness; YAML conversion and save retain their authored optional fields. */
export function triggerFormErrors(
  value: TriggerFormValue,
  modes?: readonly { id: string }[],
): TriggerFieldErrors {
  const errors = triggerFormDocumentErrors(value);
  if (errors.agent === undefined && splitAgentId(value.agent).model === undefined) {
    errors.agent = "Choose a provider and model";
  }
  if (value.mode.trim().length === 0) {
    if (modes === undefined) {
      errors.mode = "Load execution modes from the selected daemon or save as YAML";
    } else if (modes.length > 0) {
      errors.mode = "Execution mode is required";
    }
  }
  return errors;
}

/** The message a parse refused with, or `undefined` when it accepted the value. */
function refused(parse: () => unknown): string | undefined {
  try {
    parse();
    return undefined;
  } catch (cause) {
    return incompleteReason(cause);
  }
}

function validateFormValue(value: TriggerFormValue): void {
  const [message] = Object.values(triggerFormDocumentErrors(value));
  if (message !== undefined) throw new Error(message);
}

export function parseProviderOptions(value: string): Record<string, unknown> | undefined {
  if (value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Provider options must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Provider options must be a JSON object");
  }
  return ProviderOptionsSchema.parse(parsed);
}

export function joinAgentId(provider: string, model: string | undefined): string {
  return model === undefined ? provider : `${provider}/${model}`;
}

export function splitAgentId(value: string): { provider: string; model?: string } {
  const normalized = value.trim();
  const separator = normalized.indexOf("/");
  if (separator < 0) {
    if (normalized.length === 0) throw new Error("Agent is required");
    return { provider: normalized };
  }
  const provider = normalized.slice(0, separator).trim();
  const model = normalized.slice(separator + 1).trim();
  if (provider.length === 0 || model.length === 0) {
    throw new Error("Agent must look like provider/model");
  }
  return { provider, model };
}

function parseEditorDocument(
  yaml: string,
):
  | { success: true; data: TriggerDocument; document: Document }
  | { success: false; error: string } {
  const document = parseDocument(yaml, { compat: ["timestamp"] });
  if (document.errors.length > 0) return { success: false, error: document.errors[0]!.message };
  const parsed = TriggerDocumentSchema.safeParse(document.toJS());
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { success: false, error: `${issue.path.join(".") || "YAML"}: ${issue.message}` };
  }
  return { success: true, data: parsed.data, document };
}

function assertDocument(document: Document): void {
  if (document.errors.length > 0) throw new Error(document.errors[0]!.message);
}

function setIfChanged(document: Document, path: readonly string[], value: unknown): void {
  if (JSON.stringify(document.getIn(path)) !== JSON.stringify(value)) document.setIn(path, value);
}

function setOptional(document: Document, path: readonly string[], value: unknown): void {
  if (value === undefined) deleteIfPresent(document, path);
  else setIfChanged(document, path, value);
}

function deleteIfPresent(document: Document, path: readonly string[]): void {
  if (document.hasIn(path)) document.deleteIn(path);
}

function sameFormValue(left: TriggerFormValue, right: TriggerFormValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commaSeparated(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function blankToUndefined(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

/** Provider-bound state and qualifier compatibility belong to the form model. */
export function changeTriggerEvent(value: TriggerFormValue, event: EditorEvent): TriggerFormValue {
  const previous = eventDefinition(value.event);
  const next = eventDefinition(event);
  const sameProvider = previous.provider === next.provider;
  const qualifiers: QualifierValues = {};
  if (sameProvider) {
    for (const qualifier of next.qualifiers) {
      if (
        previous.qualifiers.some(
          (candidate) => candidate.key === qualifier.key && candidate.kind === qualifier.kind,
        )
      ) {
        const selection = value.qualifiers[qualifier.key];
        if (selection !== undefined) qualifiers[qualifier.key] = selection;
      }
    }
  }
  return {
    ...value,
    event,
    qualifiers,
    connection: sameProvider ? value.connection : "",
    ...nextAudience(value, event, sameProvider),
  };
}

/**
 * An audience nobody chose follows the event to its own default. One that was chosen is kept
 * wherever the next event offers it, except across providers, where the names mean nothing.
 */
function nextAudience(
  value: TriggerFormValue,
  event: EditorEvent,
  sameProvider: boolean,
): FormAudience {
  const chosen = value.audience !== defaultAudience(value.event);
  if (sameProvider && chosen && eventDefinition(event).audiences.includes(value.audience)) {
    return { audience: value.audience, allowedUsers: value.allowedUsers };
  }
  return { audience: defaultAudience(event), allowedUsers: "" };
}

function readQualifiers(
  event: EditorEvent,
  filters: TriggerDocument["on"][string]["filters"],
): QualifierValues {
  const values: QualifierValues = {};
  for (const qualifier of eventDefinition(event).qualifiers) {
    const value = filters?.[qualifier.key];
    if (value !== undefined) values[qualifier.key] = value;
  }
  return values;
}

function authoredQualifiers(value: TriggerFormValue): QualifierValues {
  const filters: QualifierValues = {};
  for (const qualifier of eventDefinition(value.event).qualifiers) {
    const selection = value.qualifiers[qualifier.key];
    if (selection !== undefined) filters[qualifier.key] = selection.trim();
  }
  return filters;
}

function formContinuation(value: TriggerFormValue) {
  return ContinuationSchema.parse(
    value.continuationMode === "key"
      ? { mode: "key", key: value.continuationKey }
      : { mode: value.continuationMode },
  );
}

function continuationErrors(value: TriggerFormValue): TriggerFieldErrors {
  return refused(() => formContinuation(value)) === undefined
    ? {}
    : { continuationKey: "Enter a continuation key or expression" };
}

/**
 * A trigger's event as a list row reads it: the kind first, so a schedule never passes for a
 * manual run, then what narrows it — when a schedule fires, or which connection an event
 * arrives through.
 */
export function describeTriggerEvent(
  value: TriggerFormValue | null,
  event: string,
): { kind: string; detail?: string } {
  const kind = isEditorEvent(event) ? eventDefinition(event).label : event;
  if (value?.event === "schedule.tick") {
    return { kind, detail: recurrenceSummary(value.recurrence ?? DEFAULT_RECURRENCE) };
  }
  if (value === null || value.connection === "") return { kind };
  return { kind, detail: value.connection };
}
