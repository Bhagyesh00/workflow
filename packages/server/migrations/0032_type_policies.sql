CREATE TABLE "type_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" varchar(512),
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "type_policies_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "type_policies_tenant_kind_name_unique" UNIQUE("tenant_id","kind","name"),
	CONSTRAINT "type_policies_kind_check" CHECK ("type_policies"."kind" in ('node', 'credential'))
);
--> statement-breakpoint
CREATE TABLE "type_policy_attachments" (
	"tenant_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"is_floor" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "type_policy_attachments_scope_id_policy_id_pk" PRIMARY KEY("scope_id","policy_id"),
	CONSTRAINT "type_policy_attachments_scope_floor_priority_unique" UNIQUE("scope_id","is_floor","priority")
);
--> statement-breakpoint
CREATE TABLE "type_policy_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"project_id" uuid,
	"default_action" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "type_policy_scopes_tenant_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "type_policy_scopes_kind_check" CHECK ("type_policy_scopes"."kind" in ('node', 'credential')),
	CONSTRAINT "type_policy_scopes_default_action_check" CHECK ("type_policy_scopes"."default_action" in ('allow', 'deny', 'delegate')),
	CONSTRAINT "type_policy_scopes_project_delegate_check" CHECK ("type_policy_scopes"."project_id" is null or "type_policy_scopes"."default_action" <> 'delegate')
);
--> statement-breakpoint
ALTER TABLE "type_policies" ADD CONSTRAINT "type_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "type_policy_attachments" ADD CONSTRAINT "type_policy_attachments_scope_fk" FOREIGN KEY ("tenant_id","scope_id") REFERENCES "public"."type_policy_scopes"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "type_policy_attachments" ADD CONSTRAINT "type_policy_attachments_policy_fk" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "public"."type_policies"("tenant_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "type_policy_scopes" ADD CONSTRAINT "type_policy_scopes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "type_policy_scopes" ADD CONSTRAINT "type_policy_scopes_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "type_policy_attachments_tenant_policy_idx" ON "type_policy_attachments" USING btree ("tenant_id","policy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "type_policy_scopes_tenant_kind_workspace_idx" ON "type_policy_scopes" USING btree ("tenant_id","kind") WHERE "type_policy_scopes"."project_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "type_policy_scopes_tenant_kind_project_idx" ON "type_policy_scopes" USING btree ("tenant_id","kind","project_id") WHERE "type_policy_scopes"."project_id" is not null;--> statement-breakpoint
ALTER TABLE "type_policy_scopes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "type_policy_scopes" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "type_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "type_policies" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "type_policy_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "type_policy_attachments" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
