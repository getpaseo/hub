CREATE UNIQUE INDEX "members_id_organization_unique" ON "member" USING btree ("id","organization_id");--> statement-breakpoint
CREATE TABLE "daemon_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"daemon_id" uuid NOT NULL,
	"member_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daemon_access_grants_role_check" CHECK ("daemon_access_grants"."role" in ('owner', 'operator', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "daemon_access_grants" ADD CONSTRAINT "daemon_access_grants_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daemon_access_grants" ADD CONSTRAINT "daemon_access_grants_daemon_organization_fk" FOREIGN KEY ("daemon_id","organization_id") REFERENCES "public"."daemons"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daemon_access_grants" ADD CONSTRAINT "daemon_access_grants_member_organization_fk" FOREIGN KEY ("member_id","organization_id") REFERENCES "public"."member"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "daemon_access_grants_daemon_member_unique" ON "daemon_access_grants" USING btree ("daemon_id","member_id");--> statement-breakpoint
CREATE INDEX "daemon_access_grants_organization_member_idx" ON "daemon_access_grants" USING btree ("organization_id","member_id");
