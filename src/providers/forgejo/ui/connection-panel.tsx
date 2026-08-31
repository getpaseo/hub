/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- organization connection forms bind submit per panel snapshot */
import type { FormEvent } from "react";
import { EmptyState } from "../../../components/app/empty-state.js";
import { StatusPill } from "../../../components/app/status-pill.js";
import { Alert, AlertDescription } from "../../../components/ui/alert.js";
import { Button } from "../../../components/ui/button.js";
import { CheckboxInput } from "../../../components/ui/checkbox.js";
import { Field, FieldLabel } from "../../../components/ui/field.js";
import { Input } from "../../../components/ui/input.js";
import { ProviderGlyph } from "../../../connections/provider-glyph.js";

export interface ForgejoApprovedInstanceOption {
  id: string;
  canonicalOrigin: string;
  reportedVersion: string;
}

export interface ForgejoVisibleRepositoryView {
  repositoryId: number;
  fullName: string;
  htmlUrl: string;
  enrolled: boolean;
}

export interface ForgejoConnectionView {
  id: string;
  slug: string;
  instanceId: string;
  forgejoUserLogin: string;
  status: "pending_identity" | "active" | "degraded" | "disconnected";
  credentialMask: "••••";
  repositories: readonly ForgejoVisibleRepositoryView[];
  webhook?: ForgejoWebhookSetupView;
}

export interface ForgejoWebhookSetupView {
  callbackUrl: string;
  events: readonly string[];
  secret: string;
  hooks: readonly {
    repositoryId: number;
    fullName: string;
    htmlUrl: string;
    managed: boolean;
    status: string;
  }[];
}

export interface ForgejoDisconnectImpactView {
  connectionId: string;
  repositories: readonly { repositoryId: number; fullName: string; enrolled: boolean }[];
  hooks: readonly { repositoryId: number; managed: boolean; status: string }[];
  configurationSources: readonly { projectId: string; repositoryId: number }[];
  activeRevisions: readonly { projectId: string; revisionId: string }[];
  triggerRoutes: readonly { projectId: string; repositoryId: number }[];
  hydrationSignals: readonly { repositoryId: number }[];
  work: { queued: readonly { stepRunId: string }[]; inFlight: readonly { stepRunId: string }[] };
  futureExecution: "blocked";
}

export interface ForgejoDisconnectResultView {
  disconnected: true;
  impact: ForgejoDisconnectImpactView;
  cleanupStatus: "complete" | "REMOTE_CLEANUP_PENDING";
  cleanup: readonly {
    repositoryId: number;
    fullName: string | null;
    managed: boolean;
    result: "removed" | "preserved_manual" | "pending";
  }[];
}

