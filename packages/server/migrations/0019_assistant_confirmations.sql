CREATE TABLE "assistant_pending_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" text,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb NOT NULL,
	"input_type" text NOT NULL,
	"details" jsonb NOT NULL,
	"grant_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "assistant_pending_confirmations_thread_tool_call_unique" UNIQUE("thread_id","tool_call_id")
);
--> statement-breakpoint
ALTER TABLE "assistant_pending_confirmations" ADD CONSTRAINT "assistant_pending_confirmations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_pending_confirmations" ADD CONSTRAINT "assistant_pending_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_pending_confirmations" ADD CONSTRAINT "assistant_pending_confirmations_thread_id_assistant_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."assistant_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_pending_confirmations_tenant_user_status_idx" ON "assistant_pending_confirmations" USING btree ("tenant_id","user_id","status");--> statement-breakpoint
CREATE INDEX "assistant_pending_confirmations_expires_idx" ON "assistant_pending_confirmations" USING btree ("expires_at");--> statement-breakpoint
COMMENT ON COLUMN "assistant_pending_confirmations"."status" IS 'pending, approved, denied, expired or executed';--> statement-breakpoint
ALTER TABLE "assistant_pending_confirmations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "assistant_pending_confirmations" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
