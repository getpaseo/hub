CREATE TABLE "provider_event_routing_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider_event_receipt_id" uuid NOT NULL,
	"project_id" uuid,
	"configuration_revision_id" uuid,
	"trigger_name" text,
	"code" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_event_routing_decisions_code_check" CHECK ("provider_event_routing_decisions"."code" in ('no_trigger_for_source', 'connection_mismatch', 'resource_mismatch', 'repository_mismatch', 'guild_mismatch', 'workspace_mismatch', 'channel_mismatch', 'sender_not_allowed', 'contains_mismatch', 'pattern_mismatch', 'input_filter_mismatch', 'invocation_rejected', 'no_project_route')),
	CONSTRAINT "provider_event_routing_decisions_trigger_name_length_check" CHECK ("provider_event_routing_decisions"."trigger_name" is null or length("provider_event_routing_decisions"."trigger_name") <= 128),
	CONSTRAINT "provider_event_routing_decisions_summary_length_check" CHECK (length("provider_event_routing_decisions"."summary") <= 160)
);
--> statement-breakpoint
ALTER TABLE "provider_event_routing_decisions" ADD CONSTRAINT "provider_event_routing_decisions_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_event_routing_decisions" ADD CONSTRAINT "provider_event_routing_decisions_receipt_organization_fk" FOREIGN KEY ("provider_event_receipt_id","organization_id") REFERENCES "public"."provider_event_receipts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_event_routing_decisions" ADD CONSTRAINT "provider_event_routing_decisions_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_event_routing_decisions" ADD CONSTRAINT "provider_event_routing_decisions_revision_project_organization_fk" FOREIGN KEY ("configuration_revision_id","project_id","organization_id") REFERENCES "public"."project_configuration_revisions"("id","project_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_event_routing_decisions_receipt_idx" ON "provider_event_routing_decisions" USING btree ("provider_event_receipt_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_event_routing_decisions_candidate_unique" ON "provider_event_routing_decisions" USING btree ("provider_event_receipt_id","project_id","configuration_revision_id","trigger_name","code");