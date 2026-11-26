/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- each integration grant binds its own fields and controls */
import { Plus } from "lucide-react";
import { useEffect, useRef } from "react";

import { CheckboxField } from "../components/app/checkbox-field.js";
import { Combobox } from "../components/app/combobox.js";
import { FormField } from "../components/app/form-field.js";
import { TwoLine } from "../components/app/two-line.js";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { ProviderGlyph } from "../connections/provider-glyph.js";
import {
  integrationActions,
  integrationProviders,
  type IntegrationAction,
  type IntegrationProvider,
} from "../integration-tools/grants.js";
import type {
  BrowserIntegrationDefinition,
  IntegrationToolFormDraft,
} from "../integrations/browser-contracts.js";
import {
  defaultBrowserIntegrationRegistry,
  type BrowserIntegrationRegistry,
} from "../integrations/browser-registry.js";
import type {
  IntegrationToolFormValue,
  TriggerFieldErrors,
  TriggerFormValue,
} from "./configuration/editor.js";
import type { TriggerSnapshot } from "./functions.js";

export type IntegrationAccessProvider = string;

export interface IntegrationAccessDefinition {
  readonly provider: IntegrationAccessProvider;
  readonly label: string;
  readonly summary: string;
  readonly integration?: BrowserIntegrationDefinition;
}

const LEGACY_ACCESS_PROVIDERS: readonly IntegrationAccessDefinition[] = [
  {
    provider: "github",
    label: "GitHub",
    summary: "Scoped repository token",
  },
  {
    provider: "slack",
    label: "Slack",
    summary: "Scoped channel tools",
  },
  {
    provider: "discord",
    label: "Discord",
    summary: "Scoped channel tools",
  },
];

export function integrationAccessProviders(
  registry: BrowserIntegrationRegistry = defaultBrowserIntegrationRegistry,
): readonly IntegrationAccessDefinition[] {
  return [
    ...LEGACY_ACCESS_PROVIDERS,
    ...registry.withTools().map((integration) => ({
      provider: integration.id,
      label: integration.label,
      summary: `Scoped ${integration.resourceNoun.toLowerCase()} tools`,
      integration,
    })),
  ];
}

export const INTEGRATION_ACCESS_PROVIDERS: readonly IntegrationAccessDefinition[] =
  integrationAccessProviders();

const EMPTY_TOOL_GRANT: IntegrationToolFormValue = {
  connection: "",
  actions: [],
  channels: "",
};

const EMPTY_INTEGRATION_TOOL_DRAFT: IntegrationToolFormDraft = {
  enabled: true,
  connection: "",
  actions: [],
  fields: {},
};

const DEFAULT_GITHUB_DURATION = "1h";

const TOOL_ACTION_LABELS: Record<IntegrationAction, string> = {
  read: "Read messages",
  post: "Post messages",
};

/** Integration providers currently added to the trigger form. */
export function activeIntegrationProviders(
  form: TriggerFormValue,
  registry: BrowserIntegrationRegistry = defaultBrowserIntegrationRegistry,
): IntegrationAccessProvider[] {
  return integrationAccessProviders(registry).flatMap(({ provider }) => {
    if (provider === "github") {
      return (form.githubEnabled ?? form.githubConnection.trim() !== "") ? ["github"] : [];
    }
    if (provider === "slack" || provider === "discord") {
      return form.tools[provider] === undefined ? [] : [provider];
    }
    return form.integrationTools?.[provider]?.enabled === true ? [provider] : [];
  });
}

/** Add an integration grant row, auto-selecting the connection when the organization has exactly one. */
export function addIntegrationAccess(
  form: TriggerFormValue,
  provider: IntegrationAccessProvider,
  connections: TriggerSnapshot["connections"],
): TriggerFormValue {
  const matching = connections.filter((connection) => connection.provider === provider);
  const autoConnection = matching.length === 1 ? (matching[0]?.slug ?? "") : "";
  if (provider === "github") {
    return {
      ...form,
      githubEnabled: true,
      githubConnection: form.githubConnection || autoConnection,
      githubDuration: form.githubDuration || DEFAULT_GITHUB_DURATION,
    };
  }
  if (provider === "slack" || provider === "discord") {
    const existing = form.tools[provider] ?? EMPTY_TOOL_GRANT;
    return {
      ...form,
      tools: {
        ...form.tools,
        [provider]: {
          ...existing,
          connection: existing.connection || autoConnection,
        },
      },
    };
  }
  const existing = form.integrationTools?.[provider] ?? EMPTY_INTEGRATION_TOOL_DRAFT;
  return {
    ...form,
    integrationTools: {
      ...form.integrationTools,
      [provider]: {
        ...existing,
        enabled: true,
        connection: existing.connection || autoConnection,
      },
    },
  };
}

/** Remove an integration grant and clear its form values. */
export function removeIntegrationAccess(
  form: TriggerFormValue,
  provider: IntegrationAccessProvider,
): TriggerFormValue {
  if (provider === "github") {
    const { githubEnabled: _removed, ...rest } = form;
    return {
      ...rest,
      githubConnection: "",
      githubRepositories: "",
      githubPermissions: "",
      githubDuration: "",
    };
  }
  if (provider === "slack" || provider === "discord") {
    const nextTools: TriggerFormValue["tools"] = {};
    for (const key of integrationProviders) {
      if (key === provider) continue;
      const grant = form.tools[key];
      if (grant !== undefined) nextTools[key] = grant;
    }
    return { ...form, tools: nextTools };
  }
  const nextIntegrationTools: Partial<Record<string, IntegrationToolFormDraft>> = {};
  for (const [key, draft] of Object.entries(form.integrationTools ?? {})) {
    if (key !== provider && draft !== undefined) nextIntegrationTools[key] = draft;
  }
  if (Object.keys(nextIntegrationTools).length === 0) {
    const { integrationTools: _removed, ...rest } = form;
    return rest;
  }
  return { ...form, integrationTools: nextIntegrationTools };
}

function connectionControlId(provider: IntegrationAccessProvider): string {
  return provider === "github" ? "trigger-github-connection" : `trigger-tools-${provider}`;
}

/**
 * What the run may reach beyond the daemon: one grant per integration, each scoped to a
 * connection. Nothing is granted until the author adds it.
 */
