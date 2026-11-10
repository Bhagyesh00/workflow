/**
 * Phase 6 S2 contract step (C0b): migrations 0025 (SSO foundation), 0026 (account security), 0027 (role mapping
 * rules), 0028 (directory sync history), 0029 (SCIM), 0030 (private credentials) and 0031 (OAuth JWE keys). It
 * rebuilds its own database from 0000, inserts rows of the old shape, applies 0025 to 0031 and checks what
 * Postgres holds. Raw SQL only, no repository.
 *
 * It drops the `public` schema, so it only ever runs against `workflow_test_p6_s2_migrate` (the host of
 * TEST_DATABASE_URL, the database name replaced) and refuses any other database.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsFolder } from '../src/db/client';

const MIGRATE_DB = 'workflow_test_p6_s2_migrate';
const NEW_TAGS = [
  '0025_sso_foundation',
  '0026_account_security',
  '0027_role_mapping_rules',
  '0028_auth_sync_history',
  '0029_scim',
  '0030_private_credentials',
  '0031_oauth_jwe_keys',
];
/** the tenant tables of S2: RLS with the tenant_isolation policy */
const TENANT_TABLES = [
  'tenant_auth_settings',
  'auth_identities',
  'role_mapping_rules',
  'role_mapping_rule_projects',
  'auth_provider_sync_history',
  'scim_tokens',
  'credential_user_entries',
  'oauth_jwe_keys',
];
/** global like `users`: no tenant_id, no RLS */
const GLOBAL_TABLES = ['user_mfa', 'user_tokens'];
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
  member: string;
  projectId: string;
  credentialId: string;
  executionId: string;
  apiKeyId: string;
  sessionId: string;
}

let seq = 0;

/** a workspace as it looked after 0024: owner and member, a team project, a credential, a run, a key, a session */
async function seedOld(label: string): Promise<OldWorkspace> {
  const { tenantId } = await one<{ tenantId: string }>(
    'insert into tenants (name, slug) values ($1, $2) returning id as "tenantId"',
    [`Workspace ${label}`, `ws-${label.toLowerCase()}-${++seq}`],
  );
  const users: Record<string, string> = {};
  for (const role of ['owner', 'member']) {
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
  const { id: projectId } = await one<{ id: string }>(
    `insert into projects (tenant_id, name, type) values ($1, 'Team', 'team') returning id`,
    [tenantId],
  );
  const { id: credentialId } = await one<{ id: string }>(
    `insert into credentials (id, tenant_id, name, type, data_enc, project_id)
     values (gen_random_uuid(), $1, 'Key', 'oAuth2Api', 'x', $2) returning id`,
    [tenantId, projectId],
  );
  const { id: executionId } = await one<{ id: string }>(
    `insert into executions (id, tenant_id, mode, status) values (gen_random_uuid(), $1, 'manual', 'success')
     returning id`,
    [tenantId],
  );
  const { id: apiKeyId } = await one<{ id: string }>(
    `insert into api_keys (tenant_id, user_id, name, prefix, key_hash) values ($1, $2, 'Key', 'wf_', $3) returning id`,
    [tenantId, users.owner, `hash-${label}-${seq}`],
  );
  const sessionId = `session-${label}-${seq}`;
  await pool.query(
    `insert into sessions (id, user_id, tenant_id, expires_at) values ($1, $2, $3, now() + interval '1 day')`,
    [sessionId, users.owner, tenantId],
  );
  return {
    tenantId,
    owner: users.owner,
    member: users.member,
    projectId,
    credentialId,
    executionId,
    apiKeyId,
    sessionId,
  };
}

/** one row of each S2 tenant table in workspace `w` */
async function seedNew(client: pg.PoolClient, w: OldWorkspace): Promise<void> {
  await client.query('insert into tenant_auth_settings (tenant_id) values ($1)', [w.tenantId]);
  await client.query(
    `insert into auth_identities (tenant_id, provider_type, provider_id, user_id) values ($1, 'saml', $2, $3)`,
    [w.tenantId, `name-id-${w.member}`, w.member],
  );
  const { rows } = await client.query<{ id: string }>(
    `insert into role_mapping_rules (tenant_id, type, expression, role, "order")
     values ($1, 'project', 'true', 'project:editor', 0) returning id`,
    [w.tenantId],
  );
  await client.query(
    'insert into role_mapping_rule_projects (tenant_id, rule_id, project_id) values ($1, $2, $3)',
    [w.tenantId, rows[0].id, w.projectId],
  );
  await client.query(
    `insert into auth_provider_sync_history (tenant_id, provider_type, run_mode, status)
     values ($1, 'ldap', 'live', 'success')`,
    [w.tenantId],
  );
  await client.query(
    `insert into scim_tokens (tenant_id, token_hash, token_hint, created_by) values ($1, $2, 'abcd', $3)`,
    [w.tenantId, `scim-${w.tenantId}`, w.owner],
  );
  await client.query(
    `insert into credential_user_entries (tenant_id, credential_id, user_id, data_enc) values ($1, $2, $3, 'x')`,
    [w.tenantId, w.credentialId, w.member],
  );
  await client.query(
    `insert into oauth_jwe_keys (tenant_id, kid, private_enc, public_jwk) values ($1, 'k1', 'x', '{"kty":"RSA"}')`,
    [w.tenantId],
  );
}

let a: OldWorkspace;
let b: OldWorkspace;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: migrateUrl(), max: 4 });
  pool.on('error', () => {});
  const { current } = await one<{ current: string }>('select current_database() as current');
  if (current !== MIGRATE_DB) {
    throw new Error(`p6s2-migration only runs against ${MIGRATE_DB}, not ${current}`);
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
  expect(firstNew).toBe(25);
  await apply(tags.slice(0, firstNew));
  a = await seedOld('A');
  b = await seedOld('B');
  await apply(tags.slice(firstNew, firstNew + NEW_TAGS.length));
}, 120_000);

