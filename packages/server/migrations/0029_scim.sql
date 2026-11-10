CREATE TABLE "scim_tokens" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "scim_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "managed_by_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_managed_by_tenant_id_tenants_id_fk" FOREIGN KEY ("managed_by_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_external_id_idx" ON "memberships" USING btree ("tenant_id","external_id") WHERE "memberships"."external_id" is not null;--> statement-breakpoint
ALTER TABLE "scim_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "scim_tokens" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
