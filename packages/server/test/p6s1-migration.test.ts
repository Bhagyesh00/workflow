/**
 * Phase 6 S1 contract step (C0b): migrations 0021 (projects, project relations, custom roles), 0022 (project
 * ownership of workflows, credentials, folders, data tables and variables), 0023 (shares and vault access) and
 * 0024 (role cutover). It rebuilds its own database from 0000, inserts rows of the old shape, applies 0021 to
 * 0024 and checks what Postgres holds. Raw SQL only, no repository.
 *
 * It drops the `public` schema, so it only ever runs against `workflow_test_p6_s1_migrate` (the host of
 * TEST_DATABASE_URL, the database name replaced) and refuses any other database.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client';

const MIGRATE_DB = 'workflow_test_p6_s1_migrate';
const NEW_TABLES = [
  'projects',
  'project_relations',
  'roles',
  'workflow_shares',
  'credential_shares',
  'project_secret_access',
];
const OWNED_TABLES = ['workflows', 'credentials', 'folders', 'data_tables'];
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

/** runs `work` in a transaction that is always rolled back; returns the Postgres error code, if any */
async function codeOf(work: (client: pg.PoolClient) => Promise<unknown>): Promise<string | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await work(client);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
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
  name: string;
  owner: string;
  editor: string;
  viewer: string;
  workflowId: string;
  credentialId: string;
  folderId: string;
  dataTableId: string;
  variableId: string;
  connectionId: string;
}

let seq = 0;

/** a workspace as it looked before 0021: owner, editor, viewer and one row of each owned resource */
async function seedOld(label: string): Promise<OldWorkspace> {
  const name = `Workspace ${label}`;
  const { tenantId } = await one<{ tenantId: string }>(
    'insert into tenants (name, slug) values ($1, $2) returning id as "tenantId"',
    [name, `ws-${label.toLowerCase()}-${++seq}`],
  );
  const users: Record<string, string> = {};
  for (const role of ['owner', 'editor', 'viewer']) {
    const { id } = await one<{ id: string }>(
      `insert into users (email, name, password_hash) values ($1, $2, 'x') returning id`,
      [`${role}-${label.toLowerCase()}-${seq}@example.com`, `${role} ${label}`],
    );
    await pool.query('insert into memberships (tenant_id, user_id, role) values ($1, $2, $3)', [
      tenantId,
      id,
      role,
    ]);
    users[role] = id;
  }
  const { id: folderId } = await one<{ id: string }>(
    `insert into folders (tenant_id, name) values ($1, 'Folder') returning id`,
    [tenantId],
  );
  const { id: workflowId } = await one<{ id: string }>(
    `insert into workflows (tenant_id, name, version_id, folder_id) values ($1, 'Flow', gen_random_uuid(), $2) returning id`,
    [tenantId, folderId],
  );
  const { id: credentialId } = await one<{ id: string }>(
    `insert into credentials (id, tenant_id, name, type, data_enc)
     values (gen_random_uuid(), $1, 'Key', 'httpHeaderAuth', 'x') returning id`,
    [tenantId],
  );
  const { id: dataTableId } = await one<{ id: string }>(
    `insert into data_tables (tenant_id, name) values ($1, 'Orders') returning id`,
    [tenantId],
  );
  const { id: variableId } = await one<{ id: string }>(
    `insert into variables (tenant_id, key, value) values ($1, 'REGION', 'eu') returning id`,
    [tenantId],
  );
  const { id: connectionId } = await one<{ id: string }>(
    `insert into secret_connections (id, tenant_id, provider_key, type, settings_enc)
     values (gen_random_uuid(), $1, 'vault', 'vault', 'x') returning id`,
    [tenantId],
  );
  return {
    tenantId,
    name,
    owner: users.owner,
    editor: users.editor,
    viewer: users.viewer,
    workflowId,
    credentialId,
    folderId,
    dataTableId,
    variableId,
    connectionId,
  };
}

const teamProject = async (tenantId: string): Promise<string> =>
  (await one<{ id: string }>(`select id from projects where tenant_id = $1 and type = 'team'`, [tenantId]))
    .id;

