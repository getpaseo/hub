ALTER TABLE "trigger_runs" DROP CONSTRAINT "trigger_runs_status_check";--> statement-breakpoint
ALTER TABLE "trigger_runs" ALTER COLUMN "deadline_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "outcome" text DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "rejection" jsonb;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD CONSTRAINT "trigger_runs_outcome_check" CHECK (("trigger_runs"."outcome" = 'accepted' and "trigger_runs"."status" <> 'rejected' and "trigger_runs"."rejection" is null)
        or ("trigger_runs"."outcome" = 'rejected' and "trigger_runs"."status" = 'rejected' and "trigger_runs"."rejection" is not null));--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD CONSTRAINT "trigger_runs_status_check" CHECK ("trigger_runs"."status" in ('running', 'succeeded', 'failed', 'timed_out', 'rejected'));