export function ForgejoConnectionPanel({
  approvedInstances,
  connections,
  error,
  canConnect,
  onConnect,
  onEnroll,
  onSetupHooks,
  onRotateConnectionCredential,
  onRevokeConnectionCredential,
  onConfigureExecutionCredential,
  onRevokeExecutionCredential,
  onRotateWebhookSecret,
  onPreviewDisconnect,
  onDisconnect,
  disconnectImpact,
  disconnectResult,
}: {
  approvedInstances: readonly ForgejoApprovedInstanceOption[];
  connections: readonly ForgejoConnectionView[];
  error: string | null;
  canConnect: boolean;
  onConnect: (input: {
    instanceId: string;
    slug: string;
    claimedUsername: string;
    pat: string;
  }) => void;
  onEnroll: (input: { connectionId: string; repositoryIds: readonly number[] }) => void;
  onSetupHooks: (input: {
    connectionId: string;
    mode: "manual" | "automatic";
    adminPat?: string;
  }) => void;
  onRotateConnectionCredential: (input: {
    connectionId: string;
    pat: string;
    repositoryIds: readonly number[];
  }) => void;
  onRevokeConnectionCredential: (input: { connectionId: string }) => void;
  onConfigureExecutionCredential: (input: {
    connectionId: string;
    pat: string;
    scopes: readonly string[];
    repositories: readonly string[];
  }) => void;
  onRevokeExecutionCredential: (input: { connectionId: string }) => void;
  onRotateWebhookSecret: (input: { connectionId: string; webhookAdminPat: string }) => void;
  onPreviewDisconnect: (input: { connectionId: string }) => void;
  onDisconnect: (input: { connectionId: string; webhookAdminPat?: string }) => void;
  disconnectImpact: ForgejoDisconnectImpactView | null;
  disconnectResult: ForgejoDisconnectResultView | null;
}) {
  const submitConnection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onConnect({
      instanceId: formString(form, "instanceId"),
      slug: formString(form, "slug"),
      claimedUsername: formString(form, "claimedUsername"),
      pat: formString(form, "pat"),
    });
    const pat = event.currentTarget.elements.namedItem("pat");
    if (pat instanceof HTMLInputElement) pat.value = "";
  };
  return (
    <section className="grid gap-4" aria-labelledby="forgejo-connections-heading">
      <header className="flex items-center gap-2">
        <ProviderGlyph provider="forgejo" />
        <h2 id="forgejo-connections-heading" className="text-sm font-medium">
          Forgejo connections
        </h2>
      </header>
      {error === null ? null : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <ConnectionCreateForm
        canConnect={canConnect}
        approvedInstances={approvedInstances}
        onSubmit={submitConnection}
      />
      <ConnectionList
        connections={connections}
        canManage={canConnect}
        onEnroll={onEnroll}
        onSetupHooks={onSetupHooks}
        onRotateConnectionCredential={onRotateConnectionCredential}
        onRevokeConnectionCredential={onRevokeConnectionCredential}
        onConfigureExecutionCredential={onConfigureExecutionCredential}
        onRevokeExecutionCredential={onRevokeExecutionCredential}
        onRotateWebhookSecret={onRotateWebhookSecret}
        onPreviewDisconnect={onPreviewDisconnect}
        onDisconnect={onDisconnect}
        disconnectImpact={disconnectImpact}
        disconnectResult={disconnectResult}
      />
    </section>
  );
}

