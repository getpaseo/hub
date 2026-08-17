CREATE TABLE "slack_workspace_delivery_observations" (
	"provider_application_id" text NOT NULL,
	"configuration_version" integer NOT NULL,
	"team_id" text NOT NULL,
	"delayed" boolean NOT NULL,
	"provider_observed_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_workspace_delivery_observations_provider_application_id_configuration_version_team_id_pk" PRIMARY KEY("provider_application_id","configuration_version","team_id"),
	CONSTRAINT "slack_workspace_delivery_observations_version_check" CHECK ("slack_workspace_delivery_observations"."configuration_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "runtime_provider_instances" DROP CONSTRAINT "runtime_provider_instances_reason_check";--> statement-breakpoint
UPDATE "runtime_provider_instances"
SET "reason" = 'workspace_access_denied'
WHERE "reason" = 'app_access_denied';--> statement-breakpoint
ALTER TABLE "runtime_provider_instances" ADD CONSTRAINT "runtime_provider_instances_reason_check" CHECK ("runtime_provider_instances"."reason" is null or "runtime_provider_instances"."reason" in ('app_token_rejected', 'app_identity_mismatch', 'workspace_access_denied', 'network_restricted', 'hub_configuration_invalid', 'socket_mode_off', 'connection_limit'));