const personalProject = async (tenantId: string, userId: string): Promise<string> =>
  (
    await one<{ id: string }>(
      `select id from projects where tenant_id = $1 and type = 'personal' and owner_user_id = $2`,
      [tenantId, userId],
    )
  ).id;

let a: OldWorkspace;
let b: OldWorkspace;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: migrateUrl(), max: 4 });
  pool.on('error', () => {});
  const { current } = await one<{ current: string }>('select current_database() as current');
  if (current !== MIGRATE_DB) {
    throw new Error(`p6s1-migration only runs against ${MIGRATE_DB}, not ${current}`);
  }
  const hadVector = (await pool.query(`select 1 from pg_extension where extname = 'vector'`)).rows.length > 0;
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  // as a fresh database's public schema: every role may use it (the RLS probe role below needs this)
  await pool.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
  if (hadVector) await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

  const tags = journal().map((e) => e.tag);
  const firstNew = tags.indexOf('0021_projects');
  expect(firstNew).toBe(21);
  await apply(tags.slice(0, firstNew));
  a = await seedOld('A');
  b = await seedOld('B');
  await apply(tags.slice(firstNew, firstNew + 4));
}, 120_000);

afterAll(async () => {
  await pool?.end();
});

describe('0021 to 0024 journal and snapshots', () => {
  it('journals 0021 to 0024 after 0020, each newer than every earlier migration', () => {
    const entries = journal();
    // bounded, so a later stage's 0025 keeps this green
    expect(entries.map((e) => `${e.idx}:${e.tag}`).slice(20, 25)).toEqual([
      '20:0020_assistant_mcp_connections',
      '21:0021_projects',
      '22:0022_project_ownership',
      '23:0023_shares',
      '24:0024_roles_cutover',
    ]);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].when).toBeGreaterThan(entries[i - 1].when);
    }
  });

  it('0024 is hand written: its snapshot equals 0023 and chains to it', () => {
    const read = (n: string) =>
      JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', `${n}_snapshot.json`), 'utf8')) as {
        id: string;
        prevId: string;
      } & Record<string, unknown>;
    const s23 = read('0023');
    const s24 = read('0024');
    expect(s24.prevId).toBe(s23.id);
    expect(s24.id).not.toBe(s23.id);
    const { id: _a, prevId: _b, ...rest23 } = s23;
    const { id: _c, prevId: _d, ...rest24 } = s24;
    expect(rest24).toEqual(rest23);
    for (const [n, prev] of [
      ['0021', '0020'],
      ['0022', '0021'],
      ['0023', '0022'],
    ]) {
      expect(read(n).prevId).toBe(read(prev).id);
    }
  });
});

