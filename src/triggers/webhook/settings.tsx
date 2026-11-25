import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Card } from "../../components/app/card.js";
import { ConfirmAction } from "../../components/app/confirm-action.js";
import { CopyBlock, CopyField } from "../../components/app/copy-field.js";
import { FailureAlert, WarningAlert } from "../../components/app/failure-alert.js";
import { Spinner } from "../../components/app/loading.js";
import { StatusPill } from "../../components/app/status-pill.js";
import { Button } from "../../components/ui/button.js";
import { ProviderGlyph } from "../../connections/provider-glyph.js";
import { rotateWebhookSecret } from "../functions.js";
import type { WebhookEndpoint, WebhookSecretAction } from "./index.js";

const WEBHOOK_ICON = <ProviderGlyph provider="webhook" />;
const SECRET_ACTIVE_PILL = <StatusPill tone="success">Secret active</StatusPill>;
const SECRET_REQUIRED_PILL = <StatusPill tone="warning">Secret required</StatusPill>;

export function WebhookSettings({
  organizationSlug,
  origin,
  endpoint,
  canManage,
  initialSecret,
}: {
  organizationSlug: string;
  origin: string;
  endpoint: WebhookEndpoint;
  canManage: boolean;
  /** The secret the endpoint was created with, for the one visit that created it. */
  initialSecret?: string;
}) {
  const rotate = useServerFn(rotateWebhookSecret);
  const queryClient = useQueryClient();
  // The one secret on screen for this visit: the one the endpoint was created with, until a
  // rotation replaces it. A failed rotation clears it, because the browser cannot tell a request
  // that never reached Hub from one whose answer was lost after it replaced the secret.
  const [shown, setShown] = useState(initialSecret);
  const secret = useMutation({
    mutationFn: (action: WebhookSecretAction) =>
      rotate({ data: { organizationSlug, triggerId: endpoint.triggerId, action } }),
    gcTime: 0,
    onSuccess: async (result) => {
      setShown(result.status === "ok" ? result.data.secret : undefined);
      await queryClient.invalidateQueries({ queryKey: ["triggers", organizationSlug] });
    },
    onError: () => setShown(undefined),
  });
  const { mutate } = secret;
  const createSecret = useCallback(() => mutate("create"), [mutate]);
  const rotateSecret = useCallback(() => mutate("rotate"), [mutate]);
  const failed = secret.data?.status === "error" || secret.isError;
  return (
    <WebhookSettingsView
      url={`${origin}/webhooks/${endpoint.endpointId}`}
      hasSecret={endpoint.hasSecret}
      {...(shown === undefined ? {} : { secret: shown })}
      canManage={canManage}
      pending={secret.isPending}
      {...(failed
        ? {
            error: { message: secret.data?.status === "error" ? secret.data.error.message : null },
          }
        : {})}
      onCreateSecret={createSecret}
      onRotateSecret={rotateSecret}
    />
  );
}

/**
 * The endpoint as the reader needs it: its URL, whether requests can authenticate, and a request
 * to copy. While a secret is on screen the request carries it, so the copied command runs as it
 * is; once only the hash is left, the request names the variable to fill in.
 */
export function WebhookSettingsView({
  url,
  hasSecret,
  secret,
  canManage,
  pending,
  error,
  onCreateSecret,
  onRotateSecret,
}: {
  url: string;
  hasSecret: boolean;
  /** The plaintext secret, only while it is shown once after creating or rotating it. */
  secret?: string;
  canManage: boolean;
  pending: boolean;
  error?: { message: string | null };
  onCreateSecret: () => void;
  onRotateSecret: () => void;
}) {
  return (
    <Card
      icon={WEBHOOK_ICON}
      title="Webhook endpoint"
      description="Send an authenticated POST request to start this trigger"
      action={hasSecret ? SECRET_ACTIVE_PILL : SECRET_REQUIRED_PILL}
    >
      <CopyField label="Webhook URL" value={url} />
      <div className="grid gap-3 border-t pt-4">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="grid min-w-0 gap-0.5">
            <p className="text-sm text-foreground">Bearer secret</p>
            <p className="text-xs text-muted-foreground">
              {hasSecret
                ? "Active. Rotating replaces the current secret immediately"
                : "Requests return 401 until you create a secret"}
            </p>
          </div>
          {canManage ? (
            <div className="shrink-0">
              {hasSecret ? (
                <ConfirmAction
                  label="Rotate secret"
                  title="Rotate webhook secret?"
                  description="The current secret stops working immediately. Update callers with the new secret after rotating"
                  confirmLabel="Rotate secret"
                  cancelLabel="Cancel"
                  destructive
                  busy={pending}
                  onConfirm={onRotateSecret}
                />
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  aria-busy={pending}
                  onClick={onCreateSecret}
                >
                  {pending ? <Spinner /> : null}
                  Create secret
                </Button>
              )}
            </div>
          ) : null}
        </div>
        {secret === undefined ? null : (
          <>
            <WarningAlert title="Save this secret now">
              Hub shows this secret only once. Store it before leaving this page
            </WarningAlert>
            <CopyField label="Webhook secret" value={secret} focusOnMount />
          </>
        )}
        {error === undefined ? null : (
          <FailureAlert
            title="Webhook secret unavailable"
            error={error.message}
            fallback="Try again"
          />
        )}
      </div>
      <div className="border-t pt-4">
        <CopyBlock
          label="Example request"
          action="Copy curl example"
          value={curlExample(url, secret)}
          {...(secret === undefined
            ? { description: secretPlaceholderHint(hasSecret, canManage) }
            : {})}
        />
      </div>
    </Card>
  );
}

function curlExample(url: string, secret: string | undefined): string {
  // A secret is base64url, so single quotes hold it as it is; the variable needs double quotes
  // for the shell to expand it.
  const authorization =
    secret === undefined
      ? `-H "Authorization: Bearer $WEBHOOK_SECRET"`
      : `-H 'Authorization: Bearer ${secret}'`;
  return [
    `curl -X POST '${url.replaceAll("'", "'\\''")}'`,
    `  ${authorization}`,
    "  -H 'Content-Type: application/json'",
    `  -d '{"alert":"example"}'`,
  ].join(" \\\n");
}

function secretPlaceholderHint(hasSecret: boolean, canManage: boolean): string {
  if (!hasSecret) return "Create a secret, then replace $WEBHOOK_SECRET with it";
  return canManage
    ? "Replace $WEBHOOK_SECRET with your saved secret, or rotate to generate a new one"
    : "Replace $WEBHOOK_SECRET with the saved secret";
}
