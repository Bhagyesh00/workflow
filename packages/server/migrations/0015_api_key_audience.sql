ALTER TABLE "api_keys" ADD COLUMN "audience" text DEFAULT 'public-api' NOT NULL;--> statement-breakpoint
CREATE INDEX "api_keys_tenant_user_audience_idx" ON "api_keys" USING btree ("tenant_id","user_id","audience");
