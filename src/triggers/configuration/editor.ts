import { parseDocument, stringify, type Document } from "yaml";
import { z } from "zod";
import { IDENTIFIER, TriggerDocumentSchema, type TriggerDocument } from "./schema.js";

import {
  eventDefinition,
  isEditorEvent,
  type EditorEvent,
  type QualifierValues,
  type QualifierKey,
} from "./events.js";

export interface TriggerFormValue {
  name: string;
  enabled: boolean;
  event: EditorEvent;
  connection: string;
  allowedUsers: string;
  qualifiers: QualifierValues;
  daemon: string;
  cwd: string;
  agent: string;
  mode: string;
  thinkingOptionId: string;
  providerOptions: string;
  maxRuntime: string;
  idleTimeout: string;
  githubConnection: string;
  githubRepositories: string;
  githubPermissions: string;
  githubDuration: string;
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
    return { status: "yaml_only", reason: "The form supports exactly one event." };
  }
  const [event, definition] = events[0]!;
  if (!isEditorEvent(event)) {
    return { status: "yaml_only", reason: `The form does not support the ${event} event.` };
  }
  if ("choices" in trigger.run.agent) {
    return { status: "yaml_only", reason: "Agent choices can only be edited in YAML." };
  }
  const agent = trigger.run.agent;
  return {
    status: "editable",
    value: toFormValue(trigger, event, definition, agent),
  };
}

function toFormValue(
  trigger: TriggerDocument,
  event: EditorEvent,
  definition: TriggerDocument["on"][string],
  agent: Extract<TriggerDocument["run"]["agent"], { provider: string }>,
): TriggerFormValue {
  return {
    name: trigger.name,
    enabled: trigger.enabled,
    event,
    connection: definition.connection ?? "",
    allowedUsers: definition.filters?.from_users?.join(", ") ?? "*",
    qualifiers: readQualifiers(event, definition.filters),
    daemon: trigger.run.target.daemon,
    cwd: trigger.run.target.cwd,
    agent: joinAgentId(agent.provider, agent.model),
    mode: agent.mode ?? "",
    thinkingOptionId: agent.thinkingOptionId ?? "",
    providerOptions: agent.options === undefined ? "" : JSON.stringify(agent.options, null, 2),
    maxRuntime: trigger.run.max_runtime,
    idleTimeout: trigger.run.idle_timeout,
    githubConnection: trigger.run.github?.connection ?? "",
    githubRepositories: trigger.run.github?.repositories?.join(", ") ?? "",
    githubPermissions:
      trigger.run.github?.permissions === undefined
        ? ""
        : JSON.stringify(trigger.run.github.permissions, null, 2),
    githubDuration: trigger.run.github?.duration ?? "",
    prompt: trigger.run.prompt,
  };
}

/** Patch only form-owned YAML nodes, retaining comments, ordering, and advanced nodes. */
export function patchTriggerYaml(yaml: string, value: TriggerFormValue): string {
  const projection = projectTriggerForm(yaml);
  if (projection.status !== "editable") throw new Error(projection.reason);
  if (sameFormValue(projection.value, value)) return yaml;
  validateFormValue(value);

  const document = parseDocument(yaml);
  assertDocument(document);
  setIfChanged(document, ["name"], value.name);
  setIfChanged(document, ["enabled"], value.enabled);

  const previousEvent = projection.value.event;
  if (previousEvent !== value.event) {
    const definition = document.getIn(["on", previousEvent], true);
    document.deleteIn(["on", previousEvent]);
    document.setIn(["on", value.event], definition ?? {});
  }
  if (value.event === "manual.run") {
    deleteIfPresent(document, ["on", value.event, "connection"]);
    deleteIfPresent(document, ["on", value.event, "filters", "from_users"]);
  } else {
    setIfChanged(document, ["on", value.event, "connection"], value.connection);
    setIfChanged(document, ["on", value.event, "filters", "from_users"], users(value.allowedUsers));
  }

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
  setIfChanged(document, ["run", "agent", "mode"], value.mode.trim());
  setOptional(
    document,
    ["run", "agent", "thinkingOptionId"],
    blankToUndefined(value.thinkingOptionId),
  );
  setOptional(document, ["run", "agent", "options"], parseProviderOptions(value.providerOptions));
  setIfChanged(document, ["run", "max_runtime"], value.maxRuntime.trim());
  setIfChanged(document, ["run", "idle_timeout"], value.idleTimeout.trim());
  setOptional(document, ["run", "github"], githubAuthority(value));
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
    : "The trigger is invalid.";
}

