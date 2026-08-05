DROP INDEX "trigger_runs_trigger_unique";--> statement-breakpoint
UPDATE "agent_executions"
SET "workflow_step_run_id" = NULL
WHERE "workflow_step_run_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "workflow_step_runs";--> statement-breakpoint
DELETE FROM "workflow_wakeups";--> statement-breakpoint
DELETE FROM "trigger_runs";--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "configured_trigger_name" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_runs_trigger_configured_unique" ON "trigger_runs" USING btree ("trigger_id","configured_trigger_name");
