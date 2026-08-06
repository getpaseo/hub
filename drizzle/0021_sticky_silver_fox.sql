ALTER TABLE "trigger_runs" ADD COLUMN "deadline_kind" text;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "deadline_kind" text;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD COLUMN "idle_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD CONSTRAINT "trigger_runs_deadline_kind_check" CHECK ("trigger_runs"."deadline_kind" is null or "trigger_runs"."deadline_kind" in ('step_hard', 'step_idle', 'whole_run'));--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD CONSTRAINT "trigger_runs_deadline_shape_check" CHECK (("trigger_runs"."outcome" = 'accepted' and "trigger_runs"."deadline_at" is not null)
        or ("trigger_runs"."outcome" = 'rejected' and "trigger_runs"."deadline_at" is null));--> statement-breakpoint
ALTER TABLE "workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_deadline_kind_check" CHECK ("workflow_step_runs"."deadline_kind" is null or "workflow_step_runs"."deadline_kind" in ('step_hard', 'step_idle', 'whole_run'));