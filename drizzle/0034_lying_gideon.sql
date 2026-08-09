CREATE TABLE "provider_event_routing_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider_event_receipt_id" uuid NOT NULL,
	"status" text NOT NULL,
	"expected_project_count" integer NOT NULL,
	"completed_project_count" integer DEFAULT 0 NOT NULL,
	"routed_project_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "provider_event_routing_outcomes_status_check" CHECK ("provider_event_routing_outcomes"."status" in ('pending', 'routed', 'dropped')),
	CONSTRAINT "provider_event_routing_outcomes_counts_check" CHECK ("provider_event_routing_outcomes"."expected_project_count" >= 0
        and "provider_event_routing_outcomes"."completed_project_count" >= 0
        and "provider_event_routing_outcomes"."completed_project_count" <= "provider_event_routing_outcomes"."expected_project_count"
        and "provider_event_routing_outcomes"."routed_project_count" >= 0
        and "provider_event_routing_outcomes"."routed_project_count" <= "provider_event_routing_outcomes"."completed_project_count"
        and (("provider_event_routing_outcomes"."status" = 'pending' and "provider_event_routing_outcomes"."finalized_at" is null)
          or ("provider_event_routing_outcomes"."status" in ('routed', 'dropped') and "provider_event_routing_outcomes"."finalized_at" is not null)))
);
--> statement-breakpoint
CREATE TABLE "provider_event_routing_project_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider_event_receipt_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"configuration_revision_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_event_routing_project_results_status_check" CHECK ("provider_event_routing_project_results"."status" in ('routed', 'dropped'))
);
--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_event_routing_outcomes" ADD CONSTRAINT "provider_event_routing_outcomes_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_event_routing_outcomes" ADD CONSTRAINT "provider_event_routing_outcomes_receipt_organization_fk" FOREIGN KEY ("provider_event_receipt_id","organization_id") REFERENCES "public"."provider_event_receipts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_event_routing_project_results" ADD CONSTRAINT "provider_event_routing_project_results_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_event_routing_project_results" ADD CONSTRAINT "provider_event_routing_project_results_receipt_organization_fk" FOREIGN KEY ("provider_event_receipt_id","organization_id") REFERENCES "public"."provider_event_receipts"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_event_routing_project_results" ADD CONSTRAINT "provider_event_routing_project_results_project_organization_fk" FOREIGN KEY ("project_id","organization_id") REFERENCES "public"."projects"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_event_routing_project_results" ADD CONSTRAINT "provider_event_routing_project_results_revision_project_organization_fk" FOREIGN KEY ("configuration_revision_id","project_id","organization_id") REFERENCES "public"."project_configuration_revisions"("id","project_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_event_routing_outcomes_receipt_unique" ON "provider_event_routing_outcomes" USING btree ("provider_event_receipt_id");--> statement-breakpoint
CREATE INDEX "provider_event_routing_outcomes_status_idx" ON "provider_event_routing_outcomes" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_event_routing_project_results_receipt_project_unique" ON "provider_event_routing_project_results" USING btree ("provider_event_receipt_id","project_id");--> statement-breakpoint
CREATE INDEX "provider_event_routing_project_results_receipt_idx" ON "provider_event_routing_project_results" USING btree ("provider_event_receipt_id","created_at");
--> statement-breakpoint
ALTER TABLE "provider_event_routing_decisions"
  DROP CONSTRAINT "provider_event_routing_decisions_code_check";--> statement-breakpoint
ALTER TABLE "provider_event_routing_decisions"
  ADD CONSTRAINT "provider_event_routing_decisions_code_check"
  CHECK ("provider_event_routing_decisions"."code" in ('no_trigger_for_source', 'connection_mismatch', 'resource_mismatch', 'repository_mismatch', 'guild_mismatch', 'workspace_mismatch', 'channel_mismatch', 'sender_not_allowed', 'contains_mismatch', 'pattern_mismatch', 'input_filter_mismatch', 'invocation_rejected', 'configuration_unavailable', 'no_project_route', 'routing_evidence_truncated'));--> statement-breakpoint
