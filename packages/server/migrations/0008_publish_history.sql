CREATE TABLE "workflow_publish_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version_id" uuid,
	"event" text NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "workflow_publish_history_event_check" CHECK ("workflow_publish_history"."event" in ('activated', 'deactivated'))
);
--> statement-breakpoint
ALTER TABLE "workflow_publish_history" ADD CONSTRAINT "workflow_publish_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_publish_history" ADD CONSTRAINT "workflow_publish_history_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_publish_history" ADD CONSTRAINT "workflow_publish_history_version_id_workflow_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_publish_history" ADD CONSTRAINT "workflow_publish_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_publish_history_workflow_idx" ON "workflow_publish_history" USING btree ("tenant_id","workflow_id","id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "workflow_publish_history" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "workflow_publish_history" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
