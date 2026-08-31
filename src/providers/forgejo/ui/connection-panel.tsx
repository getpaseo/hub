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

export function ForgejoConnectionPanel({
  approvedInstances,
  connections,
  error,
  canConnect,
  onConnect,
  onEnroll,
  onSetupHooks,
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
}: {
  connections: readonly ForgejoConnectionView[];
  canManage: boolean;
  onEnroll: (input: { connectionId: string; repositoryIds: readonly number[] }) => void;
  onSetupHooks: (input: {
    connectionId: string;
    mode: "manual" | "automatic";
    adminPat?: string;
  }) => void;
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
}: {
  connection: ForgejoConnectionView;
  canManage: boolean;
  onEnroll: (input: { connectionId: string; repositoryIds: readonly number[] }) => void;
  onSetupHooks: (input: {
    connectionId: string;
    mode: "manual" | "automatic";
    adminPat?: string;
  }) => void;
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
    </li>
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