UPDATE "provider_event_receipts"
SET "payload" = NULL, "signature_hash" = NULL
WHERE "dropped_reason" IS NOT NULL
   OR "accepted_routes" IS NULL
   OR jsonb_typeof("accepted_routes") <> 'array'
   OR jsonb_array_length("accepted_routes") = 0
   OR NOT EXISTS (
     SELECT 1
     FROM "trigger_runs" run
     WHERE run."provider_event_receipt_id" = "provider_event_receipts"."id"
   );--> statement-breakpoint
WITH route_stats AS (
  SELECT receipt."id",
         count(route.value)::integer AS expected_project_count,
         count(route.value) FILTER (WHERE EXISTS (
           SELECT 1
           FROM "trigger_runs" run
           WHERE run."provider_event_receipt_id" = receipt."id"
             AND run."project_id"::text = route.value->>'projectId'
         ))::integer AS routed_project_count
  FROM "provider_event_receipts" receipt
  LEFT JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(receipt."accepted_routes") = 'array'
         THEN receipt."accepted_routes" ELSE '[]'::jsonb END
  ) route ON true
  GROUP BY receipt."id"
)
INSERT INTO "provider_event_routing_outcomes"
  ("organization_id", "provider_event_receipt_id", "status",
   "expected_project_count", "completed_project_count", "routed_project_count",
   "created_at", "finalized_at")
SELECT receipt."organization_id", receipt."id",
       CASE
         WHEN receipt."dropped_reason" IS NULL AND stats.routed_project_count > 0
         THEN 'routed' ELSE 'dropped'
       END,
       stats.expected_project_count,
       stats.expected_project_count,
       CASE WHEN receipt."dropped_reason" IS NULL
            THEN stats.routed_project_count ELSE 0 END,
       receipt."received_at", receipt."received_at"
FROM "provider_event_receipts" receipt
JOIN route_stats stats ON stats."id" = receipt."id"
ON CONFLICT ("provider_event_receipt_id") DO NOTHING;--> statement-breakpoint
DELETE FROM "attachment_capabilities" attachment
USING "provider_event_routing_outcomes" outcome
WHERE outcome."provider_event_receipt_id" = attachment."provider_event_receipt_id"
  AND outcome."status" = 'dropped';--> statement-breakpoint
INSERT INTO "provider_event_routing_project_results"
  ("organization_id", "provider_event_receipt_id", "project_id",
   "configuration_revision_id", "status", "created_at")
SELECT receipt."organization_id", receipt."id", route."projectId", route."configurationRevisionId",
       CASE WHEN EXISTS (
         SELECT 1
         FROM "trigger_runs" run
         WHERE run."provider_event_receipt_id" = receipt."id"
           AND run."project_id"::text = route."projectId"::text
       ) THEN 'routed' ELSE 'dropped' END,
       receipt."received_at"
FROM "provider_event_receipts" receipt
CROSS JOIN LATERAL jsonb_to_recordset(receipt."accepted_routes") AS route("projectId" uuid, "configurationRevisionId" uuid)
WHERE jsonb_typeof(receipt."accepted_routes") = 'array'
  AND jsonb_array_length(receipt."accepted_routes") > 0
ON CONFLICT ("provider_event_receipt_id", "project_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "provider_event_routing_decisions"
  ("organization_id", "provider_event_receipt_id", "project_id",
   "configuration_revision_id", "trigger_name", "code", "summary", "created_at")
SELECT receipt."organization_id", receipt."id", NULL, NULL, NULL,
       CASE WHEN receipt."dropped_reason" = 'provider_unrouted'
            THEN 'no_project_route' ELSE 'configuration_unavailable' END,
       CASE WHEN receipt."dropped_reason" = 'provider_unrouted'
            THEN 'No project route is configured for this event.'
            ELSE 'Trigger configuration is unavailable for this event.' END,
       receipt."received_at"
FROM "provider_event_receipts" receipt
JOIN "provider_event_routing_outcomes" outcome
  ON outcome."provider_event_receipt_id" = receipt."id"
WHERE outcome."status" = 'dropped'
  AND NOT EXISTS (
    SELECT 1 FROM "provider_event_routing_decisions" decision
    WHERE decision."provider_event_receipt_id" = receipt."id"
  );
