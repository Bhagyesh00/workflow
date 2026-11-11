CREATE TABLE "source_control_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"repository_url" text,
	"connection_type" text DEFAULT 'ssh' NOT NULL,
	"branch_name" varchar(255) DEFAULT 'main' NOT NULL,
	"branch_color" varchar(16) DEFAULT '#5296D6' NOT NULL,
	"connected" boolean DEFAULT false NOT NULL,
	"key_type" text DEFAULT 'ed25519' NOT NULL,
	"public_key" text,
	"private_key_enc" text,
	"https_username" varchar(255),
	"https_password_enc" text,
	"host_key_fingerprint" text,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "source_control_settings_connection_type_check" CHECK ("source_control_settings"."connection_type" in ('ssh', 'https')),
	CONSTRAINT "source_control_settings_key_type_check" CHECK ("source_control_settings"."key_type" in ('ed25519', 'rsa'))
);
--> statement-breakpoint
CREATE TABLE "sync_id_map" (
	"tenant_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"git_id" varchar(64) NOT NULL,
	"local_id" uuid NOT NULL,
	"git_version_id" varchar(64),
	"local_version_id" varchar(64),
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "sync_id_map_tenant_id_resource_type_git_id_pk" PRIMARY KEY("tenant_id","resource_type","git_id"),
	CONSTRAINT "sync_id_map_tenant_resource_local_unique" UNIQUE("tenant_id","resource_type","local_id"),
	CONSTRAINT "sync_id_map_resource_type_check" CHECK ("sync_id_map"."resource_type" in ('workflow', 'credential', 'variable', 'tag', 'folder', 'datatable', 'project'))
);
--> statement-breakpoint
ALTER TABLE "source_control_settings" ADD CONSTRAINT "source_control_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_id_map" ADD CONSTRAINT "sync_id_map_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_control_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "source_control_settings" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "sync_id_map" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "sync_id_map" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
