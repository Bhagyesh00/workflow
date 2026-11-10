CREATE TABLE "insights_by_period" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meta_id" bigint NOT NULL,
	"type" smallint NOT NULL,
	"period_unit" smallint NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"value" bigint NOT NULL,
	CONSTRAINT "insights_by_period_unique" UNIQUE("tenant_id","meta_id","type","period_unit","period_start"),
	CONSTRAINT "insights_by_period_type_check" CHECK ("insights_by_period"."type" between 0 and 3),
	CONSTRAINT "insights_by_period_unit_check" CHECK ("insights_by_period"."period_unit" between 0 and 2)
);
--> statement-breakpoint
CREATE TABLE "insights_metadata" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid,
	"workflow_name" varchar(128) NOT NULL,
	"project_id" uuid,
	"project_name" varchar(255),
	CONSTRAINT "insights_metadata_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "insights_metadata_tenant_workflow_unique" UNIQUE("tenant_id","workflow_id")
);
--> statement-breakpoint
ALTER TABLE "insights_by_period" ADD CONSTRAINT "insights_by_period_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights_by_period" ADD CONSTRAINT "insights_by_period_meta_fk" FOREIGN KEY ("tenant_id","meta_id") REFERENCES "public"."insights_metadata"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights_metadata" ADD CONSTRAINT "insights_metadata_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights_metadata" ADD CONSTRAINT "insights_metadata_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights_metadata" ADD CONSTRAINT "insights_metadata_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "insights_by_period_tenant_unit_start_idx" ON "insights_by_period" USING btree ("tenant_id","period_unit","period_start");--> statement-breakpoint
ALTER TABLE "insights_metadata" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "insights_metadata" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "insights_by_period" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "insights_by_period" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
