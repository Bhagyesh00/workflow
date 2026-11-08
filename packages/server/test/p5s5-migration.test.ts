/**
 * Phase 5 S5 contract step (C0b): migrations 0018 (Assistant threads, messages, events), 0019
 * (confirmation cards) and 0020 (MCP connections). Checks what Postgres really holds: columns,
 * defaults, indexes, row-level security, cascades; then the real C0 code lanes build on: the
 * repository registration, the four FULL card queries and the Assistant config (never a stub's body).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { migrationsFolder } from '../src/db/client';
import { AssistantConfirmationRepository } from '../src/repositories/assistant-confirmations';
import { AssistantMcpRepository } from '../src/repositories/assistant-mcp';
import { AssistantThreadRepository } from '../src/repositories/assistant-threads';
import { createTestServer, resetDatabase, signup, type TestServer } from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const pool = () => server.ctx.database.pool;
const repos = () => server.ctx.repos;

const THREAD_TABLES = ['assistant_threads', 'assistant_messages', 'assistant_events'];
const S5_TABLES = [...THREAD_TABLES, 'assistant_pending_confirmations', 'assistant_mcp_connections'];
const UNIQUE_VIOLATION = '23505';
const RLS_VIOLATION = '42501';
const POLICY = "(tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)";

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

interface Workspace {
  tenantId: string;
  userId: string;
}

async function workspace(): Promise<Workspace> {
  const user = await signup(server.app);
  return { tenantId: user.tenant.id, userId: user.user.id };
}

async function insertThread(w: Workspace): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    'insert into assistant_threads (tenant_id, user_id) values ($1, $2) returning id',
    [w.tenantId, w.userId],
  );
  return rows[0].id;
}

async function insertCredential(w: Workspace): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `insert into credentials (id, tenant_id, name, type, data_enc)
     values (gen_random_uuid(), $1, 'MCP key', 'httpBearerAuth', 'x') returning id`,
    [w.tenantId],
  );
  return rows[0].id;
}

interface CardSeed {
  status?: string;
  runId?: string | null;
  expiresAt?: Date | null;
  userId?: string;
  toolCallId?: string;
}

async function insertCard(w: Workspace, threadId: string, seed: CardSeed = {}): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `insert into assistant_pending_confirmations
       (tenant_id, user_id, thread_id, run_id, tool_call_id, tool_name, args, input_type, details, status, expires_at)
     values ($1, $2, $3, $4, $5, 'delete_workflow', '{"workflowId":"w1"}', 'approval', '{"title":"Delete"}', $6, $7)
     returning id`,
    [
      w.tenantId,
      seed.userId ?? w.userId,
      threadId,
      seed.runId === undefined ? 'run-1' : seed.runId,
      seed.toolCallId ?? `call-${randomUUID()}`,
      seed.status ?? 'pending',
      seed.expiresAt ?? null,
    ],
  );
  return rows[0].id;
}

/** one row in each of the five S5 tables for this workspace */
async function seedAll(w: Workspace) {
  const threadId = await insertThread(w);
  await pool().query(
    `insert into assistant_messages (tenant_id, thread_id, role, content) values ($1, $2, 'user', '"Hello"')`,
    [w.tenantId, threadId],
  );
  await pool().query(
    `insert into assistant_events (tenant_id, thread_id, type, payload) values ($1, $2, 'run-start', '{"type":"run-start"}')`,
    [w.tenantId, threadId],
  );
  await insertCard(w, threadId);
  const credentialId = await insertCredential(w);
  await pool().query(
    `insert into assistant_mcp_connections (tenant_id, name, url, credential_id, created_by)
     values ($1, 'Docs', 'http://127.0.0.1:9/mcp', $2, $3)`,
    [w.tenantId, credentialId, w.userId],
  );
  return { threadId, credentialId };
}

