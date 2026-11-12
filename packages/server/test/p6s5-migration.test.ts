/**
 * Phase 6 S5 contract step (C0b): migration 0036 (log streaming destinations, failed events, OpenTelemetry
 * settings, `executions.tracing_context`) and the FULL repository methods C0 ships: `listEnabledAcrossTenants`,
 * `setTracingContext` and `tracingContextOf`. It rebuilds its own database from 0000 with the real migrator and
 * checks what Postgres holds, by raw SQL and through the repository classes (they need only `db`).
 *
 * It drops the `public` schema, so it only ever runs against `workflow_test_p6_s5_migrate` (the host of
 * TEST_DATABASE_URL, the database name replaced) and refuses any other database.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, migrationsFolder, runMigrations } from '../src/db/client';
import { ExecutionRepository, type TracingContextRow } from '../src/repositories/executions';
import { LogDestinationRepository } from '../src/repositories/log-destinations';
import { LogStreamFailedRepository } from '../src/repositories/log-stream-failed';

const MIGRATE_DB = 'workflow_test_p6_s5_migrate';
const NEW_TAG = '0036_observability';
/** the tenant tables of S5: RLS with the tenant_isolation policy */
const TENANT_TABLES = ['log_destinations', 'log_stream_failed', 'otel_settings'];
const POLICY = "(tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)";
const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';

function migrateUrl(): string {
  const url = new URL(
    process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/workflow_test',
  );
  url.pathname = `/${MIGRATE_DB}`;
  return url.toString();
}

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

const journal = (): JournalEntry[] =>
  (
    JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries: JournalEntry[];
    }
  ).entries;

const statements = (tag: string): string[] =>
  readFileSync(path.join(migrationsFolder, `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

let database: Database;
let pool: pg.Pool;

/**
 * runs `work` in a transaction that is always rolled back; returns the Postgres error code, if any. Any other
 * error (a failed expect inside `work`) is thrown, so it fails the test.
 */
async function codeOf(work: (client: pg.PoolClient) => Promise<unknown>): Promise<string | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await work(client);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      return undefined;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) throw error;
      return code;
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }
}

async function one<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pool.query<T>(sql, params);
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function countOf(table: string, where: string, params: unknown[]): Promise<number> {
  return (await one<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, params)).n;
}

interface Workspace {
  tenantId: string;
  owner: string;
  projectId: string;
}

let seq = 0;

/** a workspace: an owner and a team project */
async function seedWorkspace(label: string): Promise<Workspace> {
  const n = ++seq;
  const { tenantId } = await one<{ tenantId: string }>(
    'insert into tenants (name, slug) values ($1, $2) returning id as "tenantId"',
    [`Workspace ${label}`, `ws-${label.toLowerCase()}-${n}`],
  );
  const { id: owner } = await one<{ id: string }>(
    `insert into users (email, name, password_hash) values ($1, $2, 'x') returning id`,
    [`owner-${label.toLowerCase()}-${n}@example.com`, `owner ${label}`],
  );
  await pool.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'owner')`, [
    tenantId,
    owner,
  ]);
  const { id: projectId } = await one<{ id: string }>(
    `insert into projects (tenant_id, name, type) values ($1, 'Team', 'team') returning id`,
    [tenantId],
  );
  return { tenantId, owner, projectId };
}

/** a destination of workspace `w` (raw SQL; the write methods are L3's) */
async function seedDestination(
  w: Workspace,
  values: { enabled?: boolean; subscribedEvents?: string[]; credentialId?: string } = {},
): Promise<string> {
  const { id } = await one<{ id: string }>(
    `insert into log_destinations (tenant_id, type, enabled, subscribed_events, credential_id, created_by)
     values ($1, 'webhook', $2, $3, $4, $5) returning id`,
    [
      w.tenantId,
      values.enabled ?? false,
      values.subscribedEvents ?? [],
      values.credentialId ?? null,
      w.owner,
    ],
  );
  return id;
}

