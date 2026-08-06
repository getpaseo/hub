-- Phase 6 destructive disposition: preserve identities, credentials, organization connections,
-- daemon enrollment, projects, and configuration-source authority only.
ALTER TABLE "triggers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "triggers" CASCADE;--> statement-breakpoint
DELETE FROM "workflow_wakeups";--> statement-breakpoint
DELETE FROM "workflow_step_runs";--> statement-breakpoint
DELETE FROM "trigger_runs";--> statement-breakpoint
DELETE FROM "agent_executions";--> statement-breakpoint
DELETE FROM "provider_event_receipts";--> statement-breakpoint
ALTER TABLE "agent_executions" DROP CONSTRAINT IF EXISTS "agent_executions_trigger_project_organization_fk";
--> statement-breakpoint
ALTER TABLE "trigger_runs" DROP CONSTRAINT IF EXISTS "trigger_runs_trigger_project_organization_fk";
--> statement-breakpoint
DROP INDEX "trigger_runs_trigger_configured_unique";--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "provider_event_receipt_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD CONSTRAINT "trigger_runs_receipt_organization_fk" FOREIGN KEY ("provider_event_receipt_id","organization_id") REFERENCES "public"."provider_event_receipts"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_runs_receipt_project_configured_unique" ON "trigger_runs" USING btree ("provider_event_receipt_id","project_id","configured_trigger_name");--> statement-breakpoint
ALTER TABLE "agent_executions" DROP COLUMN "trigger_id";--> statement-breakpoint
ALTER TABLE "agent_executions" DROP COLUMN "trigger_connection_id";--> statement-breakpoint
ALTER TABLE "agent_executions" DROP COLUMN "trigger_resource_id";--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "hub_action_ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trigger_runs" DROP COLUMN "trigger_id";