function ConnectionCreateForm({
  canConnect,
  approvedInstances,
  onSubmit,
}: {
  canConnect: boolean;
  approvedInstances: readonly ForgejoApprovedInstanceOption[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (!canConnect) {
    return (
      <p className="text-sm text-muted-foreground">
        Only an organization owner can create a Forgejo connection.
      </p>
    );
  }
  if (approvedInstances.length === 0) {
    return (
      <EmptyState
        title="No approved instances"
        description="Ask an instance operator to approve a Forgejo origin. Organizations cannot supply a URL."
      />
    );
  }
  return (
    <form aria-label="Create Forgejo connection" className="grid gap-4" onSubmit={onSubmit}>
      <Field>
        <FieldLabel htmlFor="forgejo-instance">Approved instance</FieldLabel>
        <select
          id="forgejo-instance"
          name="instanceId"
          required
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          {approvedInstances.map((instance) => (
            <option key={instance.id} value={instance.id}>
              {instance.canonicalOrigin} ({instance.reportedVersion})
            </option>
          ))}
        </select>
      </Field>
      <Field>
        <FieldLabel htmlFor="forgejo-slug">Connection slug</FieldLabel>
        <Input id="forgejo-slug" name="slug" required autoComplete="off" />
      </Field>
      <Field>
        <FieldLabel htmlFor="forgejo-username">Claimed Forgejo username</FieldLabel>
        <Input id="forgejo-username" name="claimedUsername" required autoComplete="off" />
      </Field>
      <Field>
        <FieldLabel htmlFor="forgejo-pat">Repository-limited PAT</FieldLabel>
        <Input
          id="forgejo-pat"
          name="pat"
          type="password"
          required
          autoComplete="off"
          placeholder="Write-only. Stored value is shown as ••••."
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        Allowed scopes: read:issue, write:issue, read:repository, write:repository. OAuth2,
        passwords, and unscoped tokens are rejected.
      </p>
      <Button type="submit">Connect Forgejo</Button>
    </form>
  );
}

function ConnectionList({
  connections,
  canManage,
  onEnroll,
  onSetupHooks,
  onRotateConnectionCredential,
  onRevokeConnectionCredential,
  onConfigureExecutionCredential,
  onRevokeExecutionCredential,
  onRotateWebhookSecret,
  onPreviewDisconnect,
  onDisconnect,
  disconnectImpact,
  disconnectResult,
}: {
  connections: readonly ForgejoConnectionView[];
  canManage: boolean;
  onEnroll: (input: { connectionId: string; repositoryIds: readonly number[] }) => void;
  onSetupHooks: (input: {
    connectionId: string;
    mode: "manual" | "automatic";
    adminPat?: string;
  }) => void;
  onRotateConnectionCredential: (input: {
    connectionId: string;
    pat: string;
    repositoryIds: readonly number[];
  }) => void;
  onRevokeConnectionCredential: (input: { connectionId: string }) => void;
  onConfigureExecutionCredential: (input: {
    connectionId: string;
    pat: string;
    scopes: readonly string[];
    repositories: readonly string[];
  }) => void;
  onRevokeExecutionCredential: (input: { connectionId: string }) => void;
  onRotateWebhookSecret: (input: { connectionId: string; webhookAdminPat: string }) => void;
  onPreviewDisconnect: (input: { connectionId: string }) => void;
  onDisconnect: (input: { connectionId: string; webhookAdminPat?: string }) => void;
  disconnectImpact: ForgejoDisconnectImpactView | null;
  disconnectResult: ForgejoDisconnectResultView | null;
}) {
  if (connections.length === 0) {
    return (
      <EmptyState
        title="No Forgejo connections"
        description="Connect with a repository-limited PAT, then enroll an explicit subset of visible repositories."
      />
    );
  }
  return (
    <ul aria-label="Forgejo connections" className="grid gap-3">
      {connections.map((connection) => (
        <ConnectionCard
          key={connection.id}
          connection={connection}
          canManage={canManage}
          onEnroll={onEnroll}
          onSetupHooks={onSetupHooks}
          onRotateConnectionCredential={onRotateConnectionCredential}
          onRevokeConnectionCredential={onRevokeConnectionCredential}
          onConfigureExecutionCredential={onConfigureExecutionCredential}
          onRevokeExecutionCredential={onRevokeExecutionCredential}
          onRotateWebhookSecret={onRotateWebhookSecret}
          onPreviewDisconnect={onPreviewDisconnect}
          onDisconnect={onDisconnect}
          disconnectImpact={disconnectImpact}
          disconnectResult={disconnectResult}
        />
      ))}
    </ul>
  );
}

function ConnectionCard({
  connection,
  canManage,
  onEnroll,
  onSetupHooks,
  onRotateConnectionCredential,
  onRevokeConnectionCredential,
  onConfigureExecutionCredential,
  onRevokeExecutionCredential,
  onRotateWebhookSecret,
  onPreviewDisconnect,
  onDisconnect,
  disconnectImpact,
  disconnectResult,
}: {
  connection: ForgejoConnectionView;
  canManage: boolean;
  onEnroll: (input: { connectionId: string; repositoryIds: readonly number[] }) => void;
  onSetupHooks: (input: {
    connectionId: string;
    mode: "manual" | "automatic";
    adminPat?: string;
  }) => void;
  onRotateConnectionCredential: (input: {
    connectionId: string;
    pat: string;
    repositoryIds: readonly number[];
  }) => void;
  onRevokeConnectionCredential: (input: { connectionId: string }) => void;
  onConfigureExecutionCredential: (input: {
    connectionId: string;
    pat: string;
    scopes: readonly string[];
    repositories: readonly string[];
  }) => void;
  onRevokeExecutionCredential: (input: { connectionId: string }) => void;
  onRotateWebhookSecret: (input: { connectionId: string; webhookAdminPat: string }) => void;
  onPreviewDisconnect: (input: { connectionId: string }) => void;
  onDisconnect: (input: { connectionId: string; webhookAdminPat?: string }) => void;
  disconnectImpact: ForgejoDisconnectImpactView | null;
  disconnectResult: ForgejoDisconnectResultView | null;
}) {
  const submitEnrollment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const repositoryIds = form
      .getAll("repositoryId")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value));
    onEnroll({ connectionId: connection.id, repositoryIds });
  };
  return (
    <li className="grid gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="grid gap-1">
          <p className="text-sm">{connection.slug}</p>
          <p className="text-xs text-muted-foreground">{connection.forgejoUserLogin}</p>
          <p className="text-xs text-muted-foreground">PAT {connection.credentialMask}</p>
        </div>
        <StatusPill tone={connection.status === "active" ? "success" : "warning"}>
          {connection.status.replaceAll("_", " ")}
        </StatusPill>
      </div>
      {connection.repositories.length === 0 ? (
        <p className="text-xs text-muted-foreground">No visible repositories.</p>
      ) : (
        <form
          aria-label={`Enroll repositories for ${connection.slug}`}
          className="grid gap-2"
          onSubmit={submitEnrollment}
        >
          {connection.repositories.map((repository) => (
            <label
              key={repository.repositoryId}
              htmlFor={`forgejo-repo-${String(repository.repositoryId)}`}
              className="inline-flex items-center gap-2 text-sm"
            >
              <CheckboxInput
                id={`forgejo-repo-${String(repository.repositoryId)}`}
                name="repositoryId"
                value={String(repository.repositoryId)}
                defaultChecked={repository.enrolled}
              />
              <a href={repository.htmlUrl} className="hover:underline">
                {repository.fullName}
              </a>
            </label>
          ))}
          <Button type="submit" variant="outline">
            Enroll selected repositories
          </Button>
        </form>
      )}
      <HookSetup connection={connection} canManage={canManage} onSetupHooks={onSetupHooks} />
      {canManage ? (
        <CredentialLifecycleControls
          connection={connection}
          onRotateConnectionCredential={onRotateConnectionCredential}
          onRevokeConnectionCredential={onRevokeConnectionCredential}
          onConfigureExecutionCredential={onConfigureExecutionCredential}
          onRevokeExecutionCredential={onRevokeExecutionCredential}
          onRotateWebhookSecret={onRotateWebhookSecret}
          onPreviewDisconnect={onPreviewDisconnect}
          onDisconnect={onDisconnect}
          disconnectImpact={disconnectImpact}
          disconnectResult={disconnectResult}
        />
      ) : null}
    </li>
  );
}

