ALTER TABLE "executions" ADD COLUMN "workflow_version_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD COLUMN "version_name" varchar(128);--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "published_version_id" uuid;--> statement-breakpoint
CREATE INDEX "executions_tenant_version_idx" ON "executions" USING btree ("tenant_id","workflow_version_id");--> statement-breakpoint
UPDATE "workflows" SET "published_version_id" = "version_id" WHERE "active";
