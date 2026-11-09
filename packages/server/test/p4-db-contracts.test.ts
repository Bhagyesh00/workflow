/**
 * Phase 4 contract step (C0b): migrations 0012 and 0013. Checks what Postgres really holds: tables,
 * row-level security, constraints, cascades and defaults. The schema.ts exports lanes build on are checked too.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client';
import {
  credentials,
  dataTableColumns,
  dataTableRows,
  dataTables,
  secretConnections,
} from '../src/db/schema';
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

const P4_TABLES = ['data_tables', 'data_table_columns', 'data_table_rows', 'secret_connections'];
const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const RLS_VIOLATION = '42501';

async function insertTable(tenantId: string, name = `t_${randomUUID().slice(0, 8)}`): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `insert into data_tables (tenant_id, name, project_id) values ($1, $2, (select id from projects where tenant_id = $1 and type = 'team' order by created_at, id limit 1)) returning id`,
    [tenantId, name],
  );
  return rows[0].id;
}

async function insertColumn(
  tenantId: string,
  tableId: string,
  name = 'city',
  type = 'string',
): Promise<string> {
  const id = randomUUID();
  await pool().query(
    'insert into data_table_columns (id, tenant_id, table_id, name, type, position) values ($1, $2, $3, $4, $5, 0)',
    [id, tenantId, tableId, name, type],
  );
  return id;
}

async function insertRow(tenantId: string, tableId: string, rowId = 1): Promise<void> {
  await pool().query(
    'insert into data_table_rows (tenant_id, table_id, row_id, size_bytes) values ($1, $2, $3, 2)',
    [tenantId, tableId, rowId],
  );
}

async function insertConnection(
  tenantId: string,
  providerKey = `vault_${randomUUID().slice(0, 8)}`,
  createdBy: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await pool().query(
    `insert into secret_connections (id, tenant_id, provider_key, type, settings_enc, created_by)
     values ($1, $2, $3, 'vault', 'enc', $4)`,
    [id, tenantId, providerKey, createdBy],
  );
  return id;
}

/** rejects with the Postgres error code of the failing statement */
async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('Phase 4 migrations', () => {
  it('journals 0012 and 0013 in order, newer than every earlier migration', () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    expect(journal.entries.map((e) => `${e.idx}:${e.tag}`).slice(12, 14)).toEqual([
      '12:0012_data_tables',
      '13:0013_secret_connections',
    ]);
    // the migrator applies only entries newer than the last applied one
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
    }
  });

  it('keeps row-level security and the tenant_isolation policy on the 4 new tables', async () => {
    const { rows } = await pool().query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname = any($1) and relkind = 'r'`,
      [P4_TABLES],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...P4_TABLES].sort());
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    const policies = await pool().query<{ tablename: string }>(
      `select tablename from pg_policies where policyname = 'tenant_isolation' and tablename = any($1)`,
      [P4_TABLES],
    );
    expect(policies.rows).toHaveLength(P4_TABLES.length);
  });

  it('denies a non-owner role every row outside its tenant on the 4 new tables', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    for (const tenantId of [a.tenant.id, b.tenant.id]) {
      const tableId = await insertTable(tenantId);
      await insertColumn(tenantId, tableId);
      await insertRow(tenantId, tableId);
      await insertConnection(tenantId);
    }
    await pool().query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workflow_rls_probe') THEN
        CREATE ROLE workflow_rls_probe NOLOGIN;
      END IF;
    END $$`);
    await pool().query(`GRANT SELECT, INSERT ON ${P4_TABLES.join(', ')} TO workflow_rls_probe`);
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE workflow_rls_probe');
      for (const table of P4_TABLES) {
        // no tenant set: nothing is visible
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
      }
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenant.id]);
      for (const table of P4_TABLES) {
        expect((await client.query(`SELECT tenant_id FROM ${table}`)).rows).toEqual([
          { tenant_id: a.tenant.id },
        ]);
      }
      // with check: a write into the other tenant is refused
      await client.query('SAVEPOINT probe');
      const code = await codeOf(
        client.query(`INSERT INTO data_tables (tenant_id, name) VALUES ($1, 'stolen')`, [b.tenant.id]),
      );
      expect(code).toBe(RLS_VIOLATION);
      await client.query('ROLLBACK TO SAVEPOINT probe');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // the application role (table owner) is not restricted
    for (const table of P4_TABLES) {
      expect((await pool().query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(2);
    }
  });
});

describe('0012_data_tables', () => {
  it('gives a new table its defaults and a unique name per tenant', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const id = await insertTable(a.tenant.id, 'orders');
    const { rows } = await pool().query(
      'select next_row_id::int as next_row_id, created_at, updated_at from data_tables where id = $1',
      [id],
    );
    expect(rows[0].next_row_id).toBe(1);
    expect(rows[0].created_at).toBeInstanceOf(Date);
    expect(rows[0].updated_at).toBeInstanceOf(Date);
    expect(await codeOf(insertTable(a.tenant.id, 'orders'))).toBe(UNIQUE_VIOLATION);
    await expect(insertTable(b.tenant.id, 'orders')).resolves.toBeTypeOf('string');
  });

  it('caps the table name at 128 and the column name at 63 characters', async () => {
    const a = await signup(server.app);
    await expect(insertTable(a.tenant.id, 'x'.repeat(128))).resolves.toBeTypeOf('string');
    expect(await codeOf(insertTable(a.tenant.id, 'x'.repeat(129)))).toBe('22001');
    const tableId = await insertTable(a.tenant.id);
    await expect(insertColumn(a.tenant.id, tableId, 'c'.repeat(63))).resolves.toBeTypeOf('string');
    expect(await codeOf(insertColumn(a.tenant.id, tableId, 'c'.repeat(64)))).toBe('22001');
  });

  it('accepts the 4 column types only and a column name once per table', async () => {
    const a = await signup(server.app);
    const tableId = await insertTable(a.tenant.id);
    for (const type of ['string', 'number', 'boolean', 'date']) {
      await expect(insertColumn(a.tenant.id, tableId, `c_${type}`, type)).resolves.toBeTypeOf('string');
    }
    expect(await codeOf(insertColumn(a.tenant.id, tableId, 'c_json', 'json'))).toBe(CHECK_VIOLATION);
    expect(await codeOf(insertColumn(a.tenant.id, tableId, 'c_date', 'string'))).toBe(UNIQUE_VIOLATION);
  });

  it('gives a row an empty data object and one row id per table', async () => {
    const a = await signup(server.app);
    const tableId = await insertTable(a.tenant.id);
    const other = await insertTable(a.tenant.id);
    await insertRow(a.tenant.id, tableId, 7);
    await insertRow(a.tenant.id, other, 7);
    const { rows } = await pool().query('select data, size_bytes from data_table_rows where table_id = $1', [
      tableId,
    ]);
    expect(rows).toEqual([{ data: {}, size_bytes: 2 }]);
    expect(await codeOf(insertRow(a.tenant.id, tableId, 7))).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a column or a row that names another tenant for the table', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const tableId = await insertTable(a.tenant.id);
    expect(await codeOf(insertColumn(b.tenant.id, tableId))).toBe(FK_VIOLATION);
    expect(await codeOf(insertRow(b.tenant.id, tableId))).toBe(FK_VIOLATION);
  });

  it('removes columns and rows with their table, and everything with the tenant', async () => {
    const a = await signup(server.app);
    const dropped = await insertTable(a.tenant.id);
    await insertColumn(a.tenant.id, dropped);
    await insertRow(a.tenant.id, dropped);
    const kept = await insertTable(a.tenant.id);
    await insertColumn(a.tenant.id, kept);
    await insertRow(a.tenant.id, kept);

    await pool().query('delete from data_tables where id = $1', [dropped]);
    const left = async (table: string) =>
      (await pool().query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n;
    expect(await left('data_table_columns')).toBe(1);
    expect(await left('data_table_rows')).toBe(1);

    await pool().query('delete from tenants where id = $1', [a.tenant.id]);
    expect(await left('data_tables')).toBe(0);
    expect(await left('data_table_columns')).toBe(0);
    expect(await left('data_table_rows')).toBe(0);
  });

  it('indexes columns by position and rows by tenant and table', async () => {
    const { rows } = await pool().query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = any($1)`,
      [['data_table_columns', 'data_table_rows']],
    );
    const defs = rows.map((r) => r.indexdef);
    expect(defs.some((d) => d.includes('data_table_columns') && d.includes('(table_id, "position")'))).toBe(
      true,
    );
    expect(defs.some((d) => d.includes('data_table_rows') && d.includes('(tenant_id, table_id)'))).toBe(true);
  });

  it("lets a favorite point at a 'dataTable' and still refuses other types", async () => {
    const a = await signup(server.app);
    const insert = (resourceType: string) =>
      pool().query(
        'insert into user_favorites (tenant_id, user_id, resource_type, resource_id) values ($1, $2, $3, $4)',
        [a.tenant.id, a.user.id, resourceType, randomUUID()],
      );
    for (const type of ['workflow', 'folder', 'dataTable']) {
      await expect(insert(type)).resolves.toBeDefined();
    }
    expect(await codeOf(insert('credential'))).toBe(CHECK_VIOLATION);
  });
});

describe('0013_secret_connections', () => {
  it('gives a new connection its defaults and a unique provider key per tenant', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const id = await insertConnection(a.tenant.id, 'vault_main');
    const { rows } = await pool().query(
      'select is_enabled, state, last_error, created_by from secret_connections where id = $1',
      [id],
    );
    expect(rows).toEqual([{ is_enabled: false, state: 'initializing', last_error: null, created_by: null }]);
    expect(await codeOf(insertConnection(a.tenant.id, 'vault_main'))).toBe(UNIQUE_VIOLATION);
    await expect(insertConnection(b.tenant.id, 'vault_main')).resolves.toBeTypeOf('string');
  });

  it('keeps a connection when its creator goes and removes it with the tenant', async () => {
    const a = await signup(server.app);
    const extra = await pool().query<{ id: string }>(
      `insert into users (email, name, password_hash) values ($1, 'gone', 'x') returning id`,
      [`gone-${randomUUID().slice(0, 8)}@example.com`],
    );
    const id = await insertConnection(a.tenant.id, 'vault_main', extra.rows[0].id);
    await pool().query('delete from users where id = $1', [extra.rows[0].id]);
    const { rows } = await pool().query('select created_by from secret_connections where id = $1', [id]);
    expect(rows).toEqual([{ created_by: null }]);
    await pool().query('delete from tenants where id = $1', [a.tenant.id]);
    expect((await pool().query('select id from secret_connections where id = $1', [id])).rows).toEqual([]);
  });

  it('defaults credentials.secret_keys to an empty array that cannot be null', async () => {
    const a = await signup(server.app);
    const id = randomUUID();
    await pool().query(
      `insert into credentials (id, tenant_id, name, type, data_enc, project_id)
       values ($1, $2, 'c', 't', 'e', (select id from projects where tenant_id = $2 and type = 'team' order by created_at, id limit 1))`,
      [id, a.tenant.id],
    );
    const { rows } = await pool().query('select secret_keys from credentials where id = $1', [id]);
    expect(rows).toEqual([{ secret_keys: [] }]);
    expect(await codeOf(pool().query('update credentials set secret_keys = null where id = $1', [id]))).toBe(
      '23502',
    );
    await pool().query(`update credentials set secret_keys = '{API_KEY,DB_PASSWORD}' where id = $1`, [id]);
    expect(
      (await pool().query('select secret_keys from credentials where id = $1', [id])).rows[0].secret_keys,
    ).toEqual(['API_KEY', 'DB_PASSWORD']);
  });
});

describe('schema.ts names the lanes build on', () => {
  it('exports the 4 tables with camelCase fields', () => {
    expect(Object.keys(getTableColumns(dataTables)).sort()).toEqual(
      // P6 S1 (0022): the owning project
      ['createdAt', 'id', 'name', 'nextRowId', 'projectId', 'tenantId', 'updatedAt'].sort(),
    );
    expect(Object.keys(getTableColumns(dataTableColumns)).sort()).toEqual(
      ['createdAt', 'id', 'name', 'position', 'tableId', 'tenantId', 'type', 'updatedAt'].sort(),
    );
    expect(Object.keys(getTableColumns(dataTableRows)).sort()).toEqual(
      ['createdAt', 'data', 'rowId', 'sizeBytes', 'tableId', 'tenantId', 'updatedAt'].sort(),
    );
    expect(Object.keys(getTableColumns(secretConnections)).sort()).toEqual(
      [
        'createdAt',
        'createdBy',
        'id',
        'isEnabled',
        'lastError',
        // P6 S1 (0023): null = a workspace vault, else the project's
        'projectId',
        'providerKey',
        'settingsEnc',
        'state',
        'tenantId',
        'type',
        'updatedAt',
      ].sort(),
    );
    expect(Object.keys(getTableColumns(credentials))).toContain('secretKeys');
  });
});