const EXECUTION_SCOPES = [
  "read:issue",
  "write:issue",
  "read:repository",
  "write:repository",
] as const;

function CredentialLifecycleControls({
  connection,
  onRotateConnectionCredential,
  onRevokeConnectionCredential,
  onConfigureExecutionCredential,
  onRevokeExecutionCredential,
  onRotateWebhookSecret,
  onPreviewDisconnect,
  onDisconnect,
  disconnectImpact,
  disconnectResult,
}: {
  connection: ForgejoConnectionView;
  onRotateConnectionCredential: (input: {
    connectionId: string;
    pat: string;
    repositoryIds: readonly number[];
  }) => void;
  onRevokeConnectionCredential: (input: { connectionId: string }) => void;
  onConfigureExecutionCredential: (input: {
    connectionId: string;
    pat: string;
    scopes: readonly string[];
    repositories: readonly string[];
  }) => void;
  onRevokeExecutionCredential: (input: { connectionId: string }) => void;
  onRotateWebhookSecret: (input: { connectionId: string; webhookAdminPat: string }) => void;
  onPreviewDisconnect: (input: { connectionId: string }) => void;
  onDisconnect: (input: { connectionId: string; webhookAdminPat?: string }) => void;
  disconnectImpact: ForgejoDisconnectImpactView | null;
  disconnectResult: ForgejoDisconnectResultView | null;
}) {
  const enrolled = connection.repositories.filter((repository) => repository.enrolled);
  const submitConnectionRotation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onRotateConnectionCredential({
      connectionId: connection.id,
      pat: formString(form, "connectionPat"),
      repositoryIds: enrolled.map((repository) => repository.repositoryId),
    });
    clearPasswordField(event.currentTarget, "connectionPat");
  };
  const submitExecutionCredential = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onConfigureExecutionCredential({
      connectionId: connection.id,
      pat: formString(form, "executionPat"),
      scopes: formStrings(form, "executionScope"),
      repositories: formStrings(form, "executionRepository"),
    });
    clearPasswordField(event.currentTarget, "executionPat");
  };
  const submitWebhookRotation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onRotateWebhookSecret({
      connectionId: connection.id,
      webhookAdminPat: formString(form, "webhookAdminPat"),
    });
    clearPasswordField(event.currentTarget, "webhookAdminPat");
  };
  const submitDisconnect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const webhookAdminPat = formString(form, "disconnectWebhookAdminPat");
    onDisconnect(
      webhookAdminPat.length === 0
        ? { connectionId: connection.id }
        : { connectionId: connection.id, webhookAdminPat },
    );
    clearPasswordField(event.currentTarget, "disconnectWebhookAdminPat");
  };
  return (
    <div className="grid gap-3 border-t pt-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium">Credential lifecycle</p>
        <Button
          type="button"
          variant="outline"
          onClick={() => onPreviewDisconnect({ connectionId: connection.id })}
        >
          Preview impact
        </Button>
      </div>
      {connection.status === "disconnected" ? null : (
        <>
          <form
            aria-label={`Rotate connection PAT for ${connection.slug}`}
            className="grid gap-2"
            onSubmit={submitConnectionRotation}
          >
            <Field>
              <FieldLabel htmlFor={`forgejo-connection-pat-${connection.id}`}>
                Replacement connection PAT
              </FieldLabel>
              <Input
                id={`forgejo-connection-pat-${connection.id}`}
                name="connectionPat"
                type="password"
                autoComplete="off"
                required
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline" disabled={enrolled.length === 0}>
                Rotate connection PAT
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onRevokeConnectionCredential({ connectionId: connection.id })}
              >
                Revoke connection PAT
              </Button>
            </div>
          </form>
          <form
            aria-label={`Configure execution PAT for ${connection.slug}`}
            className="grid gap-2"
            onSubmit={submitExecutionCredential}
          >
            <Field>
              <FieldLabel htmlFor={`forgejo-execution-pat-${connection.id}`}>
                Execution PAT
              </FieldLabel>
              <Input
                id={`forgejo-execution-pat-${connection.id}`}
                name="executionPat"
                type="password"
                autoComplete="off"
                required
              />
            </Field>
            <div className="grid gap-1 text-xs">
              {EXECUTION_SCOPES.map((scope) => (
                <label key={scope} className="inline-flex items-center gap-2">
                  <CheckboxInput
                    id={`forgejo-execution-scope-${connection.id}-${scope}`}
                    name="executionScope"
                    value={scope}
                    defaultChecked
                  />
                  {scope}
                </label>
              ))}
            </div>
            <div className="grid gap-1 text-xs">
              {enrolled.map((repository) => (
                <label key={repository.repositoryId} className="inline-flex items-center gap-2">
                  <CheckboxInput
                    id={`forgejo-execution-repository-${connection.id}-${String(repository.repositoryId)}`}
                    name="executionRepository"
                    value={repository.fullName}
                    defaultChecked
                  />
                  {repository.fullName}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline" disabled={enrolled.length === 0}>
                Save execution PAT
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onRevokeExecutionCredential({ connectionId: connection.id })}
              >
                Revoke execution PAT
              </Button>
            </div>
          </form>
          <form
            aria-label={`Rotate webhook secret for ${connection.slug}`}
            className="grid gap-2"
            onSubmit={submitWebhookRotation}
          >
            <Field>
              <FieldLabel htmlFor={`forgejo-webhook-rotation-pat-${connection.id}`}>
                One-time webhook-admin PAT
              </FieldLabel>
              <Input
                id={`forgejo-webhook-rotation-pat-${connection.id}`}
                name="webhookAdminPat"
                type="password"
                autoComplete="off"
                required
              />
            </Field>
            <Button type="submit" variant="outline">
              Rotate webhook secret
            </Button>
          </form>
        </>
      )}
      <ImpactPreview impact={disconnectImpact} connectionId={connection.id} />
      <CleanupResult result={disconnectResult} connectionId={connection.id} />
      <form
        aria-label={`Disconnect ${connection.slug}`}
        className="grid gap-2 border-t pt-3"
        onSubmit={submitDisconnect}
      >
        <Field>
          <FieldLabel htmlFor={`forgejo-disconnect-admin-pat-${connection.id}`}>
            One-time webhook-admin PAT
          </FieldLabel>
          <Input
            id={`forgejo-disconnect-admin-pat-${connection.id}`}
            name="disconnectWebhookAdminPat"
            type="password"
            autoComplete="off"
          />
        </Field>
        <Button type="submit" variant="destructive">
          Disconnect Forgejo
        </Button>
      </form>
    </div>
  );
}

