import { useCallback } from "react";
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
const NO_SECRET_PILL = <StatusPill tone="neutral">No secret</StatusPill>;

export function WebhookSettings({
  organizationSlug,
  origin,
  endpoint,
  canManage,
}: {
  organizationSlug: string;
  origin: string;
  endpoint: WebhookEndpoint;
  canManage: boolean;
}) {
  const rotate = useServerFn(rotateWebhookSecret);
  const queryClient = useQueryClient();
  const secret = useMutation({
    mutationFn: (action: WebhookSecretAction) =>
      rotate({ data: { organizationSlug, triggerId: endpoint.triggerId, action } }),
    gcTime: 0,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["triggers", organizationSlug] });
    },
  });
  const { mutate } = secret;
  const createSecret = useCallback(() => mutate("create"), [mutate]);
  const rotateSecret = useCallback(() => mutate("rotate"), [mutate]);
  const shown = secret.data?.status === "ok" ? secret.data.data.secret : undefined;
  const url = `${origin}/webhooks/${endpoint.endpointId}`;
  const curlUrl = url.replaceAll("'", "'\\''");

  return (
    <Card
      icon={WEBHOOK_ICON}
      title="Webhook endpoint"
      description="Send an authenticated POST request to start this trigger"
      action={endpoint.hasSecret ? SECRET_ACTIVE_PILL : NO_SECRET_PILL}
    >
      <CopyField label="Webhook URL" value={url} />
      <div className="grid gap-3 border-t pt-4">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="grid min-w-0 gap-0.5">
            <p className="text-sm text-foreground">Bearer secret</p>
            <p className="text-xs text-muted-foreground">
              {endpoint.hasSecret
                ? "Active. Rotating replaces the current secret immediately"
                : "Create a secret to authenticate incoming POST requests"}
            </p>
          </div>
          {canManage ? (
            <div className="shrink-0">
              {endpoint.hasSecret ? (
                <ConfirmAction
                  label="Rotate secret"
                  title="Rotate webhook secret?"
                  description="The current secret stops working immediately. Update callers with the new secret after rotating"
                  confirmLabel="Rotate secret"
                  cancelLabel="Cancel"
                  destructive
                  busy={secret.isPending}
                  onConfirm={rotateSecret}
                />
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={secret.isPending}
                  aria-busy={secret.isPending}
                  onClick={createSecret}
                >
                  {secret.isPending ? <Spinner /> : null}
                  Create secret
                </Button>
              )}
            </div>
          ) : null}
        </div>
        {shown === undefined ? null : (
          <>
            <WarningAlert title="Save this secret now">
              Hub shows this secret only once. Store it before leaving this page
            </WarningAlert>
            <CopyField label="Webhook secret" value={shown} focusOnMount />
          </>
        )}
        {secret.data?.status === "error" || secret.isError ? (
          <FailureAlert
            title="Webhook secret unavailable"
            error={secret.data?.status === "error" ? secret.data.error.message : null}
            fallback="Try again"
          />
        ) : null}
      </div>
      <div className="border-t pt-4">
        <CopyBlock
          label="Example request"
          action="Copy curl example"
          value={`curl -X POST '${curlUrl}' \\\n  -H "Authorization: Bearer $WEBHOOK_SECRET" \\\n  -H 'Content-Type: application/json' \\\n  -d '{"alert":"example"}'`}
        />
      </div>
    </Card>
  );
}