describe('0018 to 0020 journal and files', () => {
  it('journals 0018, 0019, 0020 after 0017, each newer than every earlier migration', () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    // bounded, so a later stage's 0021 keeps this green
    expect(journal.entries.map((e) => `${e.idx}:${e.tag}`).slice(17, 21)).toEqual([
      '17:0017_workflow_builder_sessions',
      '18:0018_assistant_threads',
      '19:0019_assistant_confirmations',
      '20:0020_assistant_mcp_connections',
    ]);
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
    }
  });

  it('writes every tenant_isolation policy into the migration files', () => {
    const files: [string, string[]][] = [
      ['0018_assistant_threads.sql', THREAD_TABLES],
      ['0019_assistant_confirmations.sql', ['assistant_pending_confirmations']],
      ['0020_assistant_mcp_connections.sql', ['assistant_mcp_connections']],
    ];
    for (const [file, tables] of files) {
      const sql = readFileSync(path.join(migrationsFolder, file), 'utf8');
      for (const table of tables) {
        expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
        expect(sql).toContain(
          `CREATE POLICY tenant_isolation ON "${table}" USING ${POLICY} WITH CHECK ${POLICY};`,
        );
      }
    }
  });
});

describe('0018 to 0020 tables', () => {
  it('creates all five tables with row-level security and the tenant_isolation policy', async () => {
    const { rows } = await pool().query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname = any($1) and relkind = 'r'`,
      [S5_TABLES],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...S5_TABLES].sort());
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    const policies = await pool().query<{ tablename: string; qual: string; with_check: string }>(
      `select tablename, qual, with_check from pg_policies where policyname = 'tenant_isolation' and tablename = any($1)`,
      [S5_TABLES],
    );
    expect(policies.rows.map((p) => p.tablename).sort()).toEqual([...S5_TABLES].sort());
    for (const policy of policies.rows) {
      expect(policy.qual).toContain("current_setting('app.tenant_id'::text, true)");
      expect(policy.with_check).toBe(policy.qual);
    }
  });

  it('holds the planned columns, types and nullability', async () => {
    const { rows } = await pool().query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: 'YES' | 'NO';
    }>(
      `select table_name, column_name, data_type, is_nullable from information_schema.columns
       where table_name = any($1)`,
      [S5_TABLES],
    );
    const shape = (table: string) =>
      Object.fromEntries(
        rows
          .filter((r) => r.table_name === table)
          .map((r) => [r.column_name, `${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}`]),
      );
    const tz = 'timestamp with time zone';
    expect(shape('assistant_threads')).toEqual({
      id: 'uuid not null',
      tenant_id: 'uuid not null',
      user_id: 'uuid not null',
      title: 'text not null',
      observations: 'text',
      tasks: 'jsonb not null',
      grants: 'jsonb not null',
      drafts: 'jsonb not null',
      active_run_id: 'text',
      run_heartbeat_at: tz,
      created_at: `${tz} not null`,
      updated_at: `${tz} not null`,
    });
    expect(shape('assistant_messages')).toEqual({
      seq: 'bigint not null',
      id: 'uuid not null',
      tenant_id: 'uuid not null',
      thread_id: 'uuid not null',
      run_id: 'text',
      role: 'text not null',
      content: 'jsonb not null',
      tool_calls: 'jsonb',
      tool_call_id: 'text',
      name: 'text',
      attachments: 'jsonb',
      summarized: 'boolean not null',
      created_at: `${tz} not null`,
    });
    expect(shape('assistant_events')).toEqual({
      id: 'bigint not null',
      tenant_id: 'uuid not null',
      thread_id: 'uuid not null',
      run_id: 'text',
      type: 'text not null',
      payload: 'jsonb not null',
      created_at: `${tz} not null`,
    });
    expect(shape('assistant_pending_confirmations')).toEqual({
      id: 'uuid not null',
      tenant_id: 'uuid not null',
      user_id: 'uuid not null',
      thread_id: 'uuid not null',
      run_id: 'text',
      tool_call_id: 'text not null',
      tool_name: 'text not null',
      args: 'jsonb not null',
      input_type: 'text not null',
      details: 'jsonb not null',
      grant_key: 'text',
      status: 'text not null',
      answer: 'jsonb',
      created_at: `${tz} not null`,
      expires_at: tz,
      resolved_at: tz,
    });
    expect(shape('assistant_mcp_connections')).toEqual({
      id: 'uuid not null',
      tenant_id: 'uuid not null',
      name: 'text not null',
      url: 'text not null',
      transport: 'text not null',
      authentication: 'text not null',
      credential_id: 'uuid',
      enabled: 'boolean not null',
      tool_permissions: 'jsonb not null',
      created_by: 'uuid',
      created_at: `${tz} not null`,
      updated_at: `${tz} not null`,
    });
  });

  it('makes seq and the event id identity columns, and keeps the planned indexes', async () => {
    const identity = await pool().query<{ table_name: string; column_name: string; is_identity: string }>(
      `select table_name, column_name, is_identity from information_schema.columns
       where (table_name, column_name) in (('assistant_messages', 'seq'), ('assistant_events', 'id'))`,
    );
    expect(identity.rows.every((r) => r.is_identity === 'YES')).toBe(true);
    expect(identity.rows).toHaveLength(2);

    const { rows } = await pool().query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = any($1)`,
      [S5_TABLES],
    );
    const def = (name: string) => rows.find((r) => r.indexname === name)?.indexdef ?? '';
    expect(def('assistant_threads_tenant_user_updated_idx')).toContain('(tenant_id, user_id, updated_at)');
    expect(def('assistant_threads_run_heartbeat_idx')).toContain('(run_heartbeat_at)');
    expect(def('assistant_messages_tenant_thread_seq_idx')).toContain('(tenant_id, thread_id, seq)');
    expect(def('assistant_messages_id_unique')).toContain('UNIQUE INDEX');
    expect(def('assistant_events_tenant_thread_id_idx')).toContain('(tenant_id, thread_id, id)');
    expect(def('assistant_pending_confirmations_thread_tool_call_unique')).toContain(
      'UNIQUE INDEX assistant_pending_confirmations_thread_tool_call_unique ON public.assistant_pending_confirmations USING btree (thread_id, tool_call_id)',
    );
    expect(def('assistant_pending_confirmations_tenant_user_status_idx')).toContain(
      '(tenant_id, user_id, status)',
    );
    expect(def('assistant_pending_confirmations_expires_idx')).toContain('(expires_at)');
    expect(def('assistant_mcp_connections_tenant_name_unique')).toContain(
      'UNIQUE INDEX assistant_mcp_connections_tenant_name_unique ON public.assistant_mcp_connections USING btree (tenant_id, name)',
    );
  });

  it('gives a new row of each table its defaults', async () => {
    const w = await workspace();
    const { threadId } = await seedAll(w);
    const thread = (await pool().query('select * from assistant_threads')).rows[0];
    expect(thread).toMatchObject({
      id: threadId,
      tenant_id: w.tenantId,
      user_id: w.userId,
      title: '',
      observations: null,
      tasks: [],
      grants: [],
      drafts: {},
      active_run_id: null,
      run_heartbeat_at: null,
    });
    expect(thread.updated_at).toBeInstanceOf(Date);
    const message = (await pool().query('select * from assistant_messages')).rows[0];
    expect(message).toMatchObject({ seq: '1', content: 'Hello', summarized: false, tool_calls: null });
    expect(message.id).toMatch(/^[0-9a-f-]{36}$/);
    const event = (await pool().query('select id, payload from assistant_events')).rows[0];
    expect(event).toEqual({ id: '1', payload: { type: 'run-start' } });
    const card = (
      await pool().query('select status, answer, resolved_at from assistant_pending_confirmations')
    ).rows[0];
    expect(card).toEqual({ status: 'pending', answer: null, resolved_at: null });
    const connection = (await pool().query('select * from assistant_mcp_connections')).rows[0];
    expect(connection).toMatchObject({
      transport: 'httpStreamable',
      authentication: 'none',
      enabled: true,
      tool_permissions: {},
    });
  });

  it('refuses a second card for one tool call and a second connection of the same name', async () => {
    const w = await workspace();
    const threadId = await insertThread(w);
    await insertCard(w, threadId, { toolCallId: 'call-1' });
    expect(await codeOf(insertCard(w, threadId, { toolCallId: 'call-1' }))).toBe(UNIQUE_VIOLATION);
    const other = await insertThread(w);
    expect(await insertCard(w, other, { toolCallId: 'call-1' })).toMatch(/^[0-9a-f-]{36}$/);

    const add = (tenantId: string) =>
      pool().query(
        `insert into assistant_mcp_connections (tenant_id, name, url) values ($1, 'Docs', 'http://x')`,
        [tenantId],
      );
    await add(w.tenantId);
    expect(await codeOf(add(w.tenantId))).toBe(UNIQUE_VIOLATION);
    await add((await workspace()).tenantId);
  });

  it('deletes messages, events and cards with their thread, and nulls credential and creator', async () => {
    const w = await workspace();
    const other = await workspace();
    const { threadId, credentialId } = await seedAll(w);
    await seedAll(other);

    await pool().query('delete from assistant_threads where id = $1', [threadId]);
    for (const table of S5_TABLES.filter((t) => t !== 'assistant_mcp_connections')) {
      const { rows } = await pool().query(`select tenant_id from ${table}`);
      expect(rows, table).toEqual([{ tenant_id: other.tenantId }]);
    }

    await pool().query('delete from credentials where id = $1', [credentialId]);
    const connections = await pool().query(
      'select tenant_id, credential_id is null as cleared from assistant_mcp_connections order by tenant_id = $1 desc',
      [w.tenantId],
    );
    expect(connections.rows).toEqual([
      { tenant_id: w.tenantId, cleared: true },
      { tenant_id: other.tenantId, cleared: false },
    ]);

    // a user's threads go with the user; a connection only loses its creator
    await insertThread(w);
    await pool().query('delete from memberships where user_id = $1', [w.userId]);
    await pool().query('delete from users where id = $1', [w.userId]);
    expect(
      (await pool().query('select 1 from assistant_threads where user_id = $1', [w.userId])).rowCount,
    ).toBe(0);
    const connection = await pool().query(
      'select created_by from assistant_mcp_connections where tenant_id = $1',
      [w.tenantId],
    );
    expect(connection.rows).toEqual([{ created_by: null }]);
  });

  it('hides another tenant’s rows from a role other than the owner, and refuses writing them', async () => {
    const a = await workspace();
    const b = await workspace();
    await seedAll(a);
    const seededB = await seedAll(b);
    await pool().query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workflow_rls_probe') THEN
        CREATE ROLE workflow_rls_probe NOLOGIN;
      END IF;
    END $$`);
    await pool().query(`GRANT SELECT, INSERT ON ${S5_TABLES.join(', ')} TO workflow_rls_probe`);
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      // the test user is a superuser and bypasses RLS; the probe role does not
      await client.query('SET LOCAL ROLE workflow_rls_probe');
      for (const table of S5_TABLES) {
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
      }
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
      for (const table of S5_TABLES) {
        const rows = (await client.query(`SELECT tenant_id FROM ${table}`)).rows;
        expect(rows, table).toEqual([{ tenant_id: a.tenantId }]);
      }
      await client.query('SAVEPOINT write_other');
      expect(
        await codeOf(
          client.query(
            `insert into assistant_messages (tenant_id, thread_id, role, content) values ($1, $2, 'user', '"x"')`,
            [b.tenantId, seededB.threadId],
          ),
        ),
      ).toBe(RLS_VIOLATION);
      await client.query('ROLLBACK TO SAVEPOINT write_other');
      expect(
        await codeOf(
          client.query(
            `insert into assistant_mcp_connections (tenant_id, name, url) values ($1, 'X', 'http://x')`,
            [b.tenantId],
          ),
        ),
      ).toBe(RLS_VIOLATION);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('Assistant repositories (P5-67, P5-68, P5-72)', () => {
  it('registers the three repositories on the context', () => {
    expect(repos().assistantThreads).toBeInstanceOf(AssistantThreadRepository);
    expect(repos().assistantConfirmations).toBeInstanceOf(AssistantConfirmationRepository);
    expect(repos().assistantMcp).toBeInstanceOf(AssistantMcpRepository);
  });

  it('lets the C0 sweeps return nothing instead of throwing', async () => {
    const at = new Date();
    expect(await repos().assistantThreads.listStaleRuns(at)).toEqual([]);
    expect(await repos().assistantThreads.listExpiredThreads(at)).toEqual([]);
    expect(await repos().assistantConfirmations.sweepExpired(at)).toEqual([]);
    expect(await repos().assistantConfirmations.sweepOrphanApproved(at)).toEqual([]);
  });

  it('finds no card on a new thread (what L1 sees before L3 exists)', async () => {
    const w = await workspace();
    const threadId = await insertThread(w);
    const cards = repos().assistantConfirmations;
    expect(await cards.listPending(w.tenantId, w.userId, threadId)).toEqual([]);
    expect(await cards.hasOpen(w.tenantId, threadId, new Date())).toBe(false);
    expect(await cards.listOpenForRun(w.tenantId, threadId, 'run-1')).toEqual([]);
    expect(await cards.denyAll(w.tenantId, threadId, 'Cancelled')).toEqual([]);
    expect(await cards.listPending('not-a-uuid', w.userId, threadId)).toEqual([]);
    expect(await cards.hasOpen(w.tenantId, 'not-a-uuid', new Date())).toBe(false);
  });

  it('lists only the user’s pending cards in time, oldest first, and never another tenant’s', async () => {
    const w = await workspace();
    const other = await workspace();
    const threadId = await insertThread(w);
    const otherThread = await insertThread(other);
    const now = new Date();
    const first = await insertCard(w, threadId, { expiresAt: null });
    const second = await insertCard(w, threadId, { expiresAt: new Date(now.getTime() + 60_000) });
    await insertCard(w, threadId, { expiresAt: new Date(now.getTime() - 1_000) });
    await insertCard(w, threadId, { status: 'approved' });
    await insertCard(w, threadId, { status: 'denied' });
    await insertCard(other, otherThread);

    const cards = repos().assistantConfirmations;
    const pending = await cards.listPending(w.tenantId, w.userId, threadId, now);
    expect(pending.map((c) => c.id)).toEqual([first, second]);
    expect(pending[0]).toMatchObject({
      toolName: 'delete_workflow',
      inputType: 'approval',
      status: 'pending',
    });
    expect(await cards.listPending(w.tenantId, other.userId, threadId, now)).toEqual([]);
    expect(await cards.listPending(other.tenantId, w.userId, threadId, now)).toEqual([]);
  });

  it('counts a pending card in time or an approved card as open, nothing else', async () => {
    const w = await workspace();
    const now = new Date();
    const cards = repos().assistantConfirmations;

    const expired = await insertThread(w);
    await insertCard(w, expired, { expiresAt: new Date(now.getTime() - 1) });
    await insertCard(w, expired, { status: 'executed' });
    await insertCard(w, expired, { status: 'denied' });
    expect(await cards.hasOpen(w.tenantId, expired, now)).toBe(false);

    const waiting = await insertThread(w);
    await insertCard(w, waiting, { expiresAt: new Date(now.getTime() + 1_000) });
    expect(await cards.hasOpen(w.tenantId, waiting, now)).toBe(true);
    expect(await cards.hasOpen(w.tenantId, waiting, new Date(now.getTime() + 2_000))).toBe(false);
    expect(await cards.hasOpen((await workspace()).tenantId, waiting, now)).toBe(false);

    const approved = await insertThread(w);
    await insertCard(w, approved, { status: 'approved' });
    expect(await cards.hasOpen(w.tenantId, approved, now)).toBe(true);
  });

  it('lists a run’s open cards and denies every open card of the thread with the reason', async () => {
    const w = await workspace();
    const threadId = await insertThread(w);
    const otherThread = await insertThread(w);
    const pending = await insertCard(w, threadId, { runId: 'run-1' });
    const approved = await insertCard(w, threadId, { runId: 'run-1', status: 'approved' });
    const otherRun = await insertCard(w, threadId, { runId: 'run-2' });
    const executed = await insertCard(w, threadId, { runId: 'run-1', status: 'executed' });
    const elsewhere = await insertCard(w, otherThread, { runId: 'run-1' });
    const cards = repos().assistantConfirmations;

    expect((await cards.listOpenForRun(w.tenantId, threadId, 'run-1')).map((c) => c.id)).toEqual([
      pending,
      approved,
    ]);
    expect(await cards.listOpenForRun((await workspace()).tenantId, threadId, 'run-1')).toEqual([]);

    const denied = await cards.denyAll(w.tenantId, threadId, 'The run was cancelled');
    expect(denied.map((c) => c.id).sort()).toEqual([pending, approved, otherRun].sort());
    for (const row of denied) {
      expect(row.status).toBe('denied');
      expect(row.answer).toEqual({ kind: 'system', reason: 'The run was cancelled' });
      expect(row.resolvedAt).toBeInstanceOf(Date);
    }
    const { rows } = await pool().query<{ id: string; status: string }>(
      'select id, status from assistant_pending_confirmations where id = any($1)',
      [[executed, elsewhere]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [executed]: 'executed',
      [elsewhere]: 'pending',
    });
    expect(await cards.hasOpen(w.tenantId, threadId, new Date())).toBe(false);
    expect(await cards.denyAll(w.tenantId, threadId, 'again')).toEqual([]);
  });
});

describe('Assistant config (P5-67)', () => {
  it('has the planned defaults, with INSTANCE_AI_ENABLED unset left undefined', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.assistant).toEqual({
      enabled: undefined,
      confirmationTimeoutMs: 86_400_000,
      threadTtlDays: 30,
      pruneIntervalMs: 3_600_000,
      observerMessageTokens: 30_000,
      reflectorObservationTokens: 40_000,
      maxConcurrentRuns: -1,
      maxConcurrentRunsPerUser: -1,
      streamIdleTimeoutMs: 90_000,
      streamFirstOutputTimeoutMs: 180_000,
    });
  });

  it('reads every variable, 0 turning the timeouts, the TTL and the prune off', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      INSTANCE_AI_ENABLED: 'false',
      INSTANCE_AI_CONFIRMATION_TIMEOUT: '0',
      INSTANCE_AI_THREAD_TTL_DAYS: '0',
      INSTANCE_AI_PRUNE_INTERVAL: '0',
      INSTANCE_AI_OBSERVER_MESSAGE_TOKENS: '100',
      INSTANCE_AI_REFLECTOR_OBSERVATION_TOKENS: '200',
      INSTANCE_AI_MAX_CONCURRENT_RUNS: '4',
      INSTANCE_AI_MAX_CONCURRENT_RUNS_PER_USER: '1',
      AI_MODEL_STREAM_IDLE_TIMEOUT_MS: '0',
      AI_MODEL_STREAM_FIRST_OUTPUT_TIMEOUT_MS: '5000',
    });
    expect(config.assistant).toEqual({
      enabled: false,
      confirmationTimeoutMs: 0,
      threadTtlDays: 0,
      pruneIntervalMs: 0,
      observerMessageTokens: 100,
      reflectorObservationTokens: 200,
      maxConcurrentRuns: 4,
      maxConcurrentRunsPerUser: 1,
      streamIdleTimeoutMs: 0,
      streamFirstOutputTimeoutMs: 5000,
    });
    expect(loadConfig({ NODE_ENV: 'test', INSTANCE_AI_ENABLED: 'true' }).assistant.enabled).toBe(true);
  });

  it('refuses values out of range', () => {
    for (const env of [
      { INSTANCE_AI_ENABLED: 'maybe' },
      { INSTANCE_AI_CONFIRMATION_TIMEOUT: '-1' },
      { INSTANCE_AI_THREAD_TTL_DAYS: '1.5' },
      { INSTANCE_AI_MAX_CONCURRENT_RUNS: '-2' },
      { INSTANCE_AI_MAX_CONCURRENT_RUNS_PER_USER: '-2' },
      { INSTANCE_AI_OBSERVER_MESSAGE_TOKENS: '0' },
      { AI_MODEL_STREAM_IDLE_TIMEOUT_MS: '-5' },
    ]) {
      expect(() => loadConfig({ NODE_ENV: 'test', ...env }), JSON.stringify(env)).toThrow(ConfigError);
    }
  });
});