async function seedFailed(w: Workspace, destinationId: string): Promise<void> {
  await pool.query(
    `insert into log_stream_failed (tenant_id, destination_id, event_id, event)
     values ($1, $2, gen_random_uuid(), '{"eventName":"workflow.failed"}')`,
    [w.tenantId, destinationId],
  );
}

async function seedExecution(w: Workspace): Promise<string> {
  const { id } = await one<{ id: string }>(
    `insert into executions (id, tenant_id, mode, status) values (gen_random_uuid(), $1, 'manual', 'waiting')
     returning id`,
    [w.tenantId],
  );
  return id;
}

let a: Workspace;
let b: Workspace;

beforeAll(async () => {
  database = createDatabase(migrateUrl(), { max: 4 });
  pool = database.pool;
  const { current } = await one<{ current: string }>('select current_database() as current');
  if (current !== MIGRATE_DB) {
    throw new Error(`p6s5-migration only runs against ${MIGRATE_DB}, not ${current}`);
  }
  const hadVector = (await pool.query(`select 1 from pg_extension where extname = 'vector'`)).rows.length > 0;
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  // as a fresh database's public schema: every role may use it (the RLS probe role below needs this)
  await pool.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
  if (hadVector) await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  // every migration, through the migrator the server runs at start
  await runMigrations(pool);
  a = await seedWorkspace('A');
  b = await seedWorkspace('B');
}, 120_000);

afterAll(async () => {
  await database?.close();
});

describe('0036 journal and snapshot', () => {
  it('journals 0036 after 0035, each newer than every earlier migration', () => {
    const entries = journal();
    // bounded, so a later phase's 0037 keeps this green
    expect(entries.map((e) => `${e.idx}:${e.tag}`).slice(35, 37)).toEqual([
      '35:0035_source_control',
      `36:${NEW_TAG}`,
    ]);
    expect(entries[36].when).toBeGreaterThan(1794397190556);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].when).toBeGreaterThan(entries[i - 1].when);
    }
  });

  it('chains the 0036 snapshot to 0035 and holds the three tables and the executions column', () => {
    const read = (n: number) =>
      JSON.parse(
        readFileSync(
          path.join(migrationsFolder, 'meta', `${String(n).padStart(4, '0')}_snapshot.json`),
          'utf8',
        ),
      ) as { id: string; prevId: string; tables: Record<string, { columns: Record<string, unknown> }> };
    const snapshot = read(36);
    expect(snapshot.prevId).toBe(read(35).id);
    for (const table of TENANT_TABLES) expect(Object.keys(snapshot.tables)).toContain(`public.${table}`);
    expect(Object.keys(snapshot.tables['public.executions'].columns)).toContain('tracing_context');
  });

  it('records 0036 as applied by the migrator', async () => {
    const { rows } = await pool.query('select hash from drizzle.__drizzle_migrations');
    expect(rows).toHaveLength(journal().length);
  });
});

