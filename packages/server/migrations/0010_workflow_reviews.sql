CREATE TABLE "workflow_review_activity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_review_authors" (
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "workflow_review_authors_request_id_user_id_pk" PRIMARY KEY("request_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_review_comments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"activity_id" bigint NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_by" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_review_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid,
	"workflow_version_id" uuid,
	"approved_baseline_version_id" uuid,
	"state" text DEFAULT 'open' NOT NULL,
	"decision" text DEFAULT 'pending' NOT NULL,
	"title" varchar(128) NOT NULL,
	"description" text,
	"created_by" uuid,
	"updated_by" uuid,
	"closed_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "workflow_review_requests_state_check" CHECK ("workflow_review_requests"."state" in ('open', 'closed')),
	CONSTRAINT "workflow_review_requests_decision_check" CHECK ("workflow_review_requests"."decision" in ('pending', 'changes_requested', 'approved'))
);
--> statement-breakpoint
CREATE TABLE "workflow_review_reviewers" (
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "workflow_review_reviewers_request_id_user_id_pk" PRIMARY KEY("request_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "workflow_review_activity" ADD CONSTRAINT "workflow_review_activity_request_id_workflow_review_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."workflow_review_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_activity" ADD CONSTRAINT "workflow_review_activity_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_activity" ADD CONSTRAINT "workflow_review_activity_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_authors" ADD CONSTRAINT "workflow_review_authors_request_id_workflow_review_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."workflow_review_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_authors" ADD CONSTRAINT "workflow_review_authors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_authors" ADD CONSTRAINT "workflow_review_authors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_comments" ADD CONSTRAINT "workflow_review_comments_activity_id_workflow_review_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."workflow_review_activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_comments" ADD CONSTRAINT "workflow_review_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_comments" ADD CONSTRAINT "workflow_review_comments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_requests" ADD CONSTRAINT "workflow_review_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_requests" ADD CONSTRAINT "workflow_review_requests_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_requests" ADD CONSTRAINT "workflow_review_requests_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_requests" ADD CONSTRAINT "workflow_review_requests_approved_baseline_version_id_workflow_versions_id_fk" FOREIGN KEY ("approved_baseline_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_requests" ADD CONSTRAINT "workflow_review_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_requests" ADD CONSTRAINT "workflow_review_requests_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_requests" ADD CONSTRAINT "workflow_review_requests_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_reviewers" ADD CONSTRAINT "workflow_review_reviewers_request_id_workflow_review_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."workflow_review_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_reviewers" ADD CONSTRAINT "workflow_review_reviewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_review_reviewers" ADD CONSTRAINT "workflow_review_reviewers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_review_activity_request_idx" ON "workflow_review_activity" USING btree ("request_id","id");--> statement-breakpoint
CREATE INDEX "workflow_review_authors_user_idx" ON "workflow_review_authors" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "workflow_review_comments_activity_idx" ON "workflow_review_comments" USING btree ("activity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_review_requests_open_idx" ON "workflow_review_requests" USING btree ("workflow_id") WHERE "workflow_review_requests"."state" = 'open';--> statement-breakpoint
CREATE INDEX "workflow_review_requests_tenant_idx" ON "workflow_review_requests" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE INDEX "workflow_review_reviewers_user_idx" ON "workflow_review_reviewers" USING btree ("tenant_id","user_id");--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workflow_review_requests', 'workflow_review_reviewers', 'workflow_review_authors', 'workflow_review_activity',
    'workflow_review_comments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
