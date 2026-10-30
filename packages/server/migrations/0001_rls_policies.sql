-- Row-level security as defence in depth (ARCHITECTURE.md sections 5 and 10).
-- The application filters every query by tenant in its repositories and connects as the table
-- owner, which RLS does not restrict (no FORCE). Any other role (reporting, support tooling,
-- read replicas) only sees the rows of the tenant set in `app.tenant_id`:
--   SET app.tenant_id = '<tenant uuid>';
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships', 'sessions', 'invitations', 'api_keys', 'workflows', 'workflow_versions', 'tags',
    'workflow_tags', 'credentials', 'executions', 'execution_data', 'webhooks', 'variables', 'audit_log',
    'usage_counters', 'webhook_idempotency'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "tenants" USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
