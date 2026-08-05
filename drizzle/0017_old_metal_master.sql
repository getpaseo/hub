ALTER TABLE "triggers" DROP CONSTRAINT "triggers_lifecycle_state_check";--> statement-breakpoint
ALTER TABLE "triggers" DROP COLUMN "dispatch_plan";--> statement-breakpoint
ALTER TABLE "triggers" DROP COLUMN "lifecycle_state";