describe('0036 columns and defaults', () => {
  const columnsOf = async (table: string) =>
    (
      await pool.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `select column_name, data_type, is_nullable, column_default from information_schema.columns
         where table_schema = 'public' and table_name = $1 order by ordinal_position`,
        [table],
      )
    ).rows.map((r) => [r.column_name, r.data_type, r.is_nullable]);

  it('has the log_destinations columns of the plan, with no plain secret column', async () => {
    expect(await columnsOf('log_destinations')).toEqual([
      ['id', 'uuid', 'NO'],
      ['tenant_id', 'uuid', 'NO'],
      ['type', 'text', 'NO'],
      ['label', 'character varying', 'NO'],
      ['enabled', 'boolean', 'NO'],
      ['subscribed_events', 'ARRAY', 'NO'],
      ['anonymize_audit_messages', 'boolean', 'NO'],
      ['circuit_breaker', 'jsonb', 'YES'],
      ['credential_id', 'uuid', 'YES'],
      ['settings', 'jsonb', 'NO'],
      ['secrets_enc', 'text', 'YES'],
      ['last_error', 'text', 'YES'],
      ['created_by', 'uuid', 'YES'],
      ['created_at', 'timestamp with time zone', 'NO'],
      ['updated_at', 'timestamp with time zone', 'NO'],
    ]);
  });

  it('has the log_stream_failed and otel_settings columns of the plan and executions.tracing_context', async () => {
    expect(await columnsOf('log_stream_failed')).toEqual([
      ['id', 'bigint', 'NO'],
      ['tenant_id', 'uuid', 'NO'],
      ['destination_id', 'uuid', 'NO'],
      ['event_id', 'uuid', 'NO'],
      ['event', 'jsonb', 'NO'],
      ['attempts', 'integer', 'NO'],
      ['last_error', 'text', 'YES'],
      ['created_at', 'timestamp with time zone', 'NO'],
    ]);
    expect(await columnsOf('otel_settings')).toEqual([
      ['tenant_id', 'uuid', 'NO'],
      ['enabled', 'boolean', 'NO'],
      ['exporter_protocol', 'text', 'NO'],
      ['exporter_endpoint', 'text', 'NO'],
      ['exporter_tracing_path', 'text', 'NO'],
      ['exporter_service_name', 'character varying', 'NO'],
      ['exporter_headers_enc', 'text', 'YES'],
      ['traces_sample_rate', 'real', 'NO'],
      ['startup_connectivity_timeout_ms', 'integer', 'NO'],
      ['include_node_spans', 'boolean', 'NO'],
      ['emit_workflow_start_span', 'boolean', 'NO'],
      ['emit_node_start_span', 'boolean', 'NO'],
      ['inject_outbound', 'boolean', 'NO'],
      ['production_executions_only', 'boolean', 'NO'],
      ['updated_by', 'uuid', 'YES'],
      ['updated_at', 'timestamp with time zone', 'NO'],
    ]);
    const column = await one<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'executions' and column_name = 'tracing_context'`,
    );
    expect(column).toEqual({ data_type: 'jsonb', is_nullable: 'YES', column_default: null });
  });

  it('fills the defaults of a bare destination and a bare settings row (empty endpoint, not localhost)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const dest = await client.query(
        `insert into log_destinations (tenant_id, type) values ($1, 'syslog')
         returning id, label, enabled, subscribed_events, anonymize_audit_messages, circuit_breaker, settings,
           secrets_enc, credential_id`,
        [a.tenantId],
      );
      expect(dest.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
      const { id: _id, ...rest } = dest.rows[0];
      expect(rest).toEqual({
        label: 'Log Destination',
        enabled: false,
        subscribed_events: [],
        anonymize_audit_messages: false,
        circuit_breaker: null,
        settings: {},
        secrets_enc: null,
        credential_id: null,
      });
      const otel = await client.query(
        `insert into otel_settings (tenant_id) values ($1) returning enabled, exporter_protocol, exporter_endpoint,
           exporter_tracing_path, exporter_service_name, exporter_headers_enc, traces_sample_rate,
           startup_connectivity_timeout_ms, include_node_spans, emit_workflow_start_span, emit_node_start_span,
           inject_outbound, production_executions_only, updated_by`,
        [a.tenantId],
      );
      expect(otel.rows[0]).toEqual({
        enabled: false,
        exporter_protocol: 'http/protobuf',
        exporter_endpoint: '',
        exporter_tracing_path: '/v1/traces',
        exporter_service_name: 'workflow',
        exporter_headers_enc: null,
        traces_sample_rate: 1,
        startup_connectivity_timeout_ms: 2000,
        include_node_spans: true,
        emit_workflow_start_span: false,
        emit_node_start_span: false,
        inject_outbound: true,
        production_executions_only: true,
        updated_by: null,
      });
      const failed = await client.query(
        `insert into log_stream_failed (tenant_id, destination_id, event_id, event)
         values ($1, $2, gen_random_uuid(), '{}') returning id, attempts, last_error`,
        [a.tenantId, dest.rows[0].id],
      );
      expect(failed.rows[0]).toMatchObject({ attempts: 0, last_error: null });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('indexes log_destinations by tenant and log_stream_failed by destination and id, and by age', async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = any($1::text[]) order by indexname`,
      [TENANT_TABLES],
    );
    const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(defs.log_destinations_tenant_idx).toContain('(tenant_id)');
    expect(defs.log_stream_failed_destination_idx).toContain('(destination_id, id)');
    expect(defs.log_stream_failed_created_idx).toContain('(created_at)');
  });
});

describe('0036 checks and foreign keys', () => {
  it('refuses a sample rate of 1.5 or below 0, and takes 0 and 1', async () => {
    const insert = (rate: number) => (client: pg.PoolClient) =>
      client.query('insert into otel_settings (tenant_id, traces_sample_rate) values ($1, $2)', [
        b.tenantId,
        rate,
      ]);
    expect(await codeOf(insert(1.5))).toBe(CHECK_VIOLATION);
    expect(await codeOf(insert(-0.1))).toBe(CHECK_VIOLATION);
    expect(await codeOf(insert(0))).toBeUndefined();
    expect(await codeOf(insert(1))).toBeUndefined();
  });

  it('takes the two exporter protocols and refuses another', async () => {
    const insert = (protocol: string) => (client: pg.PoolClient) =>
      client.query('insert into otel_settings (tenant_id, exporter_protocol) values ($1, $2)', [
        b.tenantId,
        protocol,
      ]);
    expect(await codeOf(insert('http/protobuf'))).toBeUndefined();
    expect(await codeOf(insert('grpc'))).toBeUndefined();
    expect(await codeOf(insert('http/json'))).toBe(CHECK_VIOLATION);
  });

  it('takes the three destination types and refuses another or none', async () => {
    const insert = (type: string | null) => (client: pg.PoolClient) =>
      client.query('insert into log_destinations (tenant_id, type) values ($1, $2)', [b.tenantId, type]);
    for (const type of ['webhook', 'syslog', 'sentry'])
      expect(await codeOf(insert(type)), type).toBeUndefined();
    expect(await codeOf(insert('kafka'))).toBe(CHECK_VIOLATION);
    expect(await codeOf(insert(null))).toBe(NOT_NULL_VIOLATION);
  });

  it('refuses an unknown tenant, destination or credential', async () => {
    expect(
      await codeOf((c) =>
        c.query(`insert into log_destinations (tenant_id, type) values (gen_random_uuid(), 'webhook')`),
      ),
    ).toBe(FK_VIOLATION);
    expect(
      await codeOf((c) =>
        c.query(
          `insert into log_destinations (tenant_id, type, credential_id) values ($1, 'webhook', gen_random_uuid())`,
          [b.tenantId],
        ),
      ),
    ).toBe(FK_VIOLATION);
    expect(
      await codeOf((c) =>
        c.query(
          `insert into log_stream_failed (tenant_id, destination_id, event_id, event)
           values ($1, gen_random_uuid(), gen_random_uuid(), '{}')`,
          [b.tenantId],
        ),
      ),
    ).toBe(FK_VIOLATION);
    expect(
      await codeOf((c) => c.query(`insert into otel_settings (tenant_id) values (gen_random_uuid())`)),
    ).toBe(FK_VIOLATION);
  });

  it('removes the failed events of a deleted destination', async () => {
    const w = await seedWorkspace('Dest');
    const gone = await seedDestination(w);
    const kept = await seedDestination(w);
    await seedFailed(w, gone);
    await seedFailed(w, gone);
    await seedFailed(w, kept);
    await pool.query('delete from log_destinations where id = $1', [gone]);
    expect(await countOf('log_stream_failed', 'destination_id = $1', [gone])).toBe(0);
    expect(await countOf('log_stream_failed', 'destination_id = $1', [kept])).toBe(1);
  });

  it('keeps a destination when its credential is deleted, with credential_id null', async () => {
    const w = await seedWorkspace('Cred');
    const { id: credentialId } = await one<{ id: string }>(
      `insert into credentials (id, tenant_id, name, type, data_enc, project_id)
       values (gen_random_uuid(), $1, 'Header', 'httpHeaderAuth', 'x', $2) returning id`,
      [w.tenantId, w.projectId],
    );
    const id = await seedDestination(w, { credentialId });
    await pool.query('delete from credentials where id = $1', [credentialId]);
    const row = await one<{ credential_id: string | null }>(
      'select credential_id from log_destinations where id = $1',
      [id],
    );
    expect(row.credential_id).toBeNull();
  });

  it('keeps a destination and the settings when their author is deleted, with the author null', async () => {
    const w = await seedWorkspace('Author');
    const id = await seedDestination(w);
    await pool.query('insert into otel_settings (tenant_id, updated_by) values ($1, $2)', [
      w.tenantId,
      w.owner,
    ]);
    await pool.query('delete from users where id = $1', [w.owner]);
    expect(
      (
        await one<{ created_by: string | null }>('select created_by from log_destinations where id = $1', [
          id,
        ])
      ).created_by,
    ).toBeNull();
    expect(
      (
        await one<{ updated_by: string | null }>(
          'select updated_by from otel_settings where tenant_id = $1',
          [w.tenantId],
        )
      ).updated_by,
    ).toBeNull();
  });

  it('removes all three rows and the run with its trace context when the tenant is deleted', async () => {
    const w = await seedWorkspace('Gone');
    const destinationId = await seedDestination(w, { enabled: true, subscribedEvents: ['workflow'] });
    await seedFailed(w, destinationId);
    await pool.query('insert into otel_settings (tenant_id, enabled) values ($1, true)', [w.tenantId]);
    const executionId = await seedExecution(w);
    await new ExecutionRepository(database.db).setTracingContext(w.tenantId, executionId, {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      identity: {},
    });
    for (const table of TENANT_TABLES)
      expect(await countOf(table, 'tenant_id = $1', [w.tenantId]), table).toBe(1);
    await pool.query('delete from tenants where id = $1', [w.tenantId]);
    for (const table of [...TENANT_TABLES, 'executions']) {
      expect(await countOf(table, 'tenant_id = $1', [w.tenantId]), table).toBe(0);
    }
  });
});

