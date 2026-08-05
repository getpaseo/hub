CREATE TABLE "trigger_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"configuration_revision_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"status" text NOT NULL,
	"raw_prompt" text NOT NULL,
	"prompt" text NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "trigger_runs_status_check" CHECK ("trigger_runs"."status" in ('running', 'succeeded', 'failed', 'timed_out'))
);
--> statement-breakpoint
CREATE TABLE "workflow_step_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"status" text NOT NULL,
	"agent_execution_id" uuid,
	"output" jsonb,
	"failure_reason" text,
	"dispatch_intent" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "workflow_step_runs_status_check" CHECK ("workflow_step_runs"."status" in ('pending', 'running', 'succeeded', 'skipped', 'failed', 'timed_out'))
);
--> statement-breakpoint
CREATE TABLE "workflow_wakeups" (
	"trigger_run_id" uuid PRIMARY KEY NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "workflow_step_run_id" uuid;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD CONSTRAINT "trigger_runs_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD CONSTRAINT "trigger_runs_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD CONSTRAINT "trigger_runs_revision_project_organization_fk" FOREIGN KEY ("configuration_revision_id","project_id","organization_id") REFERENCES "public"."project_configuration_revisions"("id","project_id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD CONSTRAINT "trigger_runs_trigger_project_organization_fk" FOREIGN KEY ("trigger_id","project_id","organization_id") REFERENCES "public"."triggers"("id","project_id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_trigger_run_fk" FOREIGN KEY ("trigger_run_id") REFERENCES "public"."trigger_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_wakeups" ADD CONSTRAINT "workflow_wakeups_trigger_run_fk" FOREIGN KEY ("trigger_run_id") REFERENCES "public"."trigger_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_runs_trigger_unique" ON "trigger_runs" USING btree ("trigger_id");--> statement-breakpoint
CREATE INDEX "trigger_runs_status_deadline_idx" ON "trigger_runs" USING btree ("status","deadline_at");--> statement-breakpoint
CREATE INDEX "trigger_runs_project_created_idx" ON "trigger_runs" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_step_runs_trigger_ordinal_unique" ON "workflow_step_runs" USING btree ("trigger_run_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_step_runs_trigger_step_unique" ON "workflow_step_runs" USING btree ("trigger_run_id","step_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_step_runs_agent_execution_unique" ON "workflow_step_runs" USING btree ("agent_execution_id") WHERE "workflow_step_runs"."agent_execution_id" is not null;--> statement-breakpoint
CREATE INDEX "workflow_step_runs_trigger_status_idx" ON "workflow_step_runs" USING btree ("trigger_run_id","status");--> statement-breakpoint
CREATE INDEX "workflow_wakeups_available_lease_idx" ON "workflow_wakeups" USING btree ("available_at","lease_expires_at");--> statement-breakpoint
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_workflow_step_run_fk" FOREIGN KEY ("workflow_step_run_id") REFERENCES "public"."workflow_step_runs"("id") ON DELETE no action ON UPDATE no action;