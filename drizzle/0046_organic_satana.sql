CREATE TABLE "linear_trigger_controls" (
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"suppression_reason" text,
	"suppression_occurred_at" timestamp with time zone,
	"source_provider_event_receipt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linear_trigger_controls_project_id_kind_external_id_pk" PRIMARY KEY("project_id","kind","external_id"),
	CONSTRAINT "linear_trigger_controls_kind_check" CHECK ("linear_trigger_controls"."kind" in ('comment', 'agent_session')),
	CONSTRAINT "linear_trigger_controls_suppression_check" CHECK (("linear_trigger_controls"."suppression_reason" is null and "linear_trigger_controls"."suppression_occurred_at" is null and "linear_trigger_controls"."source_provider_event_receipt_id" is null)
        or ("linear_trigger_controls"."kind" = 'comment' and "linear_trigger_controls"."suppression_reason" = 'superseded_by_agent_session' and "linear_trigger_controls"."suppression_occurred_at" is not null and "linear_trigger_controls"."source_provider_event_receipt_id" is not null)
        or ("linear_trigger_controls"."kind" = 'agent_session' and "linear_trigger_controls"."suppression_reason" = 'stopped_by_user' and "linear_trigger_controls"."suppression_occurred_at" is not null and "linear_trigger_controls"."source_provider_event_receipt_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "linear_trigger_controls" ADD CONSTRAINT "linear_trigger_controls_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "linear_trigger_controls_receipt_idx" ON "linear_trigger_controls" USING btree ("source_provider_event_receipt_id");