describe('repositories (C0 FULL methods)', () => {
  it('listEnabledAcrossTenants returns the enabled destinations of every tenant and skips a disabled one', async () => {
    const first = await seedWorkspace('L1');
    const two = await seedWorkspace('L2');
    const off = await seedWorkspace('L3');
    await seedDestination(first, { enabled: true, subscribedEvents: ['workflow', 'audit.user'] });
    await seedDestination(two, { enabled: true, subscribedEvents: ['*'] });
    await seedDestination(two, { enabled: false, subscribedEvents: ['node'] });
    await seedDestination(off, { enabled: false, subscribedEvents: ['*'] });
    const ours = new Set([first.tenantId, two.tenantId, off.tenantId]);
    const rows = (await new LogDestinationRepository(database.db).listEnabledAcrossTenants())
      .filter((r) => ours.has(r.tenantId))
      .sort((x, y) => x.subscribedEvents.join().localeCompare(y.subscribedEvents.join()));
    expect(rows).toEqual([
      { tenantId: two.tenantId, subscribedEvents: ['*'] },
      { tenantId: first.tenantId, subscribedEvents: ['workflow', 'audit.user'] },
    ]);
  });

  it('setTracingContext then tracingContextOf round trips; another tenant reads null and cannot write', async () => {
    const repo = new ExecutionRepository(database.db);
    const executionId = await seedExecution(a);
    expect(await repo.tracingContextOf(a.tenantId, executionId)).toBeNull();
    const value: TracingContextRow = {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'vendor=one',
      baggage: 'k=v',
      identity: { 'workflow.id': 'wf-1', 'execution.id': executionId },
    };
    await repo.setTracingContext(a.tenantId, executionId, value);
    expect(await repo.tracingContextOf(a.tenantId, executionId)).toEqual(value);
    expect(await repo.tracingContextOf(b.tenantId, executionId)).toBeNull();
    await repo.setTracingContext(b.tenantId, executionId, { traceparent: 'x', identity: {} });
    expect(await repo.tracingContextOf(a.tenantId, executionId)).toEqual(value);
    expect(await repo.tracingContextOf(a.tenantId, 'not-a-uuid')).toBeNull();
    await repo.setTracingContext(a.tenantId, executionId, null);
    expect(await repo.tracingContextOf(a.tenantId, executionId)).toBeNull();
  });

  it('builds both stub repositories from db alone (their methods are L3 and L7)', () => {
    expect(new LogDestinationRepository(database.db)).toBeInstanceOf(LogDestinationRepository);
    expect(new LogStreamFailedRepository(database.db)).toBeInstanceOf(LogStreamFailedRepository);
  });
});

describe('0036 row-level security', () => {
  it('enables RLS with the tenant_isolation policy on the three tables', async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      'select relname, relrowsecurity from pg_class where relname = any($1::text[]) order by relname',
      [TENANT_TABLES],
    );
    expect(rows).toHaveLength(TENANT_TABLES.length);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    const policies = await pool.query<{
      tablename: string;
      policyname: string;
      qual: string;
      with_check: string;
    }>('select tablename, policyname, qual, with_check from pg_policies where tablename = any($1::text[])', [
      TENANT_TABLES,
    ]);
    expect(policies.rows.map((p) => p.tablename).sort()).toEqual([...TENANT_TABLES].sort());
    // the same expression as 0013's secret_connections policy, as Postgres stores it
    const reference = await one<{ qual: string; with_check: string }>(
      `select qual, with_check from pg_policies where tablename = 'secret_connections' and policyname = 'tenant_isolation'`,
    );
    for (const policy of policies.rows) {
      expect(policy.policyname).toBe('tenant_isolation');
      expect(policy.qual).toBe(reference.qual);
      expect(policy.with_check).toBe(reference.with_check);
    }
    const file = statements(NEW_TAG).join('\n');
    for (const table of TENANT_TABLES) {
      expect(file, table).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(file, table).toContain(
        `CREATE POLICY tenant_isolation ON "${table}" USING ${POLICY} WITH CHECK ${POLICY};`,
      );
    }
  });

  it('shows a role other than the owner only the rows of the tenant it set, and refuses a write for another', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const w of [a, b]) {
        const { rows } = await client.query<{ id: string }>(
          `insert into log_destinations (tenant_id, type) values ($1, 'webhook') returning id`,
          [w.tenantId],
        );
        await client.query(
          `insert into log_stream_failed (tenant_id, destination_id, event_id, event)
           values ($1, $2, gen_random_uuid(), '{}')`,
          [w.tenantId, rows[0].id],
        );
        await client.query('insert into otel_settings (tenant_id) values ($1)', [w.tenantId]);
      }
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workflow_rls_probe') THEN
          CREATE ROLE workflow_rls_probe NOLOGIN;
        END IF;
      END $$`);
      await client.query(`GRANT SELECT, INSERT ON ${TENANT_TABLES.join(', ')} TO workflow_rls_probe`);
      await client.query('SET LOCAL ROLE workflow_rls_probe');
      for (const table of TENANT_TABLES) {
        const none = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(none.rows[0].n, table).toBe(0);
      }
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
      for (const table of TENANT_TABLES) {
        const { rows } = await client.query(`SELECT DISTINCT tenant_id FROM ${table}`);
        expect(rows, table).toEqual([{ tenant_id: a.tenantId }]);
      }
      await client.query('SAVEPOINT cross_tenant');
      const refused = await client
        .query(`INSERT INTO log_destinations (tenant_id, type) VALUES ($1, 'sentry')`, [b.tenantId])
        .then(
          () => undefined,
          (error: { code?: string }) => error.code,
        );
      // 42501: new row violates row-level security policy
      expect(refused).toBe('42501');
      await client.query('ROLLBACK TO SAVEPOINT cross_tenant');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
