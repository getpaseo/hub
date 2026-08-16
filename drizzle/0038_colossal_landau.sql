CREATE TABLE "runtime_provider_instances" (
	"provider" text NOT NULL,
	"instance_id" text NOT NULL,
	"provider_application_id" text NOT NULL,
	"configuration_version" integer NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_provider_instances_provider_instance_id_pk" PRIMARY KEY("provider","instance_id"),
	CONSTRAINT "runtime_provider_instances_provider_check" CHECK ("runtime_provider_instances"."provider" in ('github', 'slack', 'discord')),
	CONSTRAINT "runtime_provider_instances_state_check" CHECK ("runtime_provider_instances"."state" in ('connecting', 'reconnecting', 'connected', 'action_needed', 'rate_limited')),
	CONSTRAINT "runtime_provider_instances_reason_check" CHECK ("runtime_provider_instances"."reason" is null or "runtime_provider_instances"."reason" in ('app_token_rejected', 'socket_mode_off', 'connection_limit')),
	CONSTRAINT "runtime_provider_instances_version_check" CHECK ("runtime_provider_instances"."configuration_version" >= 0)
);
--> statement-breakpoint
CREATE INDEX "runtime_provider_instances_observed_at_idx" ON "runtime_provider_instances" USING btree ("observed_at");
--> statement-breakpoint
UPDATE "runtime_provider_configuration"
SET "configuration" = jsonb_set("configuration", '{transport}', '"webhook"'::jsonb, true)
WHERE "provider" = 'slack' AND NOT ("configuration" ? 'transport');
