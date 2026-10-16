CREATE TABLE "github_manifest_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_verifier" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"surface" text NOT NULL,
	"callback_origin" text NOT NULL,
	"expected_configuration_version" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "github_manifest_attempts_state_verifier_unique" UNIQUE("state_verifier")
);
--> statement-breakpoint
ALTER TABLE "github_manifest_attempts" ADD CONSTRAINT "github_manifest_attempts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_manifest_attempts" ADD CONSTRAINT "github_manifest_attempts_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_manifest_attempts_expiry_idx" ON "github_manifest_attempts" USING btree ("expires_at");