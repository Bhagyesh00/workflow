CREATE TABLE "annotation_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(24) NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_annotation_tags" (
	"execution_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "execution_annotation_tags_execution_id_tag_id_pk" PRIMARY KEY("execution_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "execution_annotations" (
	"execution_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vote" text,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "execution_annotations_vote_check" CHECK ("execution_annotations"."vote" in ('up', 'down'))
);
--> statement-breakpoint
ALTER TABLE "annotation_tags" ADD CONSTRAINT "annotation_tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_annotation_tags" ADD CONSTRAINT "execution_annotation_tags_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_annotation_tags" ADD CONSTRAINT "execution_annotation_tags_tag_id_annotation_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."annotation_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_annotation_tags" ADD CONSTRAINT "execution_annotation_tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_annotations" ADD CONSTRAINT "execution_annotations_execution_id_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_annotations" ADD CONSTRAINT "execution_annotations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "annotation_tags_tenant_name_idx" ON "annotation_tags" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "execution_annotation_tags_tag_idx" ON "execution_annotation_tags" USING btree ("tag_id");--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['annotation_tags', 'execution_annotations', 'execution_annotation_tags'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
