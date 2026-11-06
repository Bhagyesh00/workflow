CREATE TABLE "secret_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"type" text NOT NULL,
	"settings_enc" text NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'initializing' NOT NULL,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "secret_connections_tenant_provider_key_unique" UNIQUE("tenant_id","provider_key")
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "secret_keys" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "secret_connections" ADD CONSTRAINT "secret_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_connections" ADD CONSTRAINT "secret_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "secret_connections" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
