CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"continuation_key" text,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "agent_session_action" text;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "agent_session_id" uuid;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "conversation" jsonb;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_project_key_unique" ON "agent_sessions" USING btree ("project_id","continuation_key");--> statement-breakpoint
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_executions_session_idx" ON "agent_executions" USING btree ("agent_session_id");