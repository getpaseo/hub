CREATE TABLE "google_chat_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"provider_application_id" text,
	"slug" text NOT NULL,
	"app_name" text NOT NULL,
	"client_email" text NOT NULL,
	"connected_by_user_id" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_chat_connections_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "project_trigger_routes" DROP CONSTRAINT "project_trigger_routes_provider_check";--> statement-breakpoint
ALTER TABLE "provider_event_receipts" DROP CONSTRAINT "provider_event_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" DROP CONSTRAINT "runtime_provider_activation_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" DROP CONSTRAINT "runtime_provider_configuration_provider_check";--> statement-breakpoint
ALTER TABLE "google_chat_connections" ADD CONSTRAINT "google_chat_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_chat_connections" ADD CONSTRAINT "google_chat_connections_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_chat_connections_id_organization_unique" ON "google_chat_connections" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "google_chat_connections_organization_slug_unique" ON "google_chat_connections" USING btree ("organization_id","slug");--> statement-breakpoint
ALTER TABLE "project_trigger_routes" ADD CONSTRAINT "project_trigger_routes_provider_check" CHECK ("project_trigger_routes"."provider" in ('github', 'slack', 'discord', 'linear', 'google-chat'));--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_provider_check" CHECK ("provider_event_receipts"."provider" in ('github', 'slack', 'discord', 'linear', 'google-chat', 'manual', 'schedule'));--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" ADD CONSTRAINT "runtime_provider_activation_provider_check" CHECK ("runtime_provider_activation"."provider" in ('github', 'slack', 'discord', 'linear', 'google-chat'));--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" ADD CONSTRAINT "runtime_provider_configuration_provider_check" CHECK ("runtime_provider_configuration"."provider" in ('github', 'slack', 'discord', 'linear', 'google-chat'));