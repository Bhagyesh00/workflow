-- (tenant_id, id) keys first: the composite foreign keys below point at them.
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_tenant_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "secret_connections" ADD CONSTRAINT "secret_connections_tenant_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_tenant_id_unique" UNIQUE("tenant_id","id");--> statement-breakpoint
CREATE TABLE "credential_shares" (
	"tenant_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"role" text DEFAULT 'credential:user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "credential_shares_credential_id_project_id_pk" PRIMARY KEY("credential_id","project_id")
);--> statement-breakpoint
CREATE TABLE "project_secret_access" (
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"role" text DEFAULT 'secretsProviderConnection:user' NOT NULL,
	CONSTRAINT "project_secret_access_connection_id_project_id_pk" PRIMARY KEY("connection_id","project_id")
);--> statement-breakpoint
CREATE TABLE "workflow_shares" (
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"role" text DEFAULT 'workflow:editor' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "workflow_shares_workflow_id_project_id_pk" PRIMARY KEY("workflow_id","project_id")
);--> statement-breakpoint
ALTER TABLE "secret_connections" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_credential_fk" FOREIGN KEY ("tenant_id","credential_id") REFERENCES "public"."credentials"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_secret_access" ADD CONSTRAINT "project_secret_access_connection_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."secret_connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_secret_access" ADD CONSTRAINT "project_secret_access_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_shares" ADD CONSTRAINT "workflow_shares_workflow_fk" FOREIGN KEY ("tenant_id","workflow_id") REFERENCES "public"."workflows"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_shares" ADD CONSTRAINT "workflow_shares_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_shares_tenant_project_idx" ON "credential_shares" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE INDEX "project_secret_access_tenant_project_idx" ON "project_secret_access" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE INDEX "workflow_shares_tenant_project_idx" ON "workflow_shares" USING btree ("tenant_id","project_id");--> statement-breakpoint
ALTER TABLE "secret_connections" ADD CONSTRAINT "secret_connections_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credential_shares" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_secret_access" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "workflow_shares" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "credential_shares" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "project_secret_access" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
