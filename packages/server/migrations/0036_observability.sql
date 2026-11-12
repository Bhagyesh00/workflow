CREATE TABLE "log_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"label" varchar(255) DEFAULT 'Log Destination' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"subscribed_events" text[] DEFAULT '{}' NOT NULL,
	"anonymize_audit_messages" boolean DEFAULT false NOT NULL,
	"circuit_breaker" jsonb,
	"credential_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_enc" text,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "log_destinations_type_check" CHECK ("log_destinations"."type" in ('webhook', 'syslog', 'sentry'))
);
--> statement-breakpoint
CREATE TABLE "log_stream_failed" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otel_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"exporter_protocol" text DEFAULT 'http/protobuf' NOT NULL,
	"exporter_endpoint" text DEFAULT '' NOT NULL,
	"exporter_tracing_path" text DEFAULT '/v1/traces' NOT NULL,
	"exporter_service_name" varchar(255) DEFAULT 'workflow' NOT NULL,
	"exporter_headers_enc" text,
	"traces_sample_rate" real DEFAULT 1 NOT NULL,
	"startup_connectivity_timeout_ms" integer DEFAULT 2000 NOT NULL,
	"include_node_spans" boolean DEFAULT true NOT NULL,
	"emit_workflow_start_span" boolean DEFAULT false NOT NULL,
	"emit_node_start_span" boolean DEFAULT false NOT NULL,
	"inject_outbound" boolean DEFAULT true NOT NULL,
	"production_executions_only" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "otel_settings_exporter_protocol_check" CHECK ("otel_settings"."exporter_protocol" in ('http/protobuf', 'grpc')),
	CONSTRAINT "otel_settings_traces_sample_rate_check" CHECK ("otel_settings"."traces_sample_rate" between 0 and 1)
);
--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "tracing_context" jsonb;--> statement-breakpoint
ALTER TABLE "log_destinations" ADD CONSTRAINT "log_destinations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_destinations" ADD CONSTRAINT "log_destinations_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_destinations" ADD CONSTRAINT "log_destinations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_stream_failed" ADD CONSTRAINT "log_stream_failed_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_stream_failed" ADD CONSTRAINT "log_stream_failed_destination_id_log_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."log_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otel_settings" ADD CONSTRAINT "otel_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "otel_settings" ADD CONSTRAINT "otel_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "log_destinations_tenant_idx" ON "log_destinations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "log_stream_failed_destination_idx" ON "log_stream_failed" USING btree ("destination_id","id");--> statement-breakpoint
CREATE INDEX "log_stream_failed_created_idx" ON "log_stream_failed" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "log_destinations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "log_destinations" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "log_stream_failed" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "log_stream_failed" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "otel_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "otel_settings" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
