CREATE TABLE "schedule_slots" (
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"node_name" text NOT NULL,
	"rule_key" text NOT NULL,
	"last_slot" timestamp with time zone NOT NULL,
	CONSTRAINT "schedule_slots_workflow_id_node_name_rule_key_pk" PRIMARY KEY("workflow_id","node_name","rule_key")
);
--> statement-breakpoint
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_slots" ADD CONSTRAINT "schedule_slots_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_slots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "schedule_slots" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