describe('0021 to 0024 on rows of the old shape', () => {
  it('gives each workspace one team project named after it', async () => {
    for (const w of [a, b]) {
      const rows = (
        await pool.query(
          `select name, type, owner_user_id, icon, description, custom_telemetry_tags from projects
           where tenant_id = $1 and type = 'team'`,
          [w.tenantId],
        )
      ).rows;
      expect(rows).toEqual([
        {
          name: w.name,
          type: 'team',
          owner_user_id: null,
          icon: null,
          description: null,
          custom_telemetry_tags: [],
        },
      ]);
    }
  });

  it('moves every workflow, credential, folder and data table into the team project', async () => {
    for (const w of [a, b]) {
      const team = await teamProject(w.tenantId);
      for (const [table, id] of [
        ['workflows', w.workflowId],
        ['credentials', w.credentialId],
        ['folders', w.folderId],
        ['data_tables', w.dataTableId],
      ]) {
        const row = await one<{ project_id: string }>(`select project_id from ${table} where id = $1`, [id]);
        expect(row.project_id, table).toBe(team);
      }
      const credential = await one<{ is_global: boolean }>(
        'select is_global from credentials where id = $1',
        [w.credentialId],
      );
      expect(credential.is_global).toBe(false);
      const variable = await one<{ project_id: string | null }>(
        'select project_id from variables where id = $1',
        [w.variableId],
      );
      expect(variable.project_id).toBeNull();
      const connection = await one<{ project_id: string | null }>(
        'select project_id from secret_connections where id = $1',
        [w.connectionId],
      );
      expect(connection.project_id).toBeNull();
    }
  });

  it('gives each member one personal project named after the user', async () => {
    for (const w of [a, b]) {
      const rows = (
        await pool.query<{ owner_user_id: string; name: string; creator_id: string }>(
          `select owner_user_id, name, creator_id from projects
           where tenant_id = $1 and type = 'personal' order by name`,
          [w.tenantId],
        )
      ).rows;
      const label = w === a ? 'A' : 'B';
      expect(rows).toEqual([
        { owner_user_id: w.editor, name: `editor ${label}`, creator_id: w.editor },
        { owner_user_id: w.owner, name: `owner ${label}`, creator_id: w.owner },
        { owner_user_id: w.viewer, name: `viewer ${label}`, creator_id: w.viewer },
      ]);
    }
  });

  it('turns editor and viewer into member with the same role in the team project, owners of personal projects get project:personalOwner', async () => {
    for (const w of [a, b]) {
      const team = await teamProject(w.tenantId);
      const members = (
        await pool.query<{ user_id: string; role: string }>(
          'select user_id, role from memberships where tenant_id = $1',
          [w.tenantId],
        )
      ).rows;
      expect(Object.fromEntries(members.map((m) => [m.user_id, m.role]))).toEqual({
        [w.owner]: 'owner',
        [w.editor]: 'member',
        [w.viewer]: 'member',
      });
      const relations = (
        await pool.query<{ project_id: string; user_id: string; role: string }>(
          'select project_id, user_id, role from project_relations where tenant_id = $1',
          [w.tenantId],
        )
      ).rows;
      const byKey = (r: { user_id: string; role: string }) => `${r.role} ${r.user_id}`;
      const sorted = <T extends { user_id: string; role: string }>(rows: T[]): T[] =>
        [...rows].sort((x, y) => byKey(x).localeCompare(byKey(y)));
      // 0022 gives every personal project its owner's relation; 0024 adds the old roles on the team project
      const owned = async (userId: string) => ({
        project_id: await personalProject(w.tenantId, userId),
        user_id: userId,
        role: 'project:personalOwner',
      });
      expect(sorted(relations)).toEqual(
        sorted([
          { project_id: team, user_id: w.editor, role: 'project:editor' },
          { project_id: team, user_id: w.viewer, role: 'project:viewer' },
          await owned(w.owner),
          await owned(w.editor),
          await owned(w.viewer),
        ]),
      );
    }
  });

  it('makes project_id NOT NULL on the owned tables and nullable on variables and secret_connections', async () => {
    const { rows } = await pool.query<{ table_name: string; is_nullable: string }>(
      `select table_name, is_nullable from information_schema.columns
       where table_schema = 'public' and column_name = 'project_id'
         and table_name = any($1::text[])`,
      [[...OWNED_TABLES, 'variables', 'secret_connections']],
    );
    expect(Object.fromEntries(rows.map((r) => [r.table_name, r.is_nullable]))).toEqual({
      workflows: 'NO',
      credentials: 'NO',
      folders: 'NO',
      data_tables: 'NO',
      variables: 'YES',
      secret_connections: 'YES',
    });
    expect(
      await codeOf((c) =>
        c.query(`insert into workflows (tenant_id, name, version_id) values ($1, 'x', gen_random_uuid())`, [
          a.tenantId,
        ]),
      ),
    ).toBe(NOT_NULL_VIOLATION);
  });

  it('keeps the share, vault and relation defaults', async () => {
    const { rows } = await pool.query<{ table_name: string; column_default: string }>(
      `select table_name, column_default from information_schema.columns
       where table_schema = 'public' and column_name = 'role'
         and table_name in ('workflow_shares', 'credential_shares', 'project_secret_access')`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.table_name, r.column_default]))).toEqual({
      workflow_shares: "'workflow:editor'::text",
      credential_shares: "'credential:user'::text",
      project_secret_access: "'secretsProviderConnection:user'::text",
    });
  });
});

