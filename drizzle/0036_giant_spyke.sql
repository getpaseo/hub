ALTER TABLE "discord_connections" ADD COLUMN "provider_application_id" text;--> statement-breakpoint
ALTER TABLE "github_connections" ADD COLUMN "provider_application_id" text;--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD COLUMN "provider_application_id" text;--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD COLUMN "provider_configuration_version" integer;--> statement-breakpoint
ALTER TABLE "slack_connections" ADD COLUMN "provider_application_id" text;