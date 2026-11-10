CREATE TABLE "oauth_jwe_keys" (
	"tenant_id" uuid NOT NULL,
	"kid" text NOT NULL,
	"private_enc" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oauth_jwe_keys_tenant_id_kid_pk" PRIMARY KEY("tenant_id","kid")
);
--> statement-breakpoint
ALTER TABLE "oauth_jwe_keys" ADD CONSTRAINT "oauth_jwe_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_jwe_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "oauth_jwe_keys" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
