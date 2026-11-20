import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "../../components/app/card.js";
import { Button } from "../../components/ui/button.js";
import { CopyField, CopyBlock } from "../../components/app/copy-field.js";
import { FailureAlert } from "../../components/app/failure-alert.js";
import { rotateWebhookSecret } from "../functions.js";
import type { WebhookEndpoint } from "./index.js";

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
    mutationFn: () => rotate({ data: { organizationSlug, triggerId: endpoint.triggerId } }),
    gcTime: 0,
    onSuccess: async (result) => {
      if (result.status === "ok") {
        await queryClient.invalidateQueries({ queryKey: ["triggers", organizationSlug] });
      }
    },
  });
  const { mutate } = secret;
  const issueSecret = useCallback(() => mutate(), [mutate]);
  const shown = secret.data?.status === "ok" ? secret.data.data.secret : undefined;
  const url = `${origin}/webhooks/${endpoint.endpointId}`;
  const curlUrl = url.replaceAll("'", "'\\''");
  return (
    <Card title="Webhook endpoint" className="mt-6">
      <CopyField label="Webhook URL" value={url} />
      <CopyBlock
        label="curl example"
        action="Copy curl example"
        value={`curl -X POST '${curlUrl}' \\\n  -H "Authorization: Bearer $WEBHOOK_SECRET" \\\n  -H 'Content-Type: application/json' \\\n  -d '{"alert":"example"}'`}
      />
      {shown === undefined ? null : (
        <div className="grid gap-2">
          <p className="text-sm">Copy this secret now. Hub shows it only once.</p>
          <CopyField label="Webhook secret" value={shown} focusOnMount />
        </div>
      )}
      {secret.data?.status === "error" || secret.isError ? (
        <FailureAlert
          title="Webhook secret unavailable"
          error={secret.data?.status === "error" ? secret.data.error.message : null}
          fallback="Try again."
        />
      ) : null}
      {canManage ? (
        <div className="grid gap-2 justify-items-start">
          {endpoint.hasSecret ? (
            <p className="text-sm text-muted-foreground">
              Rotating the secret immediately invalidates the previous one.
            </p>
          ) : null}
          <Button type="button" variant="outline" disabled={secret.isPending} onClick={issueSecret}>
            {endpoint.hasSecret ? "Rotate secret" : "Create secret"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
