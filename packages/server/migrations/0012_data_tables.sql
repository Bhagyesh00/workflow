CREATE TABLE "data_table_columns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"name" varchar(63) NOT NULL,
	"type" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "data_table_columns_table_name_unique" UNIQUE("table_id","name"),
	CONSTRAINT "data_table_columns_type_check" CHECK ("data_table_columns"."type" in ('string', 'number', 'boolean', 'date'))
);
--> statement-breakpoint
CREATE TABLE "data_table_rows" (
	"tenant_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"row_id" bigint NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "data_table_rows_table_id_row_id_pk" PRIMARY KEY("table_id","row_id")
);
--> statement-breakpoint
CREATE TABLE "data_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"next_row_id" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "data_tables_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "data_tables_tenant_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "user_favorites" DROP CONSTRAINT "user_favorites_resource_type_check";--> statement-breakpoint
ALTER TABLE "data_table_columns" ADD CONSTRAINT "data_table_columns_table_fk" FOREIGN KEY ("tenant_id","table_id") REFERENCES "public"."data_tables"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_table_rows" ADD CONSTRAINT "data_table_rows_table_fk" FOREIGN KEY ("tenant_id","table_id") REFERENCES "public"."data_tables"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_tables" ADD CONSTRAINT "data_tables_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_table_columns_table_position_idx" ON "data_table_columns" USING btree ("table_id","position");--> statement-breakpoint
CREATE INDEX "data_table_rows_tenant_table_idx" ON "data_table_rows" USING btree ("tenant_id","table_id");--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_resource_type_check" CHECK ("user_favorites"."resource_type" in ('workflow', 'folder', 'dataTable'));--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['data_tables', 'data_table_columns', 'data_table_rows'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