function ImpactPreview({
  impact,
  connectionId,
}: {
  impact: ForgejoDisconnectImpactView | null;
  connectionId: string;
}) {
  if (impact === null || impact.connectionId !== connectionId) return null;
  return (
    <div className="grid gap-1 border-y py-2 text-xs" aria-live="polite">
      <p>
        {impact.repositories.length} repositories, {impact.hooks.length} hooks,{" "}
        {impact.configurationSources.length} configuration sources, {impact.triggerRoutes.length}{" "}
        routes
      </p>
      <p>
        {impact.activeRevisions.length} active revisions, {impact.hydrationSignals.length} hydration
        signals, {impact.work.queued.length} queued steps, {impact.work.inFlight.length} in-flight
        steps
      </p>
      <p>Future execution: {impact.futureExecution}</p>
    </div>
  );
}

function CleanupResult({
  result,
  connectionId,
}: {
  result: ForgejoDisconnectResultView | null;
  connectionId: string;
}) {
  if (result === null || result.impact.connectionId !== connectionId) return null;
  return (
    <div className="grid gap-1 border-y py-2 text-xs" aria-live="polite">
      <p>Remote cleanup: {result.cleanupStatus.replaceAll("_", " ")}</p>
      <ul aria-label="Forgejo remote cleanup results" className="grid gap-1">
        {result.cleanup.map((cleanup) => (
          <li key={cleanup.repositoryId}>
            {cleanup.fullName ?? `Repository ${String(cleanup.repositoryId)}`}:{" "}
            {cleanup.result.replaceAll("_", " ")}
          </li>
        ))}
      </ul>
    </div>
  );
}

