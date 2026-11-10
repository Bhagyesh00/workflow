CREATE TABLE "public_api_idempotency" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"key" varchar(128) NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"status_code" integer,
	"response_enc" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "public_api_idempotency_tenant_id_user_id_key_pk" PRIMARY KEY("tenant_id","user_id","key"),
	CONSTRAINT "public_api_idempotency_status_check" CHECK ("public_api_idempotency"."status" in ('in_progress', 'done'))
);
--> statement-breakpoint
ALTER TABLE "public_api_idempotency" ADD CONSTRAINT "public_api_idempotency_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_api_idempotency" ADD CONSTRAINT "public_api_idempotency_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "public_api_idempotency_created_idx" ON "public_api_idempotency" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "public_api_idempotency" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "public_api_idempotency" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
