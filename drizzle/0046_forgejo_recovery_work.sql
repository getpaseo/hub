CREATE TABLE "forgejo_recovery_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"work_kind" text NOT NULL,
	"work_identity" text NOT NULL,
	"status" text NOT NULL,
	"typed_cause" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claimed_by" text,
	"claim_expires_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"scope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forgejo_recovery_work_kind_check" CHECK ("forgejo_recovery_work"."work_kind" in ('instance_health', 'connection_health', 'repository_health', 'hook_health', 'receipt_dispatch', 'hydration_signal', 'remote_cleanup')),
	CONSTRAINT "forgejo_recovery_work_status_check" CHECK ("forgejo_recovery_work"."status" in ('ready', 'claimed', 'succeeded', 'retry_scheduled', 'failed_permanent', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "forgejo_recovery_work" ADD CONSTRAINT "forgejo_recovery_work_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "forgejo_recovery_work_identity_unique" ON "forgejo_recovery_work" USING btree ("work_kind","work_identity");--> statement-breakpoint
CREATE INDEX "forgejo_recovery_work_due_idx" ON "forgejo_recovery_work" USING btree ("next_attempt_at") WHERE "forgejo_recovery_work"."status" in ('ready', 'retry_scheduled');