CREATE TABLE "auth_provider_sync_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider_type" text NOT NULL,
	"run_mode" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"ended_at" timestamp with time zone,
	"scanned" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"disabled" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "auth_provider_sync_history" ADD CONSTRAINT "auth_provider_sync_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_provider_sync_history_tenant_started_idx" ON "auth_provider_sync_history" USING btree ("tenant_id","started_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "auth_provider_sync_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "auth_provider_sync_history" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
