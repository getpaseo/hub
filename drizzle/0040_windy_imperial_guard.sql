ALTER TABLE "runtime_provider_instances" DROP CONSTRAINT "runtime_provider_instances_reason_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_instances" ADD COLUMN "delayed_workspaces" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "runtime_provider_instances"
SET "state" = 'connected',
    "delayed_workspaces" = jsonb_build_array(
      jsonb_build_object('teamId', 'workspace', 'since', "observed_at")
    )
WHERE "state" = 'rate_limited';--> statement-breakpoint
ALTER TABLE "runtime_provider_instances" ADD CONSTRAINT "runtime_provider_instances_reason_check" CHECK ("runtime_provider_instances"."reason" is null or "runtime_provider_instances"."reason" in ('app_token_rejected', 'app_identity_mismatch', 'app_access_denied', 'socket_mode_off', 'connection_limit'));
