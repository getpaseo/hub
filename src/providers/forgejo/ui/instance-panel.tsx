/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- operator instance forms bind submit per panel snapshot */
import type { FormEvent } from "react";
import { EmptyState } from "../../../components/app/empty-state.js";
import { StatusPill, type StatusTone } from "../../../components/app/status-pill.js";
import { Alert, AlertDescription } from "../../../components/ui/alert.js";
import { Button } from "../../../components/ui/button.js";
import { CheckboxInput } from "../../../components/ui/checkbox.js";
import { Field, FieldLabel } from "../../../components/ui/field.js";
import { Input } from "../../../components/ui/input.js";
import { ProviderGlyph } from "../../../connections/provider-glyph.js";

export interface ForgejoInstanceView {
  id: string;
  canonicalOrigin: string;
  reportedVersion: string;
  status:
    | "pending_verification"
    | "active"
    | "incompatible"
    | "unreachable"
    | "identity_drifted"
    | "revoked";
  lastHealthError: string | null;
  health: readonly {
    workKind: string;
    status: string;
    typedCause: string | null;
    nextAttemptAt: string | null;
    remediation: string;
  }[];
}

export function ForgejoInstancePanel({
  instances,
  error,
  canApprove,
  onApprove,
  onProbeHealth,
}: {
  instances: readonly ForgejoInstanceView[];
  error: string | null;
  canApprove: boolean;
  onApprove: (input: { origin: string; allowPrivateNetwork: boolean }) => void;
  onProbeHealth?: (instanceId: string) => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const origin = formString(form, "origin");
    onApprove({ origin, allowPrivateNetwork: form.get("allowPrivateNetwork") === "on" });
  };
  return (
    <section className="grid gap-4" aria-labelledby="forgejo-instances-heading">
      <header className="flex items-center gap-2">
        <ProviderGlyph provider="forgejo" />
        <h2 id="forgejo-instances-heading" className="text-sm font-medium">
          Forgejo instances
        </h2>
      </header>
      {error === null ? null : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {canApprove ? (
        <form aria-label="Approve Forgejo instance" className="grid gap-4" onSubmit={submit}>
          <Field>
            <FieldLabel htmlFor="forgejo-origin">Canonical HTTPS origin</FieldLabel>
            <Input
              id="forgejo-origin"
              name="origin"
              type="url"
              required
              placeholder="https://forgejo.example.test"
              autoComplete="off"
            />
          </Field>
          <label htmlFor="forgejo-allow-private" className="inline-flex items-center gap-2 text-sm">
            <CheckboxInput id="forgejo-allow-private" name="allowPrivateNetwork" />
            Allow Hub to reach a private network origin
          </label>
          <Button type="submit">Approve instance</Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only an instance operator can approve a Forgejo origin.
        </p>
      )}
      {instances.length === 0 ? (
        <EmptyState
          title="No approved instances"
          description="Approve a compatible Forgejo 16.0.3 origin before organizations connect."
        />
      ) : (
        <ul aria-label="Approved Forgejo instances" className="grid gap-2">
          {instances.map((instance) => (
            <li
              key={instance.id}
              className="flex items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="grid gap-1">
                <p className="text-sm">{instance.canonicalOrigin}</p>
                <p className="text-xs text-muted-foreground">{instance.reportedVersion}</p>
                {instance.lastHealthError === null ? null : (
                  <p className="text-xs text-destructive">{instance.lastHealthError}</p>
                )}
                {instance.health.map((row) => (
                  <p
                    key={`${row.workKind}:${row.status}`}
                    className="text-xs text-muted-foreground"
                  >
                    {row.workKind.replaceAll("_", " ")}: {row.status.replaceAll("_", " ")}
                    {row.typedCause === null ? "" : ` (${row.typedCause})`}
                    {row.nextAttemptAt === null ? "" : ` next ${row.nextAttemptAt}`}
                    {` · ${row.remediation.replaceAll("_", " ")}`}
                  </p>
                ))}
              </div>
              <div className="flex items-center gap-2">
                {onProbeHealth === undefined ? null : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onProbeHealth(instance.id)}
                  >
                    Check health
                  </Button>
                )}
                <StatusPill tone={instanceTone(instance.status)}>
                  {instance.status.replaceAll("_", " ")}
                </StatusPill>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function instanceTone(status: ForgejoInstanceView["status"]): StatusTone {
  if (status === "active") return "success";
  if (status === "pending_verification") return "neutral";
  return "danger";
}

function formString(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