function HookSetup({
  connection,
  canManage,
  onSetupHooks,
}: {
  connection: ForgejoConnectionView;
  canManage: boolean;
  onSetupHooks: (input: {
    connectionId: string;
    mode: "manual" | "automatic";
    adminPat?: string;
  }) => void;
}) {
  const enrolled = connection.repositories.some((repository) => repository.enrolled);
  if (!enrolled) return null;
  const submitAutomatic = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSetupHooks({
      connectionId: connection.id,
      mode: "automatic",
      adminPat: formString(form, "adminPat"),
    });
    const pat = event.currentTarget.elements.namedItem("adminPat");
    if (pat instanceof HTMLInputElement) pat.value = "";
  };
  return (
    <div className="grid gap-2 border-t pt-3">
      <p className="text-xs font-medium">Repository hooks</p>
      {connection.webhook === undefined ? null : (
        <div className="grid gap-1 text-xs text-muted-foreground">
          <p>
            Callback URL{" "}
            <code className="break-all text-foreground">{connection.webhook.callbackUrl}</code>
          </p>
          <p>Signing secret {connection.webhook.secret}</p>
          <p>Required events: {connection.webhook.events.join(", ")}</p>
          <ul aria-label={`Hook status for ${connection.slug}`} className="grid gap-1">
            {connection.webhook.hooks.map((hook) => (
              <li key={hook.repositoryId}>
                {hook.fullName}: {hook.status.replaceAll("_", " ")}
                {hook.managed ? " (managed)" : " (manual)"}
              </li>
            ))}
          </ul>
        </div>
      )}
      {canManage ? (
        <>
          <form
            aria-label={`Automatic hook setup for ${connection.slug}`}
            className="grid gap-2"
            onSubmit={submitAutomatic}
          >
            <Field>
              <FieldLabel htmlFor={`forgejo-admin-pat-${connection.id}`}>
                One-time webhook-admin PAT
              </FieldLabel>
              <Input
                id={`forgejo-admin-pat-${connection.id}`}
                name="adminPat"
                type="password"
                autoComplete="off"
                placeholder="Unscoped write:repository. Discarded after setup."
              />
            </Field>
            <Button type="submit" variant="outline">
              Configure hooks automatically
            </Button>
          </form>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onSetupHooks({ connectionId: connection.id, mode: "manual" })}
          >
            Configure hooks manually
          </Button>
        </>
      ) : null}
    </div>
  );
}

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function formStrings(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function clearPasswordField(form: HTMLFormElement, name: string): void {
  const field = form.elements.namedItem(name);
  if (field instanceof HTMLInputElement) field.value = "";
}
