CREATE TABLE "auth_identities" (
	"tenant_id" uuid NOT NULL,
	"provider_type" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "auth_identities_tenant_id_provider_type_provider_id_pk" PRIMARY KEY("tenant_id","provider_type","provider_id"),
	CONSTRAINT "auth_identities_provider_type_check" CHECK ("auth_identities"."provider_type" in ('saml', 'oidc', 'ldap'))
);
--> statement-breakpoint
CREATE TABLE "tenant_auth_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"method" text DEFAULT 'email' NOT NULL,
	"saml" jsonb,
	"saml_metadata" text,
	"oidc" jsonb,
	"oidc_secret_enc" text,
	"ldap" jsonb,
	"ldap_password_enc" text,
	"provisioning" jsonb,
	"jit" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tenant_auth_settings_method_check" CHECK ("tenant_auth_settings"."method" in ('email', 'saml', 'oidc', 'ldap'))
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "allow_sso_manual_login" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auth_method" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_auth_settings" ADD CONSTRAINT "tenant_auth_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_identities_tenant_user_idx" ON "auth_identities" USING btree ("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "tenant_auth_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "tenant_auth_settings" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "auth_identities" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
