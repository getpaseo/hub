CREATE TYPE "public"."forgejo_instance_flavor" AS ENUM('forgejo', 'gitea');--> statement-breakpoint
CREATE TABLE "forgejo_claimed_timeline_entries" (
	"connection_id" uuid NOT NULL,
	"timeline_entry_id" bigint NOT NULL,
	"receipt_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forgejo_claimed_timeline_entries_connection_id_timeline_entry_id_pk" PRIMARY KEY("connection_id","timeline_entry_id")
);
--> statement-breakpoint
CREATE TABLE "forgejo_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"instance_base_url" text NOT NULL,
	"instance_host" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"access_token" text NOT NULL,
	"account_login" text NOT NULL,
	"account_id" bigint NOT NULL,
	"instance_flavor" "forgejo_instance_flavor" NOT NULL,
	"instance_version" text NOT NULL,
	"hook_lease_id" uuid,
	"hook_lease_expires_at" timestamp with time zone,
	"connected_by_user_id" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forgejo_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"owner" text NOT NULL,
	"hook_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forgejo_webhooks_scope_check" CHECK ("forgejo_webhooks"."scope" in ('user', 'org'))
);
--> statement-breakpoint
ALTER TABLE "project_trigger_routes" DROP CONSTRAINT "project_trigger_routes_provider_check";--> statement-breakpoint
ALTER TABLE "provider_event_receipts" DROP CONSTRAINT "provider_event_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" DROP CONSTRAINT "runtime_provider_activation_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" DROP CONSTRAINT "runtime_provider_configuration_provider_check";--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD COLUMN "enrichment_pending_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "forgejo_claimed_timeline_entries" ADD CONSTRAINT "forgejo_claimed_timeline_entries_connection_id_forgejo_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."forgejo_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forgejo_claimed_timeline_entries" ADD CONSTRAINT "forgejo_claimed_timeline_entries_receipt_id_provider_event_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."provider_event_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forgejo_connections" ADD CONSTRAINT "forgejo_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forgejo_connections" ADD CONSTRAINT "forgejo_connections_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forgejo_webhooks" ADD CONSTRAINT "forgejo_webhooks_connection_id_forgejo_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."forgejo_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forgejo_claimed_timeline_entries_claimed_at_idx" ON "forgejo_claimed_timeline_entries" USING btree ("claimed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "forgejo_connections_id_organization_unique" ON "forgejo_connections" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forgejo_connections_organization_slug_unique" ON "forgejo_connections" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "forgejo_connections_organization_idx" ON "forgejo_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forgejo_connections_organization_instance_account_unique" ON "forgejo_connections" USING btree ("organization_id","instance_base_url","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forgejo_webhooks_connection_scope_owner_unique" ON "forgejo_webhooks" USING btree ("connection_id","scope","owner");--> statement-breakpoint
ALTER TABLE "project_trigger_routes" ADD CONSTRAINT "project_trigger_routes_provider_check" CHECK ("project_trigger_routes"."provider" in ('github', 'slack', 'discord', 'linear', 'forgejo'));--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_provider_check" CHECK ("provider_event_receipts"."provider" in ('github', 'slack', 'discord', 'linear', 'forgejo', 'manual', 'schedule'));--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" ADD CONSTRAINT "runtime_provider_activation_provider_check" CHECK ("runtime_provider_activation"."provider" in ('github', 'slack', 'discord', 'linear', 'forgejo'));--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" ADD CONSTRAINT "runtime_provider_configuration_provider_check" CHECK ("runtime_provider_configuration"."provider" in ('github', 'slack', 'discord', 'linear', 'forgejo'));