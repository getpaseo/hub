ALTER TABLE "trigger_runs" ADD COLUMN "terminal_notification_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "terminal_notification_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "terminal_notification_abandoned_at" timestamp with time zone;