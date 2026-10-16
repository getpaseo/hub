CREATE TABLE "github_installation_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"provider_application_id" text,
	"installation_id" bigint NOT NULL,
	"connection_id" uuid,
	"delivery_id" text,
	"signature_hash" text,
	"source" text,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "github_installation_syncs_delivery_id_unique" UNIQUE("delivery_id"),
	CONSTRAINT "github_installation_syncs_signature_hash_unique" UNIQUE("signature_hash"),
	CONSTRAINT "github_installation_syncs_evidence_check" CHECK ((
    "github_installation_syncs"."kind" = 'webhook' AND "github_installation_syncs"."provider_application_id" IS NOT NULL AND "github_installation_syncs"."delivery_id" IS NOT NULL AND "github_installation_syncs"."signature_hash" IS NOT NULL
    AND "github_installation_syncs"."source" IS NOT NULL AND "github_installation_syncs"."source" IN ('github.installation', 'github.installation_repositories') AND "github_installation_syncs"."payload" IS NOT NULL
  ) OR (
    "github_installation_syncs"."kind" = 'reconcile' AND "github_installation_syncs"."connection_id" IS NOT NULL AND "github_installation_syncs"."delivery_id" IS NULL
    AND "github_installation_syncs"."signature_hash" IS NULL AND "github_installation_syncs"."source" IS NULL AND "github_installation_syncs"."payload" IS NULL
  ))
);
--> statement-breakpoint
CREATE INDEX "github_installation_syncs_pending_idx" ON "github_installation_syncs" USING btree ("retry_at") WHERE "github_installation_syncs"."retry_at" is not null;
--> statement-breakpoint
-- Earlier callbacks bound installations without discovering repositories, including installations
-- whose lifecycle webhook arrived before the binding and was never recorded.
INSERT INTO github_installation_syncs (kind, provider_application_id, installation_id, connection_id)
SELECT 'reconcile', provider_application_id, installation_id, id FROM github_connections;
