CREATE TABLE "trigger_schedules" (
	"trigger_id" uuid PRIMARY KEY NOT NULL,
	"recurrence" jsonb,
	"next_at" timestamp with time zone,
	"active_run_id" uuid
);
--> statement-breakpoint
ALTER TABLE "provider_event_receipts" DROP CONSTRAINT "provider_event_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "trigger_schedules" ADD CONSTRAINT "trigger_schedules_trigger_id_organization_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."organization_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_schedules" ADD CONSTRAINT "trigger_schedules_active_run_id_trigger_runs_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."trigger_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trigger_schedules_due_idx" ON "trigger_schedules" USING btree ("next_at");--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_provider_check" CHECK ("provider_event_receipts"."provider" in ('github', 'slack', 'discord', 'linear', 'manual', 'schedule'));