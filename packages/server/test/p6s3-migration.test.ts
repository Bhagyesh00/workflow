/**
 * Phase 6 S3 contract step (C0b): migrations 0032 (node and credential type policies), 0033 (insights) and 0034
 * (public API idempotency keys). It rebuilds its own database from 0000, inserts rows of the old shape, applies
 * 0032 to 0034 and checks what Postgres holds. Raw SQL only, no repository.
 *
 * It drops the `public` schema, so it only ever runs against `workflow_test_p6_s3_migrate` (the host of
 * TEST_DATABASE_URL, the database name replaced) and refuses any other database.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client';

const MIGRATE_DB = 'workflow_test_p6_s3_migrate';
const NEW_TAGS = ['0032_type_policies', '0033_insights', '0034_public_api_idempotency'];
/** the tenant tables of S3: RLS with the tenant_isolation policy */
const TENANT_TABLES = [
  'type_policy_scopes',
  'type_policies',
  'type_policy_attachments',
  'insights_metadata',
  'insights_by_period',
  'public_api_idempotency',
];
const POLICY = "(tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)";
const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

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
      // the checks a commit runs (the deferred type_policy_attachments_policy_fk), without committing
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

async function first<T extends pg.QueryResultRow>(
  client: pg.PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const { rows } = await client.query<T>(sql, params);
  expect(rows).toHaveLength(1);
  return rows[0];
}

interface OldWorkspace {
  tenantId: string;
  owner: string;
  projectId: string;
  otherProjectId: string;
  workflowId: string;
}

let seq = 0;

/** a workspace as it looked after 0031: an owner, two team projects, a workflow in the first (it holds the first project) */
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
  const project = async (name: string) =>
    (
      await one<{ id: string }>(
        `insert into projects (tenant_id, name, type) values ($1, $2, 'team') returning id`,
        [tenantId, name],
      )
    ).id;
  const projectId = await project('Team');
  const otherProjectId = await project('Other');
  const { id: workflowId } = await one<{ id: string }>(
    `insert into workflows (tenant_id, name, project_id, version_id) values ($1, 'Flow', $2, gen_random_uuid())
     returning id`,
    [tenantId, projectId],
  );
  return { tenantId, owner, projectId, otherProjectId, workflowId };
}

/** one row of each S3 tenant table in workspace `w`; returns the ids it made */
async function seedNew(client: pg.PoolClient, w: OldWorkspace) {
  const { id: scopeId } = await first<{ id: string }>(
    client,
    `insert into type_policy_scopes (tenant_id, kind, project_id, default_action)
     values ($1, 'node', $2, 'deny') returning id`,
    [w.tenantId, w.otherProjectId],
  );
  const { id: policyId } = await first<{ id: string }>(
    client,
    `insert into type_policies (tenant_id, kind, name, rules) values ($1, 'node', $2, '[]') returning id`,
    [w.tenantId, `Policy ${++seq}`],
  );
  await client.query(
    'insert into type_policy_attachments (tenant_id, scope_id, policy_id, priority) values ($1, $2, $3, 0)',
    [w.tenantId, scopeId, policyId],
  );
  const { id: metaId } = await first<{ id: string }>(
    client,
    `insert into insights_metadata (tenant_id, workflow_id, workflow_name, project_id, project_name)
     values ($1, $2, 'Flow', $3, 'Other') returning id`,
    [w.tenantId, w.workflowId, w.otherProjectId],
  );
  await client.query(
    `insert into insights_by_period (tenant_id, meta_id, type, period_unit, period_start, value)
     values ($1, $2, 2, 0, date_trunc('hour', now()), 3)`,
    [w.tenantId, metaId],
  );
  await client.query(
    `insert into public_api_idempotency (tenant_id, user_id, key, fingerprint, status)
     values ($1, $2, 'key-1', 'fp', 'in_progress')`,
    [w.tenantId, w.owner],
  );
  return { scopeId, policyId, metaId };
}

let a: OldWorkspace;
let b: OldWorkspace;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: migrateUrl(), max: 4 });
  pool.on('error', () => {});
  const { current } = await one<{ current: string }>('select current_database() as current');
  if (current !== MIGRATE_DB) {
    throw new Error(`p6s3-migration only runs against ${MIGRATE_DB}, not ${current}`);
  }
  const hadVector = (await pool.query(`select 1 from pg_extension where extname = 'vector'`)).rows.length > 0;
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  // as a fresh database's public schema: every role may use it (the RLS probe role below needs this)
  await pool.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
  if (hadVector) await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

  const tags = journal().map((e) => e.tag);
  const firstNew = tags.indexOf(NEW_TAGS[0]);
  expect(firstNew).toBe(32);
  await apply(tags.slice(0, firstNew));
  a = await seedOld('A');
  b = await seedOld('B');
  await apply(tags.slice(firstNew, firstNew + NEW_TAGS.length));
}, 120_000);

afterAll(async () => {
  await pool?.end();
});

describe('0032 to 0034 journal and snapshots', () => {
  it('journals 0032 to 0034 after 0031, each newer than every earlier migration', () => {
    const entries = journal();
    // bounded, so a later stage's 0035 keeps this green
    expect(entries.map((e) => `${e.idx}:${e.tag}`).slice(31, 35)).toEqual([
      '31:0031_oauth_jwe_keys',
      ...NEW_TAGS.map((tag, i) => `${32 + i}:${tag}`),
    ]);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].when).toBeGreaterThan(entries[i - 1].when);
    }
  });

  it('chains every new snapshot to the one before it', () => {
    const read = (n: number) =>
      JSON.parse(
        readFileSync(
          path.join(migrationsFolder, 'meta', `${String(n).padStart(4, '0')}_snapshot.json`),
          'utf8',
        ),
      ) as { id: string; prevId: string };
    for (let n = 32; n <= 34; n++) {
      expect(read(n).prevId, String(n)).toBe(read(n - 1).id);
    }
  });
});

