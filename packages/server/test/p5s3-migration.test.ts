/**
 * Phase 5 S3 contract step (C0d1): migration 0014 (evaluation test runs). Checks what Postgres really
 * holds: tables, defaults, indexes, row-level security, cascades. The schema.ts exports and the
 * repository registration lanes build on are checked too (never a stub's body).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client';
import { testCaseExecutions, testRuns } from '../src/db/schema';
import { TestRunRepository } from '../src/repositories/test-runs';
import { createTestServer, createWorkflow, resetDatabase, signup, type TestServer } from './helpers';

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

const S3_TABLES = ['test_runs', 'test_case_executions'];
const FK_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';
const RLS_VIOLATION = '42501';

/** rejects with the Postgres error code of the failing statement */
async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function insertRun(tenantId: string, workflowId: string): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    'insert into test_runs (tenant_id, workflow_id) values ($1, $2) returning id',
    [tenantId, workflowId],
  );
  return rows[0].id;
}

async function insertCase(
  tenantId: string,
  runId: string,
  runIndex = 0,
  executionId: string | null = null,
): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `insert into test_case_executions (tenant_id, test_run_id, run_index, execution_id)
     values ($1, $2, $3, $4) returning id`,
    [tenantId, runId, runIndex, executionId],
  );
  return rows[0].id;
}

async function insertExecution(tenantId: string, workflowId: string): Promise<string> {
  const id = randomUUID();
  await pool().query(
    `insert into executions (id, tenant_id, workflow_id, mode, status) values ($1, $2, $3, 'evaluation', 'success')`,
    [id, tenantId, workflowId],
  );
  return id;
}

/** a workspace with one workflow */
async function workspace() {
  const user = await signup(server.app);
  const workflow = await createWorkflow(user.client, { nodes: [] });
  return { tenantId: user.tenant.id, workflowId: workflow.id };
}

describe('0014_test_runs journal', () => {
  it('journals 0014 after 0013, newer than every earlier migration', () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    expect(journal.entries.map((e) => `${e.idx}:${e.tag}`).slice(13, 15)).toEqual([
      '13:0013_secret_connections',
      '14:0014_test_runs',
    ]);
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
    }
  });

  it('writes both tenant_isolation policies into the migration file', () => {
    const sql = readFileSync(path.join(migrationsFolder, '0014_test_runs.sql'), 'utf8');
    const check = "(tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)";
    for (const table of S3_TABLES) {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(
        `CREATE POLICY tenant_isolation ON "${table}" USING ${check} WITH CHECK ${check};`,
      );
    }
  });
});