afterAll(async () => {
  await pool?.end();
});

describe('0025 to 0031 journal and snapshots', () => {
  it('journals 0025 to 0031 after 0024, each newer than every earlier migration', () => {
    const entries = journal();
    // bounded, so a later stage's 0032 keeps this green
    expect(entries.map((e) => `${e.idx}:${e.tag}`).slice(24, 32)).toEqual([
      '24:0024_roles_cutover',
      ...NEW_TAGS.map((tag, i) => `${25 + i}:${tag}`),
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
    for (let n = 25; n <= 31; n++) {
      expect(read(n).prevId, String(n)).toBe(read(n - 1).id);
    }
  });
});

describe('0025 to 0031 on rows of the old shape', () => {
  it('reads old sessions as password sessions without a second factor', async () => {
    for (const w of [a, b]) {
      const row = await one('select auth_method, mfa_verified from sessions where id = $1', [w.sessionId]);
      expect(row).toEqual({ auth_method: 'password', mfa_verified: false });
    }
  });

  it('keeps old credentials shared, not private, and old runs without private credentials', async () => {
    for (const w of [a, b]) {
      expect(await one('select is_resolvable from credentials where id = $1', [w.credentialId])).toEqual({
        is_resolvable: false,
      });
      expect(
        await one('select used_private_credentials from executions where id = $1', [w.executionId]),
      ).toEqual({ used_private_credentials: false });
    }
  });

  it('keeps old members active, password-only and unlinked, old keys without expiry, old users unmanaged', async () => {
    const { rows } = await pool.query(
      `select allow_sso_manual_login, last_active_at, disabled_at, external_id from memberships
       where tenant_id = any($1::uuid[])`,
      [[a.tenantId, b.tenantId]],
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toEqual({
        allow_sso_manual_login: false,
        last_active_at: null,
        disabled_at: null,
        external_id: null,
      });
    }
    for (const w of [a, b]) {
      expect(await one('select expires_at from api_keys where id = $1', [w.apiKeyId])).toEqual({
        expires_at: null,
      });
      const users = await pool.query('select managed_by_tenant_id from users where id = any($1::uuid[])', [
        [w.owner, w.member],
      ]);
      expect(users.rows).toEqual([{ managed_by_tenant_id: null }, { managed_by_tenant_id: null }]);
    }
  });

  it('gives a new workspace auth row the email method with just-in-time members on', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `insert into tenant_auth_settings (tenant_id) values ($1)
         returning method, jit, saml, saml_metadata, oidc, oidc_secret_enc, ldap, ldap_password_enc, provisioning`,
        [a.tenantId],
      );
      expect(rows[0]).toEqual({
        method: 'email',
        jit: true,
        saml: null,
        saml_metadata: null,
        oidc: null,
        oidc_secret_enc: null,
        ldap: null,
        ldap_password_enc: null,
        provisioning: null,
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('0025 to 0031 keys and constraints', () => {
  it('refuses an unknown sign-in method, provider type, token kind and rule type', async () => {
    expect(
      await codeOf((c) =>
        c.query(`insert into tenant_auth_settings (tenant_id, method) values ($1, 'kerberos')`, [a.tenantId]),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await codeOf((c) =>
        c.query(
          `insert into auth_identities (tenant_id, provider_type, provider_id, user_id) values ($1, 'github', 'x', $2)`,
          [a.tenantId, a.member],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await codeOf((c) =>
        c.query(
          `insert into user_tokens (user_id, kind, token_hash, expires_at) values ($1, 'magic_link', 'h', now())`,
          [a.member],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await codeOf((c) =>
        c.query(
          `insert into role_mapping_rules (tenant_id, type, expression, role, "order") values ($1, 'folder', 'true', 'x', 0)`,
          [a.tenantId],
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('refuses a cross-tenant private credential entry and accepts one inside the workspace', async () => {
    // A's credential with B's member, under either tenant id
    for (const [tenantId, credentialId, userId] of [
      [a.tenantId, a.credentialId, b.member],
      [b.tenantId, a.credentialId, b.member],
    ]) {
      expect(
        await codeOf((c) =>
          c.query(
            `insert into credential_user_entries (tenant_id, credential_id, user_id, data_enc) values ($1, $2, $3, 'x')`,
            [tenantId, credentialId, userId],
          ),
        ),
      ).toBe(FK_VIOLATION);
    }
    expect(
      await codeOf((c) =>
        c.query(
          `insert into credential_user_entries (tenant_id, credential_id, user_id, data_enc) values ($1, $2, $3, 'x')`,
          [a.tenantId, a.credentialId, a.member],
        ),
      ),
    ).toBeUndefined();
  });

  it('refuses a cross-tenant role mapping rule project and accepts one inside the workspace', async () => {
    const insertRule = async (c: pg.PoolClient, tenantId: string) =>
      (
        await c.query<{ id: string }>(
          `insert into role_mapping_rules (tenant_id, type, expression, role, "order")
           values ($1, 'project', 'true', 'project:viewer', 0) returning id`,
          [tenantId],
        )
      ).rows[0].id;
    // A's rule with B's project, under either tenant id
    expect(
      await codeOf(async (c) => {
        const rule = await insertRule(c, a.tenantId);
        await c.query(
          'insert into role_mapping_rule_projects (tenant_id, rule_id, project_id) values ($1, $2, $3)',
          [a.tenantId, rule, b.projectId],
        );
      }),
    ).toBe(FK_VIOLATION);
    expect(
      await codeOf(async (c) => {
        const rule = await insertRule(c, a.tenantId);
        await c.query(
          'insert into role_mapping_rule_projects (tenant_id, rule_id, project_id) values ($1, $2, $3)',
          [b.tenantId, rule, b.projectId],
        );
      }),
    ).toBe(FK_VIOLATION);
    expect(
      await codeOf(async (c) => {
        const rule = await insertRule(c, a.tenantId);
        await c.query(
          'insert into role_mapping_rule_projects (tenant_id, rule_id, project_id) values ($1, $2, $3)',
          [a.tenantId, rule, a.projectId],
        );
      }),
    ).toBeUndefined();
  });

  it('refuses an SSO identity for a user who is not a member of that workspace', async () => {
    expect(
      await codeOf((c) =>
        c.query(
          `insert into auth_identities (tenant_id, provider_type, provider_id, user_id) values ($1, 'oidc', 'sub', $2)`,
          [a.tenantId, b.member],
        ),
      ),
    ).toBe(FK_VIOLATION);
    // the same provider id may belong to different people in different workspaces, once per workspace
    expect(
      await codeOf(async (c) => {
        for (const w of [a, b]) {
          await c.query(
            `insert into auth_identities (tenant_id, provider_type, provider_id, user_id) values ($1, 'oidc', 'sub', $2)`,
            [w.tenantId, w.member],
          );
        }
      }),
    ).toBeUndefined();
    expect(
      await codeOf(async (c) => {
        for (const user of [a.member, a.owner]) {
          await c.query(
            `insert into auth_identities (tenant_id, provider_type, provider_id, user_id) values ($1, 'oidc', 'sub', $2)`,
            [a.tenantId, user],
          );
        }
      }),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('lets many members have no external id, and keeps a set external id unique per workspace', async () => {
    // both members of A have a null external_id already; a second null is fine
    expect(
      await codeOf((c) =>
        c.query('update memberships set external_id = null where tenant_id = $1', [a.tenantId]),
      ),
    ).toBeUndefined();
    expect(
      await codeOf((c) =>
        c.query(`update memberships set external_id = 'ext-1' where tenant_id = $1`, [a.tenantId]),
      ),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await codeOf(async (c) => {
        for (const w of [a, b]) {
          await c.query(
            `update memberships set external_id = 'ext-1' where tenant_id = $1 and user_id = $2`,
            [w.tenantId, w.member],
          );
        }
      }),
    ).toBeUndefined();
  });

  it('keeps rule order unique per workspace and type, and token hashes unique', async () => {
    expect(
      await codeOf(async (c) => {
        for (const type of ['instance', 'project']) {
          await c.query(
            `insert into role_mapping_rules (tenant_id, type, expression, role, "order") values ($1, $2, 'true', 'x', 0)`,
            [a.tenantId, type],
          );
        }
        await c.query(
          `insert into role_mapping_rules (tenant_id, type, expression, role, "order") values ($1, 'instance', 'true', 'x', 0)`,
          [b.tenantId],
        );
      }),
    ).toBeUndefined();
    expect(
      await codeOf(async (c) => {
        for (let i = 0; i < 2; i++) {
          await c.query(
            `insert into role_mapping_rules (tenant_id, type, expression, role, "order") values ($1, 'instance', 'true', 'x', 3)`,
            [a.tenantId],
          );
        }
      }),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await codeOf(async (c) => {
        for (const user of [a.member, b.member]) {
          await c.query(
            `insert into user_tokens (user_id, kind, token_hash, expires_at) values ($1, 'password_reset', 'same', now())`,
            [user],
          );
        }
      }),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await codeOf(async (c) => {
        await c.query(
          `insert into scim_tokens (tenant_id, token_hash, token_hint) values ($1, 'same', 'x')`,
          [a.tenantId],
        );
        await c.query(
          `insert into scim_tokens (tenant_id, token_hash, token_hint) values ($1, 'same', 'x')`,
          [b.tenantId],
        );
      }),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('removes MFA and tokens with their user, and private entries and identities with the membership', async () => {
    expect(
      await codeOf(async (c) => {
        await seedNew(c, a);
        await c.query(`insert into user_mfa (user_id, secret_enc) values ($1, 'x')`, [a.member]);
        await c.query(
          `insert into user_tokens (user_id, kind, token_hash, expires_at) values ($1, 'email_change', 't', now())`,
          [a.member],
        );
        const mfa = await c.query(
          'select recovery_hashes, enabled_at, last_step from user_mfa where user_id = $1',
          [a.member],
        );
        expect(mfa.rows).toEqual([{ recovery_hashes: [], enabled_at: null, last_step: null }]);
        await c.query('delete from memberships where tenant_id = $1 and user_id = $2', [
          a.tenantId,
          a.member,
        ]);
        for (const table of ['credential_user_entries', 'auth_identities']) {
          const left = await c.query(`select 1 from ${table} where user_id = $1`, [a.member]);
          expect(left.rows, table).toHaveLength(0);
        }
        await c.query('delete from users where id = $1', [a.member]);
        for (const table of GLOBAL_TABLES) {
          const left = await c.query(`select 1 from ${table} where user_id = $1`, [a.member]);
          expect(left.rows, table).toHaveLength(0);
        }
      }),
    ).toBeUndefined();
  });

  it('deletes a whole workspace in one statement and unmanages the users its SCIM client made', async () => {
    expect(
      await codeOf(async (c) => {
        await seedNew(c, a);
        await c.query('update users set managed_by_tenant_id = $1 where id = $2', [a.tenantId, b.member]);
        await c.query('delete from tenants where id = $1', [a.tenantId]);
        for (const table of TENANT_TABLES) {
          const left = await c.query(`select 1 from ${table} where tenant_id = $1`, [a.tenantId]);
          expect(left.rows, table).toHaveLength(0);
        }
        const user = await c.query('select managed_by_tenant_id from users where id = $1', [b.member]);
        expect(user.rows).toEqual([{ managed_by_tenant_id: null }]);
      }),
    ).toBeUndefined();
  });
});

describe('0025 to 0031 row-level security', () => {
  it('enables RLS with the tenant_isolation policy on the 8 tenant tables', async () => {
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

  it('keeps user_mfa and user_tokens global: no tenant_id, no RLS, no policy', async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      'select relname, relrowsecurity from pg_class where relname = any($1::text[]) order by relname',
      [GLOBAL_TABLES],
    );
    expect(rows).toEqual([
      { relname: 'user_mfa', relrowsecurity: false },
      { relname: 'user_tokens', relrowsecurity: false },
    ]);
    const policies = await pool.query('select 1 from pg_policies where tablename = any($1::text[])', [
      GLOBAL_TABLES,
    ]);
    expect(policies.rows).toHaveLength(0);
    const columns = await pool.query(
      `select table_name from information_schema.columns
       where table_schema = 'public' and table_name = any($1::text[]) and column_name = 'tenant_id'`,
      [GLOBAL_TABLES],
    );
    expect(columns.rows).toHaveLength(0);
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