describe('0032 type policies', () => {
  it('removes a project scope and its attachments when the project is deleted', async () => {
    const code = await codeOf(async (client) => {
      const { scopeId } = await seedNew(client, a);
      await client.query('delete from projects where id = $1', [a.otherProjectId]);
      const scopes = await client.query('select 1 from type_policy_scopes where id = $1', [scopeId]);
      expect(scopes.rows).toHaveLength(0);
      const attached = await client.query('select 1 from type_policy_attachments where scope_id = $1', [
        scopeId,
      ]);
      expect(attached.rows).toHaveLength(0);
      // the policy itself stays: only the scope belonged to the project
      const policies = await client.query('select 1 from type_policies where tenant_id = $1', [a.tenantId]);
      expect(policies.rows).toHaveLength(1);
    });
    expect(code).toBeUndefined();
  });

  it('refuses a project scope that delegates and accepts a workspace scope that does', async () => {
    const insert = (projectId: string | null, action: string) =>
      codeOf((client) =>
        client.query(
          `insert into type_policy_scopes (tenant_id, kind, project_id, default_action) values ($1, 'node', $2, $3)`,
          [a.tenantId, projectId, action],
        ),
      );
    expect(await insert(a.projectId, 'delegate')).toBe(CHECK_VIOLATION);
    expect(await insert(null, 'delegate')).toBeUndefined();
    expect(await insert(a.projectId, 'allow')).toBeUndefined();
    expect(await insert(null, 'block')).toBe(CHECK_VIOLATION);
  });

  it('refuses an unknown kind on scopes and policies', async () => {
    expect(
      await codeOf((client) =>
        client.query(
          `insert into type_policy_scopes (tenant_id, kind, default_action) values ($1, 'tool', 'allow')`,
          [a.tenantId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await codeOf((client) =>
        client.query(`insert into type_policies (tenant_id, kind, name) values ($1, 'tool', 'P')`, [
          a.tenantId,
        ]),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('keeps one workspace scope per kind and one project scope per kind and project', async () => {
    const twice = (projectId: string | null, kinds: [string, string]) =>
      codeOf(async (client) => {
        for (const kind of kinds) {
          await client.query(
            `insert into type_policy_scopes (tenant_id, kind, project_id, default_action) values ($1, $2, $3, 'deny')`,
            [a.tenantId, kind, projectId],
          );
        }
      });
    expect(await twice(null, ['node', 'node'])).toBe(UNIQUE_VIOLATION);
    expect(await twice(null, ['node', 'credential'])).toBeUndefined();
    expect(await twice(a.projectId, ['node', 'node'])).toBe(UNIQUE_VIOLATION);
    expect(await twice(a.projectId, ['credential', 'node'])).toBeUndefined();
    // a workspace scope and a project scope of the same kind live side by side
    expect(
      await codeOf(async (client) => {
        for (const projectId of [null, a.projectId, a.otherProjectId]) {
          await client.query(
            `insert into type_policy_scopes (tenant_id, kind, project_id, default_action) values ($1, 'node', $2, 'deny')`,
            [a.tenantId, projectId],
          );
        }
      }),
    ).toBeUndefined();
  });

  it('keeps policy names unique per workspace and kind', async () => {
    const two = (kinds: [string, string], tenants: [string, string]) =>
      codeOf(async (client) => {
        for (let i = 0; i < 2; i++) {
          await client.query(`insert into type_policies (tenant_id, kind, name) values ($1, $2, 'Same')`, [
            tenants[i],
            kinds[i],
          ]);
        }
      });
    expect(await two(['node', 'node'], [a.tenantId, a.tenantId])).toBe(UNIQUE_VIOLATION);
    expect(await two(['node', 'credential'], [a.tenantId, a.tenantId])).toBeUndefined();
    expect(await two(['node', 'node'], [a.tenantId, b.tenantId])).toBeUndefined();
  });

  it('refuses a cross-tenant attachment and accepts one inside the workspace', async () => {
    const attach = (tenantOfRow: string, scopeOwner: OldWorkspace, policyOwner: OldWorkspace) =>
      codeOf(async (client) => {
        const { scopeId } = await first<{ scopeId: string }>(
          client,
          `insert into type_policy_scopes (tenant_id, kind, default_action) values ($1, 'node', 'deny')
           returning id as "scopeId"`,
          [scopeOwner.tenantId],
        );
        const { policyId } = await first<{ policyId: string }>(
          client,
          `insert into type_policies (tenant_id, kind, name) values ($1, 'node', 'P') returning id as "policyId"`,
          [policyOwner.tenantId],
        );
        await client.query(
          'insert into type_policy_attachments (tenant_id, scope_id, policy_id, priority) values ($1, $2, $3, 0)',
          [tenantOfRow, scopeId, policyId],
        );
      });
    expect(await attach(a.tenantId, a, b)).toBe(FK_VIOLATION);
    expect(await attach(b.tenantId, a, b)).toBe(FK_VIOLATION);
    expect(await attach(a.tenantId, a, a)).toBeUndefined();
  });

  it('keeps priorities unique per scope and floor flag', async () => {
    const attachTwo = (floors: [boolean, boolean], priorities: [number, number]) =>
      codeOf(async (client) => {
        const { scopeId } = await first<{ scopeId: string }>(
          client,
          `insert into type_policy_scopes (tenant_id, kind, default_action) values ($1, 'node', 'delegate')
           returning id as "scopeId"`,
          [a.tenantId],
        );
        for (let i = 0; i < 2; i++) {
          const { policyId } = await first<{ policyId: string }>(
            client,
            `insert into type_policies (tenant_id, kind, name) values ($1, 'node', $2) returning id as "policyId"`,
            [a.tenantId, `P${i}`],
          );
          await client.query(
            `insert into type_policy_attachments (tenant_id, scope_id, policy_id, priority, is_floor)
             values ($1, $2, $3, $4, $5)`,
            [a.tenantId, scopeId, policyId, priorities[i], floors[i]],
          );
        }
      });
    expect(await attachTwo([false, false], [0, 0])).toBe(UNIQUE_VIOLATION);
    expect(await attachTwo([false, true], [0, 0])).toBeUndefined();
    expect(await attachTwo([false, false], [0, 1])).toBeUndefined();
  });

  it('refuses deleting an attached policy, but a tenant delete removes everything in one statement', async () => {
    expect(
      await codeOf(async (client) => {
        const { policyId } = await seedNew(client, a);
        await client.query('delete from type_policies where id = $1', [policyId]);
      }),
    ).toBe(FK_VIOLATION);
    const key = await one<{ condeferrable: boolean; condeferred: boolean; confdeltype: string }>(
      `select condeferrable, condeferred, confdeltype from pg_constraint
       where conname = 'type_policy_attachments_policy_fk'`,
    );
    // 'a' is NO ACTION
    expect(key).toEqual({ condeferrable: true, condeferred: true, confdeltype: 'a' });
    // committed on its own, the delete of an attached policy fails
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { policyId } = await seedNew(client, a);
      await client.query('delete from type_policies where id = $1', [policyId]);
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: FK_VIOLATION });
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    expect(
      await codeOf(async (client) => {
        await seedNew(client, a);
        await seedNew(client, b);
        await client.query('delete from tenants where id = $1', [a.tenantId]);
        for (const table of TENANT_TABLES) {
          const { rows } = await client.query<{ tenant_id: string }>(
            `select distinct tenant_id from ${table}`,
          );
          expect(rows, table).toEqual([{ tenant_id: b.tenantId }]);
        }
      }),
    ).toBeUndefined();
  });

  it('starts a scope at version 0 and a policy at version 1 with no rules', async () => {
    expect(
      await codeOf(async (client) => {
        const scope = await first<{ version: number }>(
          client,
          `insert into type_policy_scopes (tenant_id, kind, default_action) values ($1, 'credential', 'allow')
           returning version`,
          [a.tenantId],
        );
        expect(scope.version).toBe(0);
        const policy = await first<{ version: number; rules: unknown; description: string | null }>(
          client,
          `insert into type_policies (tenant_id, kind, name) values ($1, 'credential', 'P')
           returning version, rules, description`,
          [a.tenantId],
        );
        expect(policy).toEqual({ version: 1, rules: [], description: null });
      }),
    ).toBeUndefined();
  });
});

describe('0033 insights', () => {
  it('keeps the metadata row with project_id null when its project is deleted', async () => {
    expect(
      await codeOf(async (client) => {
        const { metaId } = await seedNew(client, a);
        await client.query('delete from projects where id = $1', [a.otherProjectId]);
        const row = await first(
          client,
          'select tenant_id, workflow_id, project_id, project_name from insights_metadata where id = $1',
          [metaId],
        );
        expect(row).toEqual({
          tenant_id: a.tenantId,
          workflow_id: a.workflowId,
          project_id: null,
          project_name: 'Other',
        });
      }),
    ).toBeUndefined();
  });

  it('keeps the metadata row and its numbers with workflow_id null when its workflow is deleted', async () => {
    expect(
      await codeOf(async (client) => {
        const { metaId } = await seedNew(client, a);
        await client.query('delete from workflows where id = $1', [a.workflowId]);
        const row = await first(
          client,
          'select tenant_id, workflow_id, workflow_name from insights_metadata where id = $1',
          [metaId],
        );
        expect(row).toEqual({ tenant_id: a.tenantId, workflow_id: null, workflow_name: 'Flow' });
        const numbers = await client.query('select value from insights_by_period where meta_id = $1', [
          metaId,
        ]);
        expect(numbers.rows).toEqual([{ value: '3' }]);
      }),
    ).toBeUndefined();
  });

  it('removes the numbers with their metadata row', async () => {
    expect(
      await codeOf(async (client) => {
        const { metaId } = await seedNew(client, a);
        await client.query('delete from insights_metadata where id = $1', [metaId]);
        const numbers = await client.query('select 1 from insights_by_period where meta_id = $1', [metaId]);
        expect(numbers.rows).toHaveLength(0);
      }),
    ).toBeUndefined();
  });

  it('refuses numbers that point at another tenant’s metadata row', async () => {
    expect(
      await codeOf(async (client) => {
        const { metaId } = await seedNew(client, a);
        await client.query(
          `insert into insights_by_period (tenant_id, meta_id, type, period_unit, period_start, value)
           values ($1, $2, 0, 1, date_trunc('day', now()), 1)`,
          [b.tenantId, metaId],
        );
      }),
    ).toBe(FK_VIOLATION);
  });

  it('refuses an unknown type or period unit and a second row of the same period', async () => {
    const number = (type: number, unit: number, twice = false) =>
      codeOf(async (client) => {
        const { metaId } = await seedNew(client, a);
        for (let i = 0; i < (twice ? 2 : 1); i++) {
          await client.query(
            `insert into insights_by_period (tenant_id, meta_id, type, period_unit, period_start, value)
             values ($1, $2, $3, $4, '2026-01-05T00:00:00Z', 1)`,
            [a.tenantId, metaId, type, unit],
          );
        }
      });
    expect(await number(4, 0)).toBe(CHECK_VIOLATION);
    expect(await number(-1, 0)).toBe(CHECK_VIOLATION);
    expect(await number(0, 3)).toBe(CHECK_VIOLATION);
    expect(await number(3, 2)).toBeUndefined();
    expect(await number(0, 0, true)).toBe(UNIQUE_VIOLATION);
  });

  it('keeps one metadata row per workflow and workspace', async () => {
    expect(
      await codeOf(async (client) => {
        await seedNew(client, a);
        await client.query(
          `insert into insights_metadata (tenant_id, workflow_id, workflow_name) values ($1, $2, 'Again')`,
          [a.tenantId, a.workflowId],
        );
      }),
    ).toBe(UNIQUE_VIOLATION);
  });
});

describe('0034 public API idempotency', () => {
  it('keeps one row per workspace, user and key, and removes it with the user', async () => {
    expect(
      await codeOf(async (client) => {
        await seedNew(client, a);
        await seedNew(client, a);
      }),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await codeOf(async (client) => {
        await seedNew(client, a);
        await client.query('delete from users where id = $1', [a.owner]);
        const { rows } = await client.query('select 1 from public_api_idempotency where tenant_id = $1', [
          a.tenantId,
        ]);
        expect(rows).toHaveLength(0);
      }),
    ).toBeUndefined();
  });

  it('refuses an unknown status and stores an answer only as text', async () => {
    expect(
      await codeOf((client) =>
        client.query(
          `insert into public_api_idempotency (tenant_id, user_id, key, fingerprint, status)
           values ($1, $2, 'k', 'fp', 'failed')`,
          [a.tenantId, a.owner],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    const { rows } = await pool.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'public_api_idempotency' order by column_name`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]))).toEqual({
      created_at: 'timestamp with time zone',
      fingerprint: 'text',
      key: 'character varying',
      response_enc: 'text',
      status: 'text',
      status_code: 'integer',
      tenant_id: 'uuid',
      user_id: 'uuid',
    });
  });
});

describe('0032 to 0034 row-level security', () => {
  it('enables RLS with the tenant_isolation policy on the 6 tenant tables', async () => {
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
    const files = NEW_TAGS.map((tag) => statements(tag).join('\n'));
    for (const table of TENANT_TABLES) {
      expect(
        files.some((f) =>
          f.includes(`CREATE POLICY tenant_isolation ON "${table}" USING ${POLICY} WITH CHECK ${POLICY};`),
        ),
        table,
      ).toBe(true);
    }
  });

  it('shows a role other than the owner only the rows of the tenant it set', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const w of [a, b]) await seedNew(client, w);
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workflow_rls_probe') THEN
          CREATE ROLE workflow_rls_probe NOLOGIN;
        END IF;
      END $$`);
      await client.query(`GRANT SELECT ON ${TENANT_TABLES.join(', ')} TO workflow_rls_probe`);
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
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
