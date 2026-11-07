CREATE TABLE "test_case_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"test_run_id" uuid NOT NULL,
	"execution_id" uuid,
	"status" varchar(24) DEFAULT 'new' NOT NULL,
	"run_index" integer NOT NULL,
	"run_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" varchar(64),
	"error_details" jsonb,
	"metrics" jsonb,
	"inputs" jsonb,
	"outputs" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'new' NOT NULL,
	"run_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"metrics" jsonb,
	"error_code" varchar(64),
	"error_details" jsonb,
	"running_instance_id" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"workflow_version_id" uuid,
	"concurrency" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_case_executions" ADD CONSTRAINT "test_case_executions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_case_executions" ADD CONSTRAINT "test_case_executions_test_run_id_test_runs_id_fk" FOREIGN KEY ("test_run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_case_executions_run_idx" ON "test_case_executions" USING btree ("test_run_id","run_index");--> statement-breakpoint
CREATE INDEX "test_runs_tenant_workflow_idx" ON "test_runs" USING btree ("tenant_id","workflow_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "test_runs_active_status_idx" ON "test_runs" USING btree ("status") WHERE "test_runs"."status" in ('new', 'running');--> statement-breakpoint
ALTER TABLE "test_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "test_runs" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "test_case_executions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "test_case_executions" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