export function IntegrationAccess({
  form,
  connections,
  errors,
  disabled = false,
  onChange,
}: {
  form: TriggerFormValue;
  connections: TriggerSnapshot["connections"];
  errors: TriggerFieldErrors;
  disabled?: boolean;
  onChange: (value: TriggerFormValue) => void;
}) {
  const allProviders = integrationAccessProviders();
  const active = activeIntegrationProviders(form);
  const pendingFocusId = useRef<string | null>(null);
  const activeSet = new Set<IntegrationAccessProvider>(active);
  const activeProviders = allProviders.filter(({ provider }) => activeSet.has(provider));
  const remainingProviders = allProviders.filter(({ provider }) => !activeSet.has(provider));

  useEffect(() => {
    if (remainingProviders.length > 0) return undefined;
    const targetId = pendingFocusId.current;
    if (targetId === null) return undefined;
    const element = document.getElementById(targetId);
    if (element === null) return undefined;
    const frame = requestAnimationFrame(() => {
      pendingFocusId.current = null;
      element.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, remainingProviders.length]);

  const handleAdd = (provider: IntegrationAccessProvider) => {
    pendingFocusId.current = connectionControlId(provider);
    onChange(addIntegrationAccess(form, provider, connections));
  };

  const handleRemove = (provider: IntegrationAccessProvider) => {
    onChange(removeIntegrationAccess(form, provider));
  };

  const handleCloseAutoFocus = (event: Event) => {
    const targetId = pendingFocusId.current;
    if (targetId === null) return;
    event.preventDefault();
    pendingFocusId.current = null;
    document.getElementById(targetId)?.focus();
  };

  return (
    <div
      className={
        activeProviders.length === 0
          ? "flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"
          : "grid gap-4"
      }
    >
      {activeProviders.length === 0 ? (
        <p className="text-sm text-muted-foreground">No integrations granted</p>
      ) : (
        <div className="grid divide-y divide-border">
          {activeProviders.map((definition) => (
            <IntegrationGrantItem
              key={definition.provider}
              definition={definition}
              form={form}
              connections={connections}
              errors={errors}
              disabled={disabled}
              onChange={onChange}
              onRemove={() => handleRemove(definition.provider)}
            />
          ))}
        </div>
      )}
      {remainingProviders.length === 0 ? null : (
        <div className={activeProviders.length === 0 ? "flex shrink-0" : "flex border-t pt-4"}>
          <AddIntegrationMenu
            providers={remainingProviders}
            disabled={disabled}
            onAdd={handleAdd}
            onCloseAutoFocus={handleCloseAutoFocus}
          />
        </div>
      )}
    </div>
  );
}

function AddIntegrationMenu({
  providers,
  disabled,
  onAdd,
  onCloseAutoFocus,
}: {
  providers: readonly IntegrationAccessDefinition[];
  disabled: boolean;
  onAdd: (provider: IntegrationAccessProvider) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Plus aria-hidden="true" />
          Add integration
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48" onCloseAutoFocus={onCloseAutoFocus}>
        {providers.map((item) => (
          <DropdownMenuItem key={item.provider} onSelect={() => onAdd(item.provider)}>
            <ProviderGlyph provider={item.provider} />
            <span>{item.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IntegrationGrantItem({
  definition,
  form,
  connections,
  errors,
  disabled,
  onChange,
  onRemove,
}: {
  definition: IntegrationAccessDefinition;
  form: TriggerFormValue;
  connections: TriggerSnapshot["connections"];
  errors: TriggerFieldErrors;
  disabled: boolean;
  onChange: (value: TriggerFormValue) => void;
  onRemove: () => void;
}) {
  const headingId = `trigger-access-${definition.provider}-heading`;
  const providerConnections = connections.filter(
    (connection) => connection.provider === definition.provider,
  );
  return (
    <section aria-labelledby={headingId} className="grid min-w-0 gap-4 py-4 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted text-foreground"
          >
            <ProviderGlyph provider={definition.provider} />
          </span>
          <TwoLine
            primary={<span id={headingId}>{definition.label}</span>}
            secondary={definition.summary}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-mr-2.5"
          disabled={disabled}
          aria-label={`Remove ${definition.label}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      <AccessFieldsForProvider
        definition={definition}
        form={form}
        connections={providerConnections}
        errors={errors}
        disabled={disabled}
        onChange={onChange}
      />
    </section>
  );
}

function AccessFieldsForProvider({
  definition,
  form,
  connections,
  errors,
  disabled,
  onChange,
}: {
  definition: IntegrationAccessDefinition;
  form: TriggerFormValue;
  connections: TriggerSnapshot["connections"];
  errors: TriggerFieldErrors;
  disabled: boolean;
  onChange: (next: TriggerFormValue) => void;
}) {
  if (definition.provider === "github") {
    return (
      <GitHubAccessFields
        form={form}
        connections={connections}
        errors={errors}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }
  if (definition.provider === "slack" || definition.provider === "discord") {
    return (
      <ChannelToolAccessFields
        provider={definition.provider}
        label={definition.label}
        form={form}
        connections={connections}
        errors={errors}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }
  if (definition.integration?.tools !== undefined) {
    return (
      <RegisteredToolAccessFields
        integration={definition.integration}
        form={form}
        connections={connections}
        errors={errors}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }
  return null;
}

function connectionFieldDescription(
  label: string,
  connectionCount: number,
  selected: string,
): string | undefined {
  if (connectionCount === 0) return `No ${label} connection in this organization`;
  if (selected.trim() === "") return `Choose a ${label} connection to activate this grant`;
  return undefined;
}

function GitHubAccessFields({
  form,
  connections,
  errors,
  disabled,
  onChange,
}: {
  form: TriggerFormValue;
  connections: TriggerSnapshot["connections"];
  errors: TriggerFieldErrors;
  disabled: boolean;
  onChange: (value: TriggerFormValue) => void;
}) {
  const options = connections.map((connection) => ({
    value: connection.slug,
    label: connection.label,
  }));
  const connectionDescription = connectionFieldDescription(
    "GitHub",
    connections.length,
    form.githubConnection,
  );
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem]">
        <FormField
          id="trigger-github-connection"
          label="Connection"
          required
          {...(connectionDescription === undefined ? {} : { description: connectionDescription })}
          {...(errors.githubConnection === undefined ? {} : { error: errors.githubConnection })}
        >
          {(control) => (
            <Combobox
              {...control}
              required
              disabled={disabled}
              value={form.githubConnection}
              options={options}
              placeholder="Select a GitHub connection"
              empty="No GitHub connections found"
              onChange={(option) => onChange({ ...form, githubConnection: option.value })}
            />
          )}
        </FormField>
        <FormField
          id="trigger-github-repositories"
          label="Repositories"
          description="Comma-separated owner/repo names"
          kind="text"
          name="githubRepositories"
          placeholder="owner/repo"
          value={form.githubRepositories}
          disabled={disabled}
          onChange={(githubRepositories) => onChange({ ...form, githubRepositories })}
        />
        <FormField
          id="trigger-github-duration"
          label="Token lifetime"
          description="At most 1h"
          kind="text"
          name="githubDuration"
          placeholder="1h"
          value={form.githubDuration}
          disabled={disabled}
          onChange={(githubDuration) => onChange({ ...form, githubDuration })}
        />
      </div>
      <FormField
        id="trigger-github-permissions"
        label="Permissions (JSON)"
        description="Read-only repository contents when blank"
        {...(errors.githubPermissions === undefined ? {} : { error: errors.githubPermissions })}
      >
        {(control) => (
          <Textarea
            {...control}
            name="githubPermissions"
            rows={3}
            spellCheck={false}
            disabled={disabled}
            value={form.githubPermissions}
            placeholder={'{"contents":"write","pull_requests":"write"}'}
            className="font-mono text-xs"
            onChange={(event) => onChange({ ...form, githubPermissions: event.target.value })}
          />
        )}
      </FormField>
    </div>
  );
}

function ChannelToolAccessFields({
  provider,
  label,
  form,
  connections,
  errors,
  disabled,
  onChange,
}: {
  provider: IntegrationProvider;
  label: string;
  form: TriggerFormValue;
  connections: TriggerSnapshot["connections"];
  errors: TriggerFieldErrors;
  disabled: boolean;
  onChange: (value: TriggerFormValue) => void;
}) {
  const value = form.tools[provider] ?? EMPTY_TOOL_GRANT;
  const id = `trigger-tools-${provider}`;
  const options = connections.map(({ label: connectionLabel, slug }) => ({
    label: connectionLabel,
    value: slug,
  }));
  const update = (patch: Partial<IntegrationToolFormValue>) =>
    onChange({ ...form, tools: { ...form.tools, [provider]: { ...value, ...patch } } });
  const connectionError = errors[`tools.${provider}.connection`];
  const channelsError = errors[`tools.${provider}.channels`];
  const actionsError = errors[`tools.${provider}.actions`];
  const connectionDescription = connectionFieldDescription(
    label,
    connections.length,
    value.connection,
  );
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          id={id}
          label="Connection"
          required
          {...(connectionDescription === undefined ? {} : { description: connectionDescription })}
          {...(connectionError === undefined ? {} : { error: connectionError })}
        >
          {(control) => (
            <Combobox
              {...control}
              required
              disabled={disabled}
              value={value.connection}
              options={options}
              placeholder={`Select a ${label} connection`}
              empty={`No ${label} connections found`}
              onChange={(option) => update({ connection: option.value })}
            />
          )}
        </FormField>
        <FormField
          id={`${id}-channels`}
          label="Channel IDs"
          description={
            provider === "discord"
              ? "Comma-separated channel or forum IDs, whose threads inherit access"
              : "Comma-separated channel IDs"
          }
          kind="text"
          name={`${id}-channels`}
          placeholder={provider === "discord" ? "123456789012345678" : "C01234567"}
          value={value.channels}
          required
          disabled={disabled}
          onChange={(channels) => update({ channels })}
          {...(channelsError === undefined ? {} : { error: channelsError })}
        />
      </div>
      <fieldset className="min-w-0">
        <legend className="mb-2 text-sm text-foreground">Permissions</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {integrationActions.map((action) => (
            <CheckboxField
              key={action}
              id={`${id}-${action}`}
              label={TOOL_ACTION_LABELS[action]}
              checked={value.actions.includes(action)}
              disabled={disabled}
              onChange={(checked) =>
                update({
                  actions: checked
                    ? [...value.actions, action]
                    : value.actions.filter((item) => item !== action),
                })
              }
            />
          ))}
        </div>
        {actionsError === undefined ? null : (
          <p role="alert" className="mt-2 text-sm text-destructive">
            Select at least one permission
          </p>
        )}
      </fieldset>
    </div>
  );
}

function RegisteredToolAccessFields({
  integration,
  form,
  connections,
  errors,
  disabled,
  onChange,
}: {
  integration: BrowserIntegrationDefinition;
  form: TriggerFormValue;
  connections: TriggerSnapshot["connections"];
  errors: TriggerFieldErrors;
  disabled: boolean;
  onChange: (value: TriggerFormValue) => void;
}) {
  const tools = integration.tools!;
  const draft = form.integrationTools?.[integration.id] ?? EMPTY_INTEGRATION_TOOL_DRAFT;
  const id = `trigger-tools-${integration.id}`;
  const options = connections.map(({ label: connectionLabel, slug }) => ({
    label: connectionLabel,
    value: slug,
  }));
  const update = (patch: Partial<IntegrationToolFormDraft>) =>
    onChange({
      ...form,
      integrationTools: {
        ...form.integrationTools,
        [integration.id]: { ...draft, enabled: true, ...patch },
      },
    });
  const connectionError = errors[`tools.${integration.id}.connection`];
  const actionsError = errors[`tools.${integration.id}.actions`];
  const connectionDescription = connectionFieldDescription(
    integration.label,
    connections.length,
    draft.connection,
  );
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <FormField
          id={id}
          label="Connection"
          required
          {...(connectionDescription === undefined ? {} : { description: connectionDescription })}
          {...(connectionError === undefined ? {} : { error: connectionError })}
        >
          {(control) => (
            <Combobox
              {...control}
              required
              disabled={disabled}
              value={draft.connection}
              options={options}
              placeholder={`Select a ${integration.label} connection`}
              empty={`No ${integration.label} connections found`}
              onChange={(option) => update({ connection: option.value })}
            />
          )}
        </FormField>
        {tools.fields.map((field) => {
          const fieldError = errors[`tools.${integration.id}.${field.key}`];
          return (
            <FormField
              key={field.key}
              id={`${id}-${field.key}`}
              label={field.label}
              kind={field.multiline === true ? "multiline" : "text"}
              name={`${id}-${field.key}`}
              placeholder={field.placeholder}
              value={draft.fields[field.key] ?? ""}
              disabled={disabled}
              {...(field.description === undefined ? {} : { description: field.description })}
              {...(fieldError === undefined ? {} : { error: fieldError })}
              onChange={(nextValue) =>
                update({ fields: { ...draft.fields, [field.key]: nextValue } })
              }
            />
          );
        })}
      </div>
      <fieldset className="min-w-0">
        <legend className="mb-2 text-sm text-foreground">Permissions</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {tools.actions.map((action) => (
            <CheckboxField
              key={action.id}
              id={`${id}-${action.id}`}
              label={action.label}
              checked={draft.actions.includes(action.id)}
              disabled={disabled}
              onChange={(checked) =>
                update({
                  actions: checked
                    ? [...draft.actions, action.id]
                    : draft.actions.filter((item) => item !== action.id),
                })
              }
            />
          ))}
        </div>
        {actionsError === undefined ? null : (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {actionsError}
          </p>
        )}
      </fieldset>
    </div>
  );
}
