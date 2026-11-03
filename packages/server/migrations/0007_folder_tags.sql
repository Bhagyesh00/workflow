CREATE TABLE "folder_tags" (
	"folder_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "folder_tags_folder_id_tag_id_pk" PRIMARY KEY("folder_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "folder_tags" ADD CONSTRAINT "folder_tags_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_tags" ADD CONSTRAINT "folder_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_tags" ADD CONSTRAINT "folder_tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folder_tags_tag_idx" ON "folder_tags" USING btree ("tag_id");--> statement-breakpoint
ALTER TABLE "folder_tags" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "folder_tags" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
