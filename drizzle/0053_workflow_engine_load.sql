ALTER TABLE "workflow_wakeups" ADD COLUMN "waiting_for_daemon_id" uuid;--> statement-breakpoint
-- IF NOT EXISTS lets a large installation build this index beforehand with
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS under the same name, so this migration then runs
-- without holding a write lock on agent_executions while the index builds.
CREATE INDEX IF NOT EXISTS "agent_executions_workflow_step_run_idx" ON "agent_executions" USING btree ("workflow_step_run_id");--> statement-breakpoint
-- Every row is null when this runs, so the partial index is empty and builds instantly.
CREATE INDEX "workflow_wakeups_waiting_daemon_idx" ON "workflow_wakeups" USING btree ("waiting_for_daemon_id") WHERE "workflow_wakeups"."waiting_for_daemon_id" is not null;