describe('0014_test_runs tables', () => {
  it('creates both tables with row-level security and the tenant_isolation policy', async () => {
    const { rows } = await pool().query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname = any($1) and relkind = 'r'`,
      [S3_TABLES],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...S3_TABLES].sort());
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    const policies = await pool().query<{ tablename: string; qual: string; with_check: string }>(
      `select tablename, qual, with_check from pg_policies where policyname = 'tenant_isolation' and tablename = any($1)`,
      [S3_TABLES],
    );
    expect(policies.rows.map((p) => p.tablename).sort()).toEqual([...S3_TABLES].sort());
    for (const policy of policies.rows) {
      expect(policy.qual).toContain("current_setting('app.tenant_id'::text, true)");
      expect(policy.with_check).toBe(policy.qual);
    }
  });

  it('gives a new run and a new case their defaults', async () => {
    const { tenantId, workflowId } = await workspace();
    const runId = await insertRun(tenantId, workflowId);
    const run = (await pool().query('select * from test_runs where id = $1', [runId])).rows[0];
    expect(run).toMatchObject({
      tenant_id: tenantId,
      workflow_id: workflowId,
      status: 'new',
      run_at: null,
      completed_at: null,
      metrics: null,
      error_code: null,
      error_details: null,
      running_instance_id: null,
      cancel_requested: false,
      workflow_version_id: null,
      concurrency: 1,
    });
    expect(run.created_at).toBeInstanceOf(Date);
    expect(run.updated_at).toBeInstanceOf(Date);

    const caseId = await insertCase(tenantId, runId, 3);
    const row = (await pool().query('select * from test_case_executions where id = $1', [caseId])).rows[0];
    expect(row).toMatchObject({
      tenant_id: tenantId,
      test_run_id: runId,
      execution_id: null,
      status: 'new',
      run_index: 3,
      run_at: null,
      completed_at: null,
      error_code: null,
      error_details: null,
      metrics: null,
      inputs: null,
      outputs: null,
    });
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it('holds the planned column types and lengths', async () => {
    const { rows } = await pool().query<{
      table_name: string;
      column_name: string;
      data_type: string;
      character_maximum_length: number | null;
      is_nullable: 'YES' | 'NO';
    }>(
      `select table_name, column_name, data_type, character_maximum_length, is_nullable
       from information_schema.columns where table_name = any($1)`,
      [S3_TABLES],
    );
    const col = (table: string, name: string) =>
      rows.find((r) => r.table_name === table && r.column_name === name);
    expect(col('test_runs', 'status')).toMatchObject({ character_maximum_length: 16, is_nullable: 'NO' });
    expect(col('test_runs', 'error_code')).toMatchObject({
      character_maximum_length: 64,
      is_nullable: 'YES',
    });
    expect(col('test_runs', 'metrics')?.data_type).toBe('jsonb');
    expect(col('test_runs', 'running_instance_id')?.data_type).toBe('text');
    expect(col('test_runs', 'concurrency')).toMatchObject({ data_type: 'integer', is_nullable: 'NO' });
    expect(col('test_runs', 'run_at')?.data_type).toBe('timestamp with time zone');
    expect(col('test_case_executions', 'status')).toMatchObject({
      character_maximum_length: 24,
      is_nullable: 'NO',
    });
    expect(col('test_case_executions', 'error_code')?.character_maximum_length).toBe(64);
    expect(col('test_case_executions', 'run_index')).toMatchObject({
      data_type: 'integer',
      is_nullable: 'NO',
    });
    for (const name of ['error_details', 'metrics', 'inputs', 'outputs']) {
      expect(col('test_case_executions', name)?.data_type).toBe('jsonb');
    }
    expect(col('test_case_executions', 'updated_at')).toBeUndefined();
  });

  it('keeps the list index, the partial sweep index and the case index', async () => {
    const { rows } = await pool().query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = any($1)`,
      [S3_TABLES],
    );
    const def = (name: string) => rows.find((r) => r.indexname === name)?.indexdef ?? '';
    expect(def('test_runs_tenant_workflow_idx')).toContain('(tenant_id, workflow_id, created_at DESC)');
    expect(def('test_runs_active_status_idx')).toContain('(status) WHERE');
    expect(def('test_runs_active_status_idx')).toMatch(/'new'.*'running'/);
    expect(def('test_case_executions_run_idx')).toContain('(test_run_id, run_index)');
  });

  it('refuses a run without a workflow, a run of a missing workflow and a case of a missing run', async () => {
    const { tenantId, workflowId } = await workspace();
    expect(
      await codeOf(
        pool().query('insert into test_runs (tenant_id, workflow_id) values ($1, null)', [tenantId]),
      ),
    ).toBe(NOT_NULL_VIOLATION);
    expect(await codeOf(insertRun(tenantId, randomUUID()))).toBe(FK_VIOLATION);
    expect(await codeOf(insertCase(tenantId, randomUUID()))).toBe(FK_VIOLATION);
    const runId = await insertRun(tenantId, workflowId);
    expect(
      await codeOf(
        pool().query('insert into test_case_executions (tenant_id, test_run_id) values ($1, $2)', [
          tenantId,
          runId,
        ]),
      ),
    ).toBe(NOT_NULL_VIOLATION);
  });

  it('deletes runs and cases with their workflow; an execution delete leaves the case row', async () => {
    const { tenantId, workflowId } = await workspace();
    const other = await workspace();
    const otherRun = await insertRun(other.tenantId, other.workflowId);
    const runId = await insertRun(tenantId, workflowId);
    const executionId = await insertExecution(tenantId, workflowId);
    const caseId = await insertCase(tenantId, runId, 0, executionId);

    await pool().query('delete from executions where id = $1', [executionId]);
    const kept = await pool().query('select execution_id from test_case_executions where id = $1', [caseId]);
    expect(kept.rows).toEqual([{ execution_id: executionId }]);

    await pool().query('delete from workflows where id = $1', [workflowId]);
    expect((await pool().query('select id from test_runs where id = $1', [runId])).rows).toEqual([]);
    expect((await pool().query('select id from test_case_executions where id = $1', [caseId])).rows).toEqual(
      [],
    );
    // another workflow's run is untouched
    expect((await pool().query('select id from test_runs where id = $1', [otherRun])).rows).toHaveLength(1);
  });

  it('deletes a run with its cases and every row with its tenant', async () => {
    const a = await workspace();
    const runA = await insertRun(a.tenantId, a.workflowId);
    await insertCase(a.tenantId, runA, 0);
    await insertCase(a.tenantId, runA, 1);
    await pool().query('delete from test_runs where id = $1', [runA]);
    expect((await pool().query('select count(*)::int as n from test_case_executions')).rows[0].n).toBe(0);

    const runB = await insertRun(a.tenantId, a.workflowId);
    await insertCase(a.tenantId, runB, 0);
    await pool().query('delete from tenants where id = $1', [a.tenantId]);
    for (const table of S3_TABLES) {
      expect((await pool().query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
    }
  });

  it('denies a non-owner role every row outside its tenant on both tables', async () => {
    const a = await workspace();
    const b = await workspace();
    for (const ws of [a, b]) {
      const runId = await insertRun(ws.tenantId, ws.workflowId);
      await insertCase(ws.tenantId, runId);
    }
    const runOfB = (await pool().query('select id from test_runs where tenant_id = $1', [b.tenantId])).rows[0]
      .id;
    await pool().query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workflow_rls_probe') THEN
        CREATE ROLE workflow_rls_probe NOLOGIN;
      END IF;
    END $$`);
    await pool().query(`GRANT SELECT, INSERT ON ${S3_TABLES.join(', ')} TO workflow_rls_probe`);
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE workflow_rls_probe');
      for (const table of S3_TABLES) {
        // no tenant set: nothing is visible
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
      }
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
      for (const table of S3_TABLES) {
        expect((await client.query(`SELECT tenant_id FROM ${table}`)).rows).toEqual([
          { tenant_id: a.tenantId },
        ]);
      }
      // with check: a write into the other tenant is refused on both tables
      await client.query('SAVEPOINT probe');
      expect(
        await codeOf(
          client.query('INSERT INTO test_runs (tenant_id, workflow_id) VALUES ($1, $2)', [
            b.tenantId,
            b.workflowId,
          ]),
        ),
      ).toBe(RLS_VIOLATION);
      await client.query('ROLLBACK TO SAVEPOINT probe');
      expect(
        await codeOf(
          client.query(
            'INSERT INTO test_case_executions (tenant_id, test_run_id, run_index) VALUES ($1, $2, 0)',
            [b.tenantId, runOfB],
          ),
        ),
      ).toBe(RLS_VIOLATION);
      await client.query('ROLLBACK TO SAVEPOINT probe');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // the application role (table owner) is not restricted
    for (const table of S3_TABLES) {
      expect((await pool().query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(2);
    }
  });

  it('empties both tables on a test database reset', async () => {
    const { tenantId, workflowId } = await workspace();
    await insertCase(tenantId, await insertRun(tenantId, workflowId));
    await resetDatabase(server.ctx);
    for (const table of S3_TABLES) {
      expect((await pool().query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
    }
  });
});

describe('C0d1 exports', () => {
  it('maps the schema columns lanes use', () => {
    expect(Object.keys(getTableColumns(testRuns)).sort()).toEqual(
      [
        'id',
        'tenantId',
        'workflowId',
        'status',
        'runAt',
        'completedAt',
        'metrics',
        'errorCode',
        'errorDetails',
        'runningInstanceId',
        'cancelRequested',
        'workflowVersionId',
        'concurrency',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(Object.keys(getTableColumns(testCaseExecutions)).sort()).toEqual(
      [
        'id',
        'tenantId',
        'testRunId',
        'executionId',
        'status',
        'runIndex',
        'runAt',
        'completedAt',
        'errorCode',
        'errorDetails',
        'metrics',
        'inputs',
        'outputs',
        'createdAt',
      ].sort(),
    );
  });

  it('registers testRuns with every method of the final signature', () => {
    const repo = server.ctx.repos.testRuns;
    expect(repo).toBeInstanceOf(TestRunRepository);
    for (const method of [
      'create',
      'get',
      'list',
      'update',
      'delete',
      'requestCancel',
      'seedCases',
      'listCases',
      'getCase',
      'updateCase',
      'cancelPendingCases',
      'cancelUnfinishedCases',
      'caseCounts',
      'touch',
      'listStale',
    ] as const) {
      expect(typeof repo[method]).toBe('function');
    }
  });
});
