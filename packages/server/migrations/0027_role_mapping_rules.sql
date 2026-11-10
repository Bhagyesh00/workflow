CREATE TABLE "role_mapping_rule_projects" (
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "role_mapping_rule_projects_rule_id_project_id_pk" PRIMARY KEY("rule_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "role_mapping_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"expression" text NOT NULL,
	"role" text NOT NULL,
	"order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "role_mapping_rules_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "role_mapping_rules_tenant_type_order_unique" UNIQUE("tenant_id","type","order"),
	CONSTRAINT "role_mapping_rules_type_check" CHECK ("role_mapping_rules"."type" in ('instance', 'project'))
);
--> statement-breakpoint
ALTER TABLE "role_mapping_rule_projects" ADD CONSTRAINT "role_mapping_rule_projects_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."role_mapping_rules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_mapping_rule_projects" ADD CONSTRAINT "role_mapping_rule_projects_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_mapping_rules" ADD CONSTRAINT "role_mapping_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_mapping_rule_projects_tenant_project_idx" ON "role_mapping_rule_projects" USING btree ("tenant_id","project_id");--> statement-breakpoint
ALTER TABLE "role_mapping_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "role_mapping_rule_projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "role_mapping_rules" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "role_mapping_rule_projects" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