export function createTriggerYaml(value: TriggerFormValue): string {
  validateFormValue(value);
  const agent = splitAgentId(value.agent);
  const providerOptions = parseProviderOptions(value.providerOptions);
  const github = githubAuthority(value);
  const definition =
    value.event === "manual.run"
      ? {}
      : {
          connection: value.connection,
          filters: {
            from_users: users(value.allowedUsers),
            ...authoredQualifiers(value),
          },
        };
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
          mode: value.mode.trim(),
          ...(blankToUndefined(value.thinkingOptionId) === undefined
            ? {}
            : { thinkingOptionId: value.thinkingOptionId.trim() }),
          ...(providerOptions === undefined ? {} : { options: providerOptions }),
        },
        max_runtime: value.maxRuntime.trim(),
        idle_timeout: value.idleTimeout.trim(),
        ...(github === undefined ? {} : { github }),
        prompt: value.prompt,
      },
    },
    { lineWidth: 0 },
  );
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
    throw new Error("GitHub permissions must be valid JSON.");
  }
  const permissions = GitHubPermissionsSchema.safeParse(parsed);
  if (!permissions.success) {
    throw new Error('GitHub permissions map a scope to "read", "write", or "admin".');
  }
  return permissions.data;
}

/** What is wrong with each field, keyed by the field that has to change. */
export type TriggerFieldErrors = Partial<
  Record<keyof TriggerFormValue | `qualifiers.${QualifierKey}`, string>
>;

/**
 * Every reason this form cannot become a trigger document, addressed to the field that owns it.
 *
 * One list, because a form that refuses to submit and a form that marks its fields have to agree
 * about why: the same call feeds the errors drawn beside each control and the single sentence
 * `mergeTriggerForm` reports when the document cannot be written at all. Insertion order is the
 * order the fields appear on screen, so "the first problem" is the topmost one.
 */
export function triggerFormErrors(value: TriggerFormValue): TriggerFieldErrors {
  const errors: TriggerFieldErrors = {};
  const name = value.name.trim();
  if (name.length === 0) errors.name = "Trigger name is required.";
  else if (!IDENTIFIER.test(name)) {
    errors.name = "Use lowercase letters, digits, and hyphens, starting with a letter.";
  }
  if (value.event !== "manual.run") {
    if (value.connection.trim().length === 0) errors.connection = "Connection is required.";
    if (value.allowedUsers.trim().length === 0) {
      errors.allowedUsers = "Name at least one user ID, or let everyone trigger it.";
    }
  }
  for (const qualifier of eventDefinition(value.event).qualifiers) {
    const selection = value.qualifiers[qualifier.key];
    if (qualifier.required && (selection === undefined || selection.trim().length === 0)) {
      errors[`qualifiers.${qualifier.key}`] = `${qualifier.label} is required.`;
    }
  }
  if (value.daemon.trim().length === 0) errors.daemon = "Daemon is required.";
  if (!value.cwd.trim().startsWith("/")) {
    errors.cwd = "Working directory must be an absolute path.";
  }
  if (value.maxRuntime.trim().length === 0) errors.maxRuntime = "Maximum runtime is required.";
  if (value.idleTimeout.trim().length === 0) errors.idleTimeout = "Idle timeout is required.";
  const agent = refused(() => splitAgentId(value.agent));
  if (agent !== undefined) errors.agent = agent;
  if (value.mode.trim().length === 0) errors.mode = "Execution mode is required.";
  const options = refused(() => parseProviderOptions(value.providerOptions));
  if (options !== undefined) errors.providerOptions = options;
  if (value.githubConnection.trim().length !== 0) {
    const permissions = refused(() => parsePermissions(value.githubPermissions));
    if (permissions !== undefined) errors.githubPermissions = permissions;
  }
  if (value.prompt.trim().length === 0) errors.prompt = "Instructions are required.";
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
  const [message] = Object.values(triggerFormErrors(value));
  if (message !== undefined) throw new Error(message);
}

export function parseProviderOptions(value: string): Record<string, unknown> | undefined {
  if (value.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Provider options must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Provider options must be a JSON object.");
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
    if (normalized.length === 0) throw new Error("Agent is required.");
    return { provider: normalized };
  }
  const provider = normalized.slice(0, separator).trim();
  const model = normalized.slice(separator + 1).trim();
  if (provider.length === 0 || model.length === 0) {
    throw new Error("Agent must look like provider/model.");
  }
  return { provider, model };
}

function parseEditorDocument(
  yaml: string,
): { success: true; data: TriggerDocument } | { success: false; error: string } {
  const document = parseDocument(yaml);
  if (document.errors.length > 0) return { success: false, error: document.errors[0]!.message };
  const parsed = TriggerDocumentSchema.safeParse(document.toJS());
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { success: false, error: `${issue.path.join(".") || "YAML"}: ${issue.message}` };
  }
  return { success: true, data: parsed.data };
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

function users(value: string): string[] {
  const values = commaSeparated(value);
  return values.length === 0 ? ["*"] : values;
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
  return { ...value, event, qualifiers, connection: sameProvider ? value.connection : "" };
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