describe('0021 to 0023 keys and constraints', () => {
  it('refuses a second personal project for the same member, and an unknown project type', async () => {
    expect(
      await codeOf((c) =>
        c.query(
          `insert into projects (tenant_id, name, type, owner_user_id) values ($1, 'Again', 'personal', $2)`,
          [a.tenantId, a.editor],
        ),
      ),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await codeOf((c) =>
        c.query(`insert into projects (tenant_id, name, type) values ($1, 'X', 'shared')`, [a.tenantId]),
      ),
    ).toBe(CHECK_VIOLATION);
    // a second team project is fine
    expect(
      await codeOf((c) =>
        c.query(`insert into projects (tenant_id, name, type) values ($1, 'Ops', 'team')`, [a.tenantId]),
      ),
    ).toBeUndefined();
  });

  it('refuses a personal project whose owner is not a member of that workspace', async () => {
    expect(
      await codeOf((c) =>
        c.query(
          `insert into projects (tenant_id, name, type, owner_user_id) values ($1, 'Other', 'personal', $2)`,
          [a.tenantId, b.editor],
        ),
      ),
    ).toBe(FK_VIOLATION);
  });

  it('refuses every row that points into another workspace', async () => {
    const teamA = await teamProject(a.tenantId);
    const teamB = await teamProject(b.tenantId);
    const cases: [string, string, unknown[]][] = [
      // B's tenant on A's connection, and A's connection with B's project
      [
        'project_secret_access, project of another workspace',
        'insert into project_secret_access (tenant_id, connection_id, project_id) values ($1, $2, $3)',
        [a.tenantId, a.connectionId, teamB],
      ],
      [
        'project_secret_access, connection of another workspace',
        'insert into project_secret_access (tenant_id, connection_id, project_id) values ($1, $2, $3)',
        [b.tenantId, a.connectionId, teamB],
      ],
      [
        'workflow_shares',
        'insert into workflow_shares (tenant_id, workflow_id, project_id) values ($1, $2, $3)',
        [a.tenantId, a.workflowId, teamB],
      ],
      [
        'credential_shares',
        'insert into credential_shares (tenant_id, credential_id, project_id) values ($1, $2, $3)',
        [b.tenantId, a.credentialId, teamB],
      ],
      [
        'project_relations, user of another workspace',
        `insert into project_relations (tenant_id, project_id, user_id, role) values ($1, $2, $3, 'project:editor')`,
        [a.tenantId, teamA, b.editor],
      ],
      [
        'project_relations, project of another workspace',
        `insert into project_relations (tenant_id, project_id, user_id, role) values ($1, $2, $3, 'project:editor')`,
        [a.tenantId, teamB, a.owner],
      ],
      [
        'workflows',
        `insert into workflows (tenant_id, name, version_id, project_id) values ($1, 'x', gen_random_uuid(), $2)`,
        [a.tenantId, teamB],
      ],
      [
        'variables',
        `insert into variables (tenant_id, key, value, project_id) values ($1, 'K', 'v', $2)`,
        [a.tenantId, teamB],
      ],
      [
        'secret_connections',
        `update secret_connections set project_id = $2 where id = $1`,
        [a.connectionId, teamB],
      ],
    ];
    for (const [label, sql, params] of cases) {
      expect(await codeOf((c) => c.query(sql, params)), label).toBe(FK_VIOLATION);
    }
    // the same rows inside one workspace are accepted
    const personalA = await personalProject(a.tenantId, a.editor);
    expect(
      await codeOf(async (c) => {
        await c.query(
          'insert into project_secret_access (tenant_id, connection_id, project_id) values ($1, $2, $3)',
          [a.tenantId, a.connectionId, personalA],
        );
        await c.query(
          'insert into workflow_shares (tenant_id, workflow_id, project_id) values ($1, $2, $3)',
          [a.tenantId, a.workflowId, personalA],
        );
        await c.query(
          'insert into credential_shares (tenant_id, credential_id, project_id) values ($1, $2, $3)',
          [a.tenantId, a.credentialId, personalA],
        );
      }),
    ).toBeUndefined();
  });

  it('keeps data table names unique per project, not per workspace', async () => {
    const team = await teamProject(a.tenantId);
    const personal = await personalProject(a.tenantId, a.editor);
    expect(
      await codeOf((c) =>
        c.query(`insert into data_tables (tenant_id, project_id, name) values ($1, $2, 'Orders')`, [
          a.tenantId,
          team,
        ]),
      ),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await codeOf((c) =>
        c.query(`insert into data_tables (tenant_id, project_id, name) values ($1, $2, 'Orders')`, [
          a.tenantId,
          personal,
        ]),
      ),
    ).toBeUndefined();
  });

  it('keeps variable keys unique per workspace and per project; a project key may repeat a workspace key', async () => {
    const team = await teamProject(a.tenantId);
    expect(
      await codeOf((c) =>
        c.query(`insert into variables (tenant_id, key, value) values ($1, 'REGION', 'us')`, [a.tenantId]),
      ),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await codeOf(async (c) => {
        await c.query(
          `insert into variables (tenant_id, key, value, project_id) values ($1, 'REGION', 'us', $2)`,
          [a.tenantId, team],
        );
        await c.query(
          `insert into variables (tenant_id, key, value, project_id) values ($1, 'REGION', 'ap', $2)`,
          [a.tenantId, team],
        );
      }),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await codeOf((c) =>
        c.query(`insert into variables (tenant_id, key, value, project_id) values ($1, 'REGION', 'us', $2)`, [
          a.tenantId,
          team,
        ]),
      ),
    ).toBeUndefined();
  });

  it('accepts a project favorite and refuses an unknown resource type', async () => {
    const team = await teamProject(a.tenantId);
    expect(
      await codeOf((c) =>
        c.query(
          `insert into user_favorites (tenant_id, user_id, resource_type, resource_id) values ($1, $2, 'project', $3)`,
          [a.tenantId, a.owner, team],
        ),
      ),
    ).toBeUndefined();
    expect(
      await codeOf((c) =>
        c.query(
          `insert into user_favorites (tenant_id, user_id, resource_type, resource_id) values ($1, $2, 'vault', $3)`,
          [a.tenantId, a.owner, team],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('keeps custom role slugs and names unique per workspace and the role type closed', async () => {
    const insert = (c: pg.PoolClient, tenantId: string, slug: string, name: string, type = 'project') =>
      c.query(
        `insert into roles (tenant_id, slug, display_name, role_type, scopes) values ($1, $2, $3, $4, '{workflow:read}')`,
        [tenantId, slug, name, type],
      );
    expect(
      await codeOf(async (c) => {
        await insert(c, a.tenantId, 'project:reviewer', 'Reviewer');
        await insert(c, b.tenantId, 'project:reviewer', 'Reviewer');
      }),
    ).toBeUndefined();
    expect(
      await codeOf(async (c) => {
        await insert(c, a.tenantId, 'project:reviewer', 'Reviewer');
        await insert(c, a.tenantId, 'project:reviewer', 'Other');
      }),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await codeOf(async (c) => {
        await insert(c, a.tenantId, 'project:reviewer', 'Reviewer');
        await insert(c, a.tenantId, 'project:checker', 'Reviewer');
      }),
    ).toBe(UNIQUE_VIOLATION);
    expect(await codeOf((c) => insert(c, a.tenantId, 'x', 'X', 'resource'))).toBe(CHECK_VIOLATION);
  });

  it('refuses to delete a project that still owns work; shares and relations go with their project', async () => {
    const team = await teamProject(a.tenantId);
    expect(await codeOf((c) => c.query('delete from projects where id = $1', [team]))).toBe(FK_VIOLATION);
    const personal = await personalProject(a.tenantId, a.editor);
    expect(
      await codeOf(async (c) => {
        await c.query(
          'insert into workflow_shares (tenant_id, workflow_id, project_id) values ($1, $2, $3)',
          [a.tenantId, a.workflowId, personal],
        );
        await c.query('delete from projects where id = $1', [personal]);
        const left = await c.query('select 1 from workflow_shares where project_id = $1', [personal]);
        if (left.rows.length > 0) throw Object.assign(new Error('share kept'), { code: 'kept' });
      }),
    ).toBeUndefined();
  });

  it('deletes a whole workspace in one statement', async () => {
    expect(
      await codeOf(async (c) => {
        const personal = await personalProject(a.tenantId, a.editor);
        await c.query(
          'insert into workflow_shares (tenant_id, workflow_id, project_id) values ($1, $2, $3)',
          [a.tenantId, a.workflowId, personal],
        );
        await c.query(
          'insert into project_secret_access (tenant_id, connection_id, project_id) values ($1, $2, $3)',
          [a.tenantId, a.connectionId, personal],
        );
        await c.query('delete from tenants where id = $1', [a.tenantId]);
        for (const table of [...NEW_TABLES, ...OWNED_TABLES]) {
          const left = await c.query(`select 1 from ${table} where tenant_id = $1`, [a.tenantId]);
          if (left.rows.length > 0) throw Object.assign(new Error(table), { code: `kept ${table}` });
        }
      }),
    ).toBeUndefined();
  });
});

describe('0021 and 0023 row-level security', () => {
  it('enables RLS with the tenant_isolation policy on every new table', async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      'select relname, relrowsecurity from pg_class where relname = any($1::text[]) order by relname',
      [NEW_TABLES],
    );
    expect(rows).toHaveLength(NEW_TABLES.length);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    const policies = await pool.query<{
      tablename: string;
      policyname: string;
      qual: string;
      with_check: string;
    }>('select tablename, policyname, qual, with_check from pg_policies where tablename = any($1::text[])', [
      NEW_TABLES,
    ]);
    expect(policies.rows).toHaveLength(NEW_TABLES.length);
    // the same expression as 0013's secret_connections policy, as Postgres stores it
    const reference = await one<{ qual: string; with_check: string }>(
      `select qual, with_check from pg_policies where tablename = 'secret_connections' and policyname = 'tenant_isolation'`,
    );
    for (const policy of policies.rows) {
      expect(policy.policyname).toBe('tenant_isolation');
      expect(policy.qual).toBe(reference.qual);
      expect(policy.with_check).toBe(reference.with_check);
    }
    const files = ['0021_projects', '0023_shares'].map((tag) => statements(tag).join('\n'));
    for (const table of NEW_TABLES) {
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
      // one row of each new table in both workspaces
      for (const w of [a, b]) {
        const personal = await personalProject(w.tenantId, w.editor);
        await client.query(
          `insert into roles (tenant_id, slug, display_name, role_type) values ($1, 'project:custom', 'Custom', 'project')`,
          [w.tenantId],
        );
        await client.query(
          'insert into workflow_shares (tenant_id, workflow_id, project_id) values ($1, $2, $3)',
          [w.tenantId, w.workflowId, personal],
        );
        await client.query(
          'insert into credential_shares (tenant_id, credential_id, project_id) values ($1, $2, $3)',
          [w.tenantId, w.credentialId, personal],
        );
        await client.query(
          'insert into project_secret_access (tenant_id, connection_id, project_id) values ($1, $2, $3)',
          [w.tenantId, w.connectionId, personal],
        );
      }
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workflow_rls_probe') THEN
          CREATE ROLE workflow_rls_probe NOLOGIN;
        END IF;
      END $$`);
      await client.query(`GRANT SELECT ON ${NEW_TABLES.join(', ')} TO workflow_rls_probe`);
      await client.query('SET LOCAL ROLE workflow_rls_probe');
      for (const table of NEW_TABLES) {
        const none = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(none.rows[0].n, table).toBe(0);
      }
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
      for (const table of NEW_TABLES) {
        const { rows } = await client.query(`SELECT DISTINCT tenant_id FROM ${table}`);
        expect(rows, table).toEqual([{ tenant_id: a.tenantId }]);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
