CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"organization_id" text NOT NULL,
	"provider_application_id" text,
	"slug" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credentials" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workspace_id" text,
	"connected_by_user_id" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connections_provider_check" CHECK ("integration_connections"."provider" ~ '^[a-z][a-z0-9_-]*$'),
	CONSTRAINT "integration_connections_status_check" CHECK ("integration_connections"."status" in ('active', 'suspended', 'requires_reauthorization'))
);
--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" DROP CONSTRAINT "organization_connection_attempts_provider_check";--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" DROP CONSTRAINT "organization_connection_attempts_phase_check";--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" DROP CONSTRAINT "organization_connection_attempts_shape_check";--> statement-breakpoint
ALTER TABLE "project_trigger_routes" DROP CONSTRAINT "project_trigger_routes_provider_check";--> statement-breakpoint
ALTER TABLE "provider_event_receipts" DROP CONSTRAINT "provider_event_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" DROP CONSTRAINT "runtime_provider_activation_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" DROP CONSTRAINT "runtime_provider_configuration_provider_check";--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_provider_external_unique" ON "integration_connections" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_organization_slug_unique" ON "integration_connections" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_id_organization_unique" ON "integration_connections" USING btree ("id","organization_id");--> statement-breakpoint
CREATE INDEX "integration_connections_organization_provider_idx" ON "integration_connections" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE INDEX "integration_connections_provider_workspace_idx" ON "integration_connections" USING btree ("provider","workspace_id") WHERE "integration_connections"."workspace_id" is not null;--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" ADD CONSTRAINT "organization_connection_attempts_provider_check" CHECK ("organization_connection_attempts"."provider" ~ '^[a-z][a-z0-9_-]*$');--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" ADD CONSTRAINT "organization_connection_attempts_phase_check" CHECK ("organization_connection_attempts"."phase" ~ '^[a-z][a-z0-9_]*$');--> statement-breakpoint
ALTER TABLE "organization_connection_attempts" ADD CONSTRAINT "organization_connection_attempts_shape_check" CHECK (("organization_connection_attempts"."phase" = 'github_setup' and "organization_connection_attempts"."provider" = 'github' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."pkce_verifier" is null and "organization_connection_attempts"."installation_choices" is null)
        or ("organization_connection_attempts"."phase" = 'github_user_authorization' and "organization_connection_attempts"."provider" = 'github' and ("organization_connection_attempts"."pkce_verifier" is not null or "organization_connection_attempts"."consumed_at" is not null) and "organization_connection_attempts"."installation_choices" is null)
        or ("organization_connection_attempts"."phase" = 'github_selection' and "organization_connection_attempts"."provider" = 'github' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."pkce_verifier" is null and "organization_connection_attempts"."installation_choices" is not null)
        or ("organization_connection_attempts"."provider" <> 'github' and "organization_connection_attempts"."candidate_external_id" is null and "organization_connection_attempts"."installation_choices" is null));--> statement-breakpoint
ALTER TABLE "project_trigger_routes" ADD CONSTRAINT "project_trigger_routes_provider_check" CHECK ("project_trigger_routes"."provider" ~ '^[a-z][a-z0-9_-]*$');--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_provider_check" CHECK ("provider_event_receipts"."provider" ~ '^[a-z][a-z0-9_-]*$');--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" ADD CONSTRAINT "runtime_provider_activation_provider_check" CHECK ("runtime_provider_activation"."provider" ~ '^[a-z][a-z0-9_-]*$');--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" ADD CONSTRAINT "runtime_provider_configuration_provider_check" CHECK ("runtime_provider_configuration"."provider" ~ '^[a-z][a-z0-9_-]*$');