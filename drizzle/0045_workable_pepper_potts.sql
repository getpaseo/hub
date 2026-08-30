CREATE TABLE "forgejo_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"instance_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"status" text NOT NULL,
	"forgejo_user_id" bigint NOT NULL,
	"forgejo_user_login" text NOT NULL,
	"provider_application_id" text,
	"connected_by_user_id" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	CONSTRAINT "forgejo_connections_status_check" CHECK ("forgejo_connections"."status" in ('pending_identity', 'active', 'degraded', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE "forgejo_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"alg" text NOT NULL,
	"key_id" integer NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"aad_version" integer NOT NULL,
	"scope_evidence" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "forgejo_credentials_kind_check" CHECK ("forgejo_credentials"."kind" in ('connection', 'execution', 'webhook_secret')),
	CONSTRAINT "forgejo_credentials_status_check" CHECK ("forgejo_credentials"."status" in ('active', 'rotating', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "forgejo_hydrated_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" bigint NOT NULL,
	"source_record_kind" text NOT NULL,
	"source_record_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forgejo_hydrated_events_subject_kind_check" CHECK ("forgejo_hydrated_events"."subject_kind" in ('issue', 'pull_request')),
	CONSTRAINT "forgejo_hydrated_events_source_record_kind_check" CHECK ("forgejo_hydrated_events"."source_record_kind" in ('timeline', 'review', 'review_comment', 'label'))
);
--> statement-breakpoint
CREATE TABLE "forgejo_hydration_cursors" (
	"connection_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" bigint NOT NULL,
	"record_kind" text NOT NULL,
	"cursor_record_id" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "forgejo_hydration_cursors_pk" PRIMARY KEY("connection_id","repository_id","subject_kind","subject_id","record_kind"),
	CONSTRAINT "forgejo_hydration_cursors_subject_kind_check" CHECK ("forgejo_hydration_cursors"."subject_kind" in ('issue', 'pull_request')),
	CONSTRAINT "forgejo_hydration_cursors_record_kind_check" CHECK ("forgejo_hydration_cursors"."record_kind" in ('timeline', 'review', 'review_comment'))
);
--> statement-breakpoint
CREATE TABLE "forgejo_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_origin" text NOT NULL,
	"allow_private_network" boolean DEFAULT false NOT NULL,
	"external_identity" jsonb NOT NULL,
	"reported_version" text NOT NULL,
	"status" text NOT NULL,
	"approved_by_user_id" text,
	"approved_at" timestamp with time zone,
	"last_health_at" timestamp with time zone,
	"last_health_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forgejo_instances_canonical_origin_unique" UNIQUE("canonical_origin"),
	CONSTRAINT "forgejo_instances_status_check" CHECK ("forgejo_instances"."status" in ('pending_verification', 'active', 'incompatible', 'unreachable', 'identity_drifted', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "forgejo_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"owner_login" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	"html_url" text NOT NULL,
	"enrolled" boolean DEFAULT false NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forgejo_repository_hooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"forgejo_hook_id" bigint,
	"callback_path" text NOT NULL,
	"managed" boolean NOT NULL,
	"status" text NOT NULL,
	"last_verified_at" timestamp with time zone,
	CONSTRAINT "forgejo_repository_hooks_status_check" CHECK ("forgejo_repository_hooks"."status" in ('unconfigured', 'pending_verification', 'active', 'manual_pending', 'drifted', 'cleanup_failed'))
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_kind_check";--> statement-breakpoint
ALTER TABLE "organization_trigger_revisions" DROP CONSTRAINT "organization_trigger_revisions_source_kind_check";--> statement-breakpoint
ALTER TABLE "project_configuration_revisions" DROP CONSTRAINT "project_configuration_revisions_source_kind_check";--> statement-breakpoint
ALTER TABLE "project_configuration_sources" DROP CONSTRAINT "project_configuration_sources_authority_shape_check";--> statement-breakpoint
ALTER TABLE "project_trigger_routes" DROP CONSTRAINT "project_trigger_routes_provider_check";--> statement-breakpoint
ALTER TABLE "provider_event_receipts" DROP CONSTRAINT "provider_event_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" DROP CONSTRAINT "runtime_provider_activation_provider_check";--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" DROP CONSTRAINT "runtime_provider_configuration_provider_check";--> statement-breakpoint
DROP INDEX "provider_event_receipts_organization_delivery_unique";--> statement-breakpoint
ALTER TABLE "configuration_sync_attempts" ADD COLUMN "forgejo_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "configuration_sync_attempts" ADD COLUMN "forgejo_repository_id" bigint;--> statement-breakpoint
ALTER TABLE "project_configuration_revisions" ADD COLUMN "forgejo_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "project_configuration_revisions" ADD COLUMN "forgejo_repository_id" bigint;--> statement-breakpoint
ALTER TABLE "project_configuration_revisions" ADD COLUMN "forgejo_commit_sha" text;--> statement-breakpoint
ALTER TABLE "project_configuration_revisions" ADD COLUMN "forgejo_commit_url" text;--> statement-breakpoint
ALTER TABLE "project_configuration_revisions" ADD COLUMN "forgejo_ref" text;--> statement-breakpoint
ALTER TABLE "project_configuration_revisions" ADD COLUMN "forgejo_webhook_delivery_id" text;--> statement-breakpoint
ALTER TABLE "project_configuration_revisions" ADD COLUMN "forgejo_sender" text;--> statement-breakpoint
ALTER TABLE "project_configuration_sources" ADD COLUMN "forgejo_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "project_configuration_sources" ADD COLUMN "forgejo_repository_id" bigint;--> statement-breakpoint
ALTER TABLE "project_configuration_sources" ADD COLUMN "forgejo_repository_full_name" text;--> statement-breakpoint
ALTER TABLE "project_configuration_sources" ADD COLUMN "forgejo_default_branch" text;--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD COLUMN "body_sha256" text;--> statement-breakpoint
ALTER TABLE "forgejo_connections" ADD CONSTRAINT "forgejo_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forgejo_connections" ADD CONSTRAINT "forgejo_connections_instance_id_forgejo_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."forgejo_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forgejo_connections" ADD CONSTRAINT "forgejo_connections_connected_by_user_id_user_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forgejo_instances" ADD CONSTRAINT "forgejo_instances_approved_by_user_id_user_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "forgejo_connections_id_organization_unique" ON "forgejo_connections" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forgejo_connections_organization_slug_unique" ON "forgejo_connections" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "forgejo_connections_organization_instance_user_unique" ON "forgejo_connections" USING btree ("organization_id","instance_id","forgejo_user_id");--> statement-breakpoint
ALTER TABLE "forgejo_credentials" ADD CONSTRAINT "forgejo_credentials_connection_organization_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."forgejo_connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forgejo_hydrated_events" ADD CONSTRAINT "forgejo_hydrated_events_connection_organization_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."forgejo_connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forgejo_hydration_cursors" ADD CONSTRAINT "forgejo_hydration_cursors_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."forgejo_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forgejo_repositories" ADD CONSTRAINT "forgejo_repositories_connection_organization_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."forgejo_connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forgejo_repository_hooks" ADD CONSTRAINT "forgejo_repository_hooks_connection_organization_fk" FOREIGN KEY ("connection_id","organization_id") REFERENCES "public"."forgejo_connections"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "forgejo_credentials_connection_kind_active_unique" ON "forgejo_credentials" USING btree ("connection_id","kind") WHERE "forgejo_credentials"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "forgejo_hydrated_events_source_unique" ON "forgejo_hydrated_events" USING btree ("connection_id","repository_id","subject_kind","subject_id","source_record_kind","source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forgejo_repositories_connection_repository_unique" ON "forgejo_repositories" USING btree ("connection_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forgejo_repository_hooks_connection_repository_unique" ON "forgejo_repository_hooks" USING btree ("connection_id","repository_id");--> statement-breakpoint
ALTER TABLE "configuration_sync_attempts" ADD CONSTRAINT "configuration_sync_attempts_forgejo_connection_organization_fk" FOREIGN KEY ("forgejo_connection_id","organization_id") REFERENCES "public"."forgejo_connections"("id","organization_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_configuration_sources" ADD CONSTRAINT "project_configuration_sources_forgejo_connection_organization_fk" FOREIGN KEY ("forgejo_connection_id","organization_id") REFERENCES "public"."forgejo_connections"("id","organization_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_event_receipts_forgejo_delivery_unique" ON "provider_event_receipts" USING btree ("provider","connection_id","delivery_id") WHERE "provider_event_receipts"."provider" = 'forgejo' AND "provider_event_receipts"."connection_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_event_receipts_organization_delivery_unique" ON "provider_event_receipts" USING btree ("organization_id","delivery_id") WHERE "provider_event_receipts"."provider" <> 'forgejo';--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_kind_check" CHECK ("audit_events"."actor_kind" in ('user', 'github', 'forgejo', 'system'));--> statement-breakpoint
ALTER TABLE "organization_trigger_revisions" ADD CONSTRAINT "organization_trigger_revisions_source_kind_check" CHECK ("organization_trigger_revisions"."source_kind" in ('manual', 'github', 'forgejo', 'project_migration'));--> statement-breakpoint
ALTER TABLE "project_configuration_revisions" ADD CONSTRAINT "project_configuration_revisions_source_kind_check" CHECK ("project_configuration_revisions"."source_kind" in ('github', 'manual', 'forgejo'));--> statement-breakpoint
ALTER TABLE "project_configuration_sources" ADD CONSTRAINT "project_configuration_sources_authority_shape_check" CHECK ((
        "project_configuration_sources"."kind" = 'manual'
        and "project_configuration_sources"."github_connection_id" is null
        and "project_configuration_sources"."github_repository_id" is null
        and "project_configuration_sources"."forgejo_connection_id" is null
        and "project_configuration_sources"."forgejo_repository_id" is null
        and not "project_configuration_sources"."automatic_deployment_enabled"
      ) or (
        "project_configuration_sources"."kind" = 'github'
        and "project_configuration_sources"."github_connection_id" is not null
        and "project_configuration_sources"."github_repository_id" is not null
        and "project_configuration_sources"."forgejo_connection_id" is null
        and "project_configuration_sources"."forgejo_repository_id" is null
      ) or (
        "project_configuration_sources"."kind" = 'forgejo'
        and "project_configuration_sources"."forgejo_connection_id" is not null
        and "project_configuration_sources"."forgejo_repository_id" is not null
        and "project_configuration_sources"."github_connection_id" is null
        and "project_configuration_sources"."github_repository_id" is null
      ));--> statement-breakpoint
ALTER TABLE "project_trigger_routes" ADD CONSTRAINT "project_trigger_routes_provider_check" CHECK ("project_trigger_routes"."provider" in ('github', 'slack', 'discord', 'linear', 'forgejo'));--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_provider_check" CHECK ("provider_event_receipts"."provider" in ('github', 'slack', 'discord', 'linear', 'forgejo', 'manual'));--> statement-breakpoint
ALTER TABLE "runtime_provider_activation" ADD CONSTRAINT "runtime_provider_activation_provider_check" CHECK ("runtime_provider_activation"."provider" in ('github', 'slack', 'discord', 'linear', 'forgejo'));--> statement-breakpoint
ALTER TABLE "runtime_provider_configuration" ADD CONSTRAINT "runtime_provider_configuration_provider_check" CHECK ("runtime_provider_configuration"."provider" in ('github', 'slack', 'discord', 'linear', 'forgejo'));