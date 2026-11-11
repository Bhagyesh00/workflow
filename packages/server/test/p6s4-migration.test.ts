/**
 * Phase 6 S4 contract step (C0b): migration 0035 (Git source control settings and the sync id map). It rebuilds
 * its own database from 0000, makes two workspaces of the old shape, applies 0035 and checks what Postgres holds.
 * Raw SQL only, no repository.
 *
 * It drops the `public` schema, so it only ever runs against `workflow_test_p6_s4_migrate` (the host of
 * TEST_DATABASE_URL, the database name replaced) and refuses any other database.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client';

const MIGRATE_DB = 'workflow_test_p6_s4_migrate';
const NEW_TAG = '0035_source_control';
/** the tenant tables of S4: RLS with the tenant_isolation policy */
const TENANT_TABLES = ['source_control_settings', 'sync_id_map'];
const RESOURCE_TYPES = ['workflow', 'credential', 'variable', 'tag', 'folder', 'datatable', 'project'];
const POLICY = "(tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)";
const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
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

let pool: pg.Pool;

async function apply(tags: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    for (const tag of tags) {
      await client.query('BEGIN');
      try {
        for (const statement of statements(tag)) await client.query(statement);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${tag} failed: ${(error as Error).message}`);
      }
    }
  } finally {
    client.release();
  }
}

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

interface OldWorkspace {
  tenantId: string;
  owner: string;
  workflowId: string;
}

let seq = 0;

/** a workspace as it looked after 0034: an owner and a workflow in a team project */
async function seedOld(label: string): Promise<OldWorkspace> {
  const { tenantId } = await one<{ tenantId: string }>(
    'insert into tenants (name, slug) values ($1, $2) returning id as "tenantId"',
    [`Workspace ${label}`, `ws-${label.toLowerCase()}-${++seq}`],
  );
  const { id: owner } = await one<{ id: string }>(
    `insert into users (email, name, password_hash) values ($1, $2, 'x') returning id`,
    [`owner-${label.toLowerCase()}-${seq}@example.com`, `owner ${label}`],
  );
  await pool.query(`insert into memberships (tenant_id, user_id, role) values ($1, $2, 'owner')`, [
    tenantId,
    owner,
  ]);
  const { id: projectId } = await one<{ id: string }>(
    `insert into projects (tenant_id, name, type) values ($1, 'Team', 'team') returning id`,
    [tenantId],
  );
  const { id: workflowId } = await one<{ id: string }>(
    `insert into workflows (tenant_id, name, project_id, version_id) values ($1, 'Flow', $2, gen_random_uuid())
     returning id`,
    [tenantId, projectId],
  );
  return { tenantId, owner, workflowId };
}

/** one settings row (all defaults) and one map row in workspace `w` */
async function seedNew(client: pg.PoolClient, w: OldWorkspace, gitId = 'git-1'): Promise<void> {
  await client.query('insert into source_control_settings (tenant_id) values ($1)', [w.tenantId]);
  await client.query(
    `insert into sync_id_map (tenant_id, resource_type, git_id, local_id) values ($1, 'workflow', $2, $3)`,
    [w.tenantId, gitId, w.workflowId],
  );
}

let a: OldWorkspace;
let b: OldWorkspace;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: migrateUrl(), max: 4 });
  pool.on('error', () => {});
  const { current } = await one<{ current: string }>('select current_database() as current');
  if (current !== MIGRATE_DB) {
    throw new Error(`p6s4-migration only runs against ${MIGRATE_DB}, not ${current}`);
  }
  const hadVector = (await pool.query(`select 1 from pg_extension where extname = 'vector'`)).rows.length > 0;
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  // as a fresh database's public schema: every role may use it (the RLS probe role below needs this)
  await pool.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
  if (hadVector) await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

  const tags = journal().map((e) => e.tag);
  const index = tags.indexOf(NEW_TAG);
  expect(index).toBe(35);
  await apply(tags.slice(0, index));
  a = await seedOld('A');
  b = await seedOld('B');
  await apply([NEW_TAG]);
}, 120_000);

afterAll(async () => {
  await pool?.end();
});

describe('0035 journal and snapshot', () => {
  it('journals 0035 after 0034, each newer than every earlier migration', () => {
    const entries = journal();
    // bounded, so a later stage's 0036 keeps this green
    expect(entries.map((e) => `${e.idx}:${e.tag}`).slice(34, 36)).toEqual([
      '34:0034_public_api_idempotency',
      `35:${NEW_TAG}`,
    ]);
    expect(entries[35].when).toBeGreaterThan(1794342276160);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].when).toBeGreaterThan(entries[i - 1].when);
    }
  });

  it('chains the 0035 snapshot to 0034 and holds both tables', () => {
    const read = (n: number) =>
      JSON.parse(
        readFileSync(
          path.join(migrationsFolder, 'meta', `${String(n).padStart(4, '0')}_snapshot.json`),
          'utf8',
        ),
      ) as { id: string; prevId: string; tables: Record<string, unknown> };
    expect(read(35).prevId).toBe(read(34).id);
    for (const table of TENANT_TABLES) expect(Object.keys(read(35).tables)).toContain(`public.${table}`);
  });
});

describe('0035 source_control_settings', () => {
  it('has the columns of the plan and no read-only column', async () => {
    const { rows } = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      character_maximum_length: number | null;
    }>(
      `select column_name, data_type, is_nullable, character_maximum_length from information_schema.columns
       where table_schema = 'public' and table_name = 'source_control_settings' order by ordinal_position`,
    );
    expect(rows.map((r) => [r.column_name, r.data_type, r.is_nullable, r.character_maximum_length])).toEqual([
      ['tenant_id', 'uuid', 'NO', null],
      ['repository_url', 'text', 'YES', null],
      ['connection_type', 'text', 'NO', null],
      ['branch_name', 'character varying', 'NO', 255],
      ['branch_color', 'character varying', 'NO', 16],
      ['connected', 'boolean', 'NO', null],
      ['key_type', 'text', 'NO', null],
      ['public_key', 'text', 'YES', null],
      ['private_key_enc', 'text', 'YES', null],
      ['https_username', 'character varying', 'YES', 255],
      ['https_password_enc', 'text', 'YES', null],
      ['host_key_fingerprint', 'text', 'YES', null],
      ['locked_until', 'timestamp with time zone', 'YES', null],
      ['updated_at', 'timestamp with time zone', 'NO', null],
    ]);
    expect(rows.some((r) => r.column_name.includes('read_only'))).toBe(false);
  });

  it('fills the defaults and keeps one row per workspace', async () => {
    const code = await codeOf(async (client) => {
      await client.query('insert into source_control_settings (tenant_id) values ($1)', [a.tenantId]);
      const { rows } = await client.query('select * from source_control_settings where tenant_id = $1', [
        a.tenantId,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        repository_url: null,
        connection_type: 'ssh',
        branch_name: 'main',
        branch_color: '#5296D6',
        connected: false,
        key_type: 'ed25519',
        public_key: null,
        private_key_enc: null,
        https_username: null,
        https_password_enc: null,
        host_key_fingerprint: null,
        locked_until: null,
      });
      expect(rows[0].updated_at).toBeInstanceOf(Date);
      await client.query('insert into source_control_settings (tenant_id) values ($1)', [a.tenantId]);
    });
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('accepts https and rsa, refuses another connection type or key type', async () => {
    expect(
      await codeOf((client) =>
        client.query(
          `insert into source_control_settings (tenant_id, connection_type, key_type) values ($1, 'https', 'rsa')`,
          [a.tenantId],
        ),
      ),
    ).toBeUndefined();
    expect(
      await codeOf((client) =>
        client.query(`insert into source_control_settings (tenant_id, connection_type) values ($1, 'ftp')`, [
          a.tenantId,
        ]),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await codeOf((client) =>
        client.query(`insert into source_control_settings (tenant_id, key_type) values ($1, 'dsa')`, [
          a.tenantId,
        ]),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('refuses an unknown tenant', async () => {
    expect(
      await codeOf((client) =>
        client.query('insert into source_control_settings (tenant_id) values (gen_random_uuid())'),
      ),
    ).toBe(FK_VIOLATION);
  });
});

describe('0035 sync_id_map', () => {
  it('has the columns of the plan', async () => {
    const { rows } = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      character_maximum_length: number | null;
    }>(
      `select column_name, data_type, is_nullable, character_maximum_length from information_schema.columns
       where table_schema = 'public' and table_name = 'sync_id_map' order by ordinal_position`,
    );
    expect(rows.map((r) => [r.column_name, r.data_type, r.is_nullable, r.character_maximum_length])).toEqual([
      ['tenant_id', 'uuid', 'NO', null],
      ['resource_type', 'text', 'NO', null],
      ['git_id', 'character varying', 'NO', 64],
      ['local_id', 'uuid', 'NO', null],
      ['git_version_id', 'character varying', 'YES', 64],
      ['local_version_id', 'character varying', 'YES', 64],
      ['updated_at', 'timestamp with time zone', 'NO', null],
    ]);
  });

  it('keys rows by (tenant, resource type, git id) and refuses a second row with the same local id', async () => {
    const insert = (
      client: pg.PoolClient,
      type: string,
      gitId: string,
      localId: string,
      tenantId = a.tenantId,
    ) =>
      client.query(
        'insert into sync_id_map (tenant_id, resource_type, git_id, local_id) values ($1, $2, $3, $4)',
        [tenantId, type, gitId, localId],
      );
    // same git id twice: primary key
    expect(
      await codeOf(async (client) => {
        await insert(client, 'workflow', 'g1', a.workflowId);
        await insert(client, 'workflow', 'g1', b.workflowId);
      }),
    ).toBe(UNIQUE_VIOLATION);
    // same local id under another git id: unique (tenant_id, resource_type, local_id)
    expect(
      await codeOf(async (client) => {
        await insert(client, 'workflow', 'g1', a.workflowId);
        await insert(client, 'workflow', 'g2', a.workflowId);
      }),
    ).toBe(UNIQUE_VIOLATION);
    // the same ids under another resource type or in another workspace are other rows
    expect(
      await codeOf(async (client) => {
        await insert(client, 'workflow', 'g1', a.workflowId);
        await insert(client, 'project', 'g1', a.workflowId);
        await insert(client, 'workflow', 'g1', a.workflowId, b.tenantId);
        const { rows } = await client.query('select count(*)::int as n from sync_id_map');
        expect(rows[0].n).toBe(3);
      }),
    ).toBeUndefined();
  });

  it('accepts the seven resource types and refuses another', async () => {
    expect(
      await codeOf(async (client) => {
        for (const [i, type] of RESOURCE_TYPES.entries()) {
          await client.query(
            `insert into sync_id_map (tenant_id, resource_type, git_id, local_id, git_version_id, local_version_id)
             values ($1, $2, $3, gen_random_uuid(), 'gv', 'lv')`,
            [a.tenantId, type, `g${i}`],
          );
        }
      }),
    ).toBeUndefined();
    expect(
      await codeOf((client) =>
        client.query(
          `insert into sync_id_map (tenant_id, resource_type, git_id, local_id) values ($1, 'execution', 'g', gen_random_uuid())`,
          [a.tenantId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await codeOf((client) =>
        client.query(
          `insert into sync_id_map (tenant_id, resource_type, git_id) values ($1, 'workflow', 'g')`,
          [a.tenantId],
        ),
      ),
    ).toBe(NOT_NULL_VIOLATION);
  });

  it('has no foreign key to the resources: a deleted workflow leaves its row for the sync to remove', async () => {
    const { rows } = await pool.query<{ conname: string }>(
      `select conname from pg_constraint where conrelid = 'sync_id_map'::regclass and contype = 'f'`,
    );
    expect(rows.map((r) => r.conname)).toEqual(['sync_id_map_tenant_id_tenants_id_fk']);
    expect(
      await codeOf(async (client) => {
        await seedNew(client, a);
        await client.query('delete from workflows where id = $1', [a.workflowId]);
        const left = await client.query('select local_id from sync_id_map where tenant_id = $1', [
          a.tenantId,
        ]);
        expect(left.rows).toEqual([{ local_id: a.workflowId }]);
      }),
    ).toBeUndefined();
  });
});

describe('0035 tenant delete', () => {
  it('removes the settings row and the map rows of that workspace only', async () => {
    expect(
      await codeOf(async (client) => {
        await seedNew(client, a);
        await seedNew(client, b);
        await client.query('delete from tenants where id = $1', [a.tenantId]);
        for (const table of TENANT_TABLES) {
          const { rows } = await client.query(`select tenant_id from ${table}`);
          expect(rows, table).toEqual([{ tenant_id: b.tenantId }]);
        }
      }),
    ).toBeUndefined();
  });
});

describe('0035 row-level security', () => {
  it('enables RLS with the tenant_isolation policy on both tables', async () => {
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
      for (const w of [a, b]) await seedNew(client, w);
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
        .query(
          `INSERT INTO sync_id_map (tenant_id, resource_type, git_id, local_id) VALUES ($1, 'tag', 'g', gen_random_uuid())`,
          [b.tenantId],
        )
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
