CREATE TABLE "credential_user_entries" (
	"tenant_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"data_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "credential_user_entries_credential_id_user_id_pk" PRIMARY KEY("credential_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "is_resolvable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "used_private_credentials" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_user_entries" ADD CONSTRAINT "credential_user_entries_credential_fk" FOREIGN KEY ("tenant_id","credential_id") REFERENCES "public"."credentials"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_user_entries" ADD CONSTRAINT "credential_user_entries_membership_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_user_entries_tenant_user_idx" ON "credential_user_entries" USING btree ("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "credential_user_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "credential_user_entries" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
