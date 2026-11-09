-- Projects own the work (P6-01). Every workspace gets one team project that takes over all existing
-- workflows, credentials, folders and data tables, and every member gets a personal project.
INSERT INTO "projects" ("tenant_id", "name", "type") SELECT "id", left("name", 255), 'team' FROM "tenants";--> statement-breakpoint
INSERT INTO "projects" ("tenant_id", "name", "type", "owner_user_id", "creator_id")
SELECT m."tenant_id", left(u."name", 255), 'personal', m."user_id", m."user_id"
FROM "memberships" m JOIN "users" u ON u."id" = m."user_id";--> statement-breakpoint
INSERT INTO "project_relations" ("tenant_id", "project_id", "user_id", "role")
SELECT "tenant_id", "id", "owner_user_id", 'project:personalOwner' FROM "projects" WHERE "type" = 'personal'
ON CONFLICT ("project_id", "user_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "data_tables" ADD COLUMN "project_id" uuid;--> statement-breakpoint
UPDATE "workflows" x SET "project_id" = p."id" FROM "projects" p WHERE p."tenant_id" = x."tenant_id" AND p."type" = 'team';--> statement-breakpoint
UPDATE "credentials" x SET "project_id" = p."id" FROM "projects" p WHERE p."tenant_id" = x."tenant_id" AND p."type" = 'team';--> statement-breakpoint
UPDATE "folders" x SET "project_id" = p."id" FROM "projects" p WHERE p."tenant_id" = x."tenant_id" AND p."type" = 'team';--> statement-breakpoint
UPDATE "data_tables" x SET "project_id" = p."id" FROM "projects" p WHERE p."tenant_id" = x."tenant_id" AND p."type" = 'team';--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "data_tables" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "data_tables" DROP CONSTRAINT "data_tables_tenant_name_unique";--> statement-breakpoint
ALTER TABLE "user_favorites" DROP CONSTRAINT "user_favorites_resource_type_check";--> statement-breakpoint
DROP INDEX "variables_tenant_key_idx";--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "is_global" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "variables" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variables" ADD CONSTRAINT "variables_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credentials_tenant_project_type_idx" ON "credentials" USING btree ("tenant_id","project_id","type");--> statement-breakpoint
CREATE INDEX "folders_tenant_project_parent_idx" ON "folders" USING btree ("tenant_id","project_id","parent_folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variables_tenant_key_global_idx" ON "variables" USING btree ("tenant_id","key") WHERE "variables"."project_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "variables_tenant_project_key_idx" ON "variables" USING btree ("tenant_id","project_id","key") WHERE "variables"."project_id" is not null;--> statement-breakpoint
CREATE INDEX "workflows_tenant_project_updated_idx" ON "workflows" USING btree ("tenant_id","project_id","updated_at","id");--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_tenant_project_name_unique" UNIQUE("tenant_id","project_id","name");--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_resource_type_check" CHECK ("user_favorites"."resource_type" in ('workflow', 'folder', 'dataTable', 'project'));
