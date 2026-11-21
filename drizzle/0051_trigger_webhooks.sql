CREATE TABLE "trigger_webhooks" (
	"trigger_id" uuid PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"secret_hash" text,
	"window_started_at" timestamp with time zone,
	"window_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "trigger_webhooks_endpoint_id_unique" UNIQUE("endpoint_id")
);
--> statement-breakpoint
ALTER TABLE "provider_event_receipts" DROP CONSTRAINT "provider_event_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "trigger_webhooks" ADD CONSTRAINT "trigger_webhooks_trigger_id_organization_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."organization_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_provider_check" CHECK ("provider_event_receipts"."provider" in ('github', 'slack', 'discord', 'linear', 'manual', 'schedule', 'webhook'));