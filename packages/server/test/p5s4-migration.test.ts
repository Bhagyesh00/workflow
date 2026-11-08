/**
 * Phase 5 S4 contract step (C0b): migrations 0015 (API key audience), 0016 (MCP OAuth) and 0017 (AI
 * builder sessions). Checks what Postgres really holds: columns, defaults, indexes, row-level security,
 * cascades; then the real C0 code lanes build on: the API key audience filter, the builder session
 * repository, the repository registration and the MCP and AI config (never a stub's body).
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { migrationsFolder } from '../src/db/client';
import { type BuilderSessionPatch, BuilderSessionRepository } from '../src/repositories/builder-sessions';
import { McpOAuthRepository } from '../src/repositories/mcp-oauth';
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
const repos = () => server.ctx.repos;

const OAUTH_TABLES = [
  'oauth_clients',
  'oauth_authorization_codes',
  'oauth_access_tokens',
  'oauth_refresh_tokens',
  'oauth_user_consents',
];
const S4_TABLES = [...OAUTH_TABLES, 'workflow_builder_sessions'];
const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const RLS_VIOLATION = '42501';
const POLICY = "(tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)";

/** rejects with the Postgres error code of the failing statement */
async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** a workspace with one user and one workflow */
async function workspace() {
  const user = await signup(server.app);
  const workflow = await createWorkflow(user.client, { nodes: [] });
  return { tenantId: user.tenant.id, userId: user.user.id, workflowId: workflow.id };
}

async function insertClient(tenantId: string, id = `client-${randomUUID()}`): Promise<string> {
  await pool().query(
    `insert into oauth_clients (id, tenant_id, name, redirect_uris, grant_types, token_endpoint_auth_method)
     values ($1, $2, 'Client', '["http://127.0.0.1/cb"]', '["authorization_code","refresh_token"]', 'none')`,
    [id, tenantId],
  );
  return id;
}

/** one row in each of the six S4 tables for this workspace */
async function seedAll(w: { tenantId: string; userId: string; workflowId: string }) {
  const clientId = await insertClient(w.tenantId);
  const expires = new Date(Date.now() + 600_000);
  await pool().query(
    `insert into oauth_authorization_codes
       (code_hash, tenant_id, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, resource, expires_at)
     values ($1, $2, $3, $4, 'http://127.0.0.1/cb', 'challenge', 'S256', 'http://localhost/mcp-server/x/http', $5)`,
    [hash(randomUUID()), w.tenantId, clientId, w.userId, expires],
  );
  for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens']) {
    await pool().query(
      `insert into ${table} (token_hash, tenant_id, client_id, user_id, resource, expires_at)
       values ($1, $2, $3, $4, 'http://localhost/mcp-server/x/http', $5)`,
      [hash(randomUUID()), w.tenantId, clientId, w.userId, expires],
    );
  }
  await pool().query(
    `insert into oauth_user_consents (tenant_id, user_id, client_id, scope) values ($1, $2, $3, '{tool:listWorkflows}')`,
    [w.tenantId, w.userId, clientId],
  );
  await pool().query(
    'insert into workflow_builder_sessions (tenant_id, workflow_id, user_id) values ($1, $2, $3)',
    [w.tenantId, w.workflowId, w.userId],
  );
  return clientId;
}

describe('0015 to 0017 journal and files', () => {
  it('journals 0015, 0016, 0017 after 0014, each newer than every earlier migration', () => {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    // bounded, so a later stage's 0018 keeps this green
    expect(journal.entries.map((e) => `${e.idx}:${e.tag}`).slice(14, 18)).toEqual([
      '14:0014_test_runs',
      '15:0015_api_key_audience',
      '16:0016_mcp_oauth',
      '17:0017_workflow_builder_sessions',
    ]);
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
    }
  });

  it('writes every tenant_isolation policy into the migration files', () => {
    const files: [string, string[]][] = [
      ['0016_mcp_oauth.sql', OAUTH_TABLES],
      ['0017_workflow_builder_sessions.sql', ['workflow_builder_sessions']],
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

describe('0015_api_key_audience', () => {
  it('adds audience, not null, default public-api, and the (tenant, user, audience) index', async () => {
    const column = await pool().query(
      `select data_type, is_nullable, column_default from information_schema.columns
       where table_name = 'api_keys' and column_name = 'audience'`,
    );
    expect(column.rows[0]).toMatchObject({ data_type: 'text', is_nullable: 'NO' });
    expect(column.rows[0].column_default).toContain("'public-api'");
    const index = await pool().query<{ indexdef: string }>(
      `select indexdef from pg_indexes where indexname = 'api_keys_tenant_user_audience_idx'`,
    );
    expect(index.rows[0]?.indexdef).toContain('(tenant_id, user_id, audience)');
  });
});

describe('0016_mcp_oauth and 0017_workflow_builder_sessions tables', () => {
  it('creates all six tables with row-level security and the tenant_isolation policy', async () => {
    const { rows } = await pool().query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relname = any($1) and relkind = 'r'`,
      [S4_TABLES],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...S4_TABLES].sort());
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    const policies = await pool().query<{ tablename: string; qual: string; with_check: string }>(
      `select tablename, qual, with_check from pg_policies where policyname = 'tenant_isolation' and tablename = any($1)`,
      [S4_TABLES],
    );
    expect(policies.rows.map((p) => p.tablename).sort()).toEqual([...S4_TABLES].sort());
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
      [S4_TABLES],
    );
    const shape = (table: string) =>
      Object.fromEntries(
        rows
          .filter((r) => r.table_name === table)
          .map((r) => [r.column_name, `${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}`]),
      );
    const tz = 'timestamp with time zone';
    const token = {
      token_hash: 'text not null',
      tenant_id: 'uuid not null',
      client_id: 'text not null',
      user_id: 'uuid not null',
      resource: 'text not null',
      scope: 'ARRAY not null',
      expires_at: `${tz} not null`,
      created_at: `${tz} not null`,
    };
    expect(shape('oauth_clients')).toEqual({
      id: 'text not null',
      tenant_id: 'uuid not null',
      name: 'text not null',
      redirect_uris: 'jsonb not null',
      grant_types: 'jsonb not null',
      token_endpoint_auth_method: 'text not null',
      client_secret_hash: 'text',
      client_secret_expires_at: tz,
      created_at: `${tz} not null`,
    });
    expect(shape('oauth_authorization_codes')).toEqual({
      code_hash: 'text not null',
      tenant_id: 'uuid not null',
      client_id: 'text not null',
      user_id: 'uuid not null',
      redirect_uri: 'text not null',
      code_challenge: 'text not null',
      code_challenge_method: 'text not null',
      state: 'text',
      resource: 'text not null',
      scope: 'ARRAY not null',
      expires_at: `${tz} not null`,
      used: 'boolean not null',
    });
    expect(shape('oauth_access_tokens')).toEqual(token);
    expect(shape('oauth_refresh_tokens')).toEqual(token);
    expect(shape('oauth_user_consents')).toEqual({
      tenant_id: 'uuid not null',
      user_id: 'uuid not null',
      client_id: 'text not null',
      scope: 'ARRAY not null',
      granted_at: `${tz} not null`,
    });
    expect(shape('workflow_builder_sessions')).toEqual({
      id: 'uuid not null',
      tenant_id: 'uuid not null',
      workflow_id: 'uuid not null',
      user_id: 'uuid not null',
      messages: 'jsonb not null',
      previous_summary: 'text',
      active_version_card_id: 'text',
      resume_after_restore_message_id: 'text',
      allowed_web_domains: 'jsonb not null',
      created_at: `${tz} not null`,
      updated_at: `${tz} not null`,
    });
  });

  it('keeps the tenant, (tenant, user) and expiry indexes', async () => {
    const { rows } = await pool().query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = any($1)`,
      [S4_TABLES],
    );
    const def = (name: string) => rows.find((r) => r.indexname === name)?.indexdef ?? '';
    expect(def('oauth_clients_tenant_idx')).toContain('(tenant_id)');
    for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens']) {
      expect(def(`${table}_tenant_user_idx`)).toContain('(tenant_id, user_id)');
      expect(def(`${table}_expires_idx`)).toContain('(expires_at)');
    }
    expect(def('oauth_user_consents_tenant_user_client_unique')).toContain(
      'UNIQUE INDEX oauth_user_consents_tenant_user_client_unique ON public.oauth_user_consents USING btree (tenant_id, user_id, client_id)',
    );
    expect(def('workflow_builder_sessions_tenant_workflow_user_unique')).toContain(
      'USING btree (tenant_id, workflow_id, user_id)',
    );
  });

  it('gives a new code, consent and builder session their defaults', async () => {
    const w = await workspace();
    await seedAll(w);
    const code = (await pool().query('select used, scope, state from oauth_authorization_codes')).rows[0];
    expect(code).toEqual({ used: false, scope: [], state: null });
    const token = (await pool().query('select scope, created_at from oauth_access_tokens')).rows[0];
    expect(token.scope).toEqual([]);
    expect(token.created_at).toBeInstanceOf(Date);
    const consent = (await pool().query('select scope, granted_at from oauth_user_consents')).rows[0];
    expect(consent.scope).toEqual(['tool:listWorkflows']);
    expect(consent.granted_at).toBeInstanceOf(Date);
    const session = (await pool().query('select * from workflow_builder_sessions')).rows[0];
    expect(session).toMatchObject({
      tenant_id: w.tenantId,
      workflow_id: w.workflowId,
      user_id: w.userId,
      messages: [],
      previous_summary: null,
      active_version_card_id: null,
      resume_after_restore_message_id: null,
      allowed_web_domains: [],
    });
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a token of a missing client, a second consent and a second session of the same user', async () => {
    const w = await workspace();
    await seedAll(w);
    const clientId = (await pool().query('select id from oauth_clients')).rows[0].id as string;
    expect(
      await codeOf(
        pool().query(
          `insert into oauth_access_tokens (token_hash, tenant_id, client_id, user_id, resource, expires_at)
           values ('h', $1, 'missing', $2, 'r', now())`,
          [w.tenantId, w.userId],
        ),
      ),
    ).toBe(FK_VIOLATION);
    expect(
      await codeOf(
        pool().query('insert into oauth_user_consents (tenant_id, user_id, client_id) values ($1, $2, $3)', [
          w.tenantId,
          w.userId,
          clientId,
        ]),
      ),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await codeOf(
        pool().query(
          'insert into workflow_builder_sessions (tenant_id, workflow_id, user_id) values ($1, $2, $3)',
          [w.tenantId, w.workflowId, w.userId],
        ),
      ),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('deletes codes, tokens and consents with their client, and a session with its workflow', async () => {
    const w = await workspace();
    const other = await workspace();
    const clientId = await seedAll(w);
    await seedAll(other);
    await pool().query('delete from oauth_clients where id = $1', [clientId]);
    for (const table of OAUTH_TABLES.slice(1)) {
      const { rows } = await pool().query(`select tenant_id from ${table}`);
      expect(rows, table).toEqual([{ tenant_id: other.tenantId }]);
    }
    await pool().query('delete from workflows where id = $1', [w.workflowId]);
    const sessions = await pool().query('select tenant_id from workflow_builder_sessions');
    expect(sessions.rows).toEqual([{ tenant_id: other.tenantId }]);
  });

  it('hides another tenant’s rows from a role other than the owner, and refuses writing them', async () => {
    const a = await workspace();
    const b = await workspace();
    await seedAll(a);
    await seedAll(b);
    await pool().query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workflow_rls_probe') THEN
        CREATE ROLE workflow_rls_probe NOLOGIN;
      END IF;
    END $$`);
    await pool().query(`GRANT SELECT, INSERT ON ${S4_TABLES.join(', ')} TO workflow_rls_probe`);
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      // the test user is a superuser and bypasses RLS; the probe role does not
      await client.query('SET LOCAL ROLE workflow_rls_probe');
      for (const table of S4_TABLES) {
        expect((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
      }
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
      for (const table of S4_TABLES) {
        const rows = (await client.query(`SELECT tenant_id FROM ${table}`)).rows;
        expect(rows, table).toEqual([{ tenant_id: a.tenantId }]);
      }
      await client.query('SAVEPOINT write_other');
      expect(
        await codeOf(
          client.query(
            'insert into workflow_builder_sessions (tenant_id, workflow_id, user_id) values ($1, $2, $3)',
            [b.tenantId, b.workflowId, a.userId],
          ),
        ),
      ).toBe(RLS_VIOLATION);
      await client.query('ROLLBACK TO SAVEPOINT write_other');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('ApiKeyRepository audience (P5-04)', () => {
  async function addKey(w: { tenantId: string; userId: string }, audience?: string) {
    return repos().apiKeys.create({
      tenantId: w.tenantId,
      userId: w.userId,
      name: audience ?? 'default',
      prefix: randomUUID().slice(0, 8),
      keyHash: hash(randomUUID()),
      ...(audience ? { audience } : {}),
    });
  }

  it('defaults to public-api; list and delete stay in the public audience, so an MCP key never shows', async () => {
    const w = await workspace();
    const publicKey = await addKey(w);
    const mcpKey = await addKey(w, 'mcp-server-api');
    expect(publicKey.audience).toBe('public-api');
    expect(mcpKey.audience).toBe('mcp-server-api');

    expect((await repos().apiKeys.list(w.tenantId, w.userId)).map((k) => k.id)).toEqual([publicKey.id]);
    expect((await repos().apiKeys.list(w.tenantId, w.userId, 'mcp-server-api')).map((k) => k.id)).toEqual([
      mcpKey.id,
    ]);
    expect(await repos().apiKeys.delete(w.tenantId, w.userId, mcpKey.id)).toBe(false);
    expect((await repos().apiKeys.getByHash(mcpKey.keyHash))?.audience).toBe('mcp-server-api');
    expect(await repos().apiKeys.delete(w.tenantId, w.userId, mcpKey.id, 'mcp-server-api')).toBe(true);
    expect(await repos().apiKeys.delete(w.tenantId, w.userId, publicKey.id)).toBe(true);
  });

  it('gets and deletes the user’s key of one audience only, never another user’s or tenant’s', async () => {
    const w = await workspace();
    const other = await workspace();
    const publicKey = await addKey(w);
    const mcpKey = await addKey(w, 'mcp-server-api');
    const otherKey = await addKey(other, 'mcp-server-api');

    const got = await repos().apiKeys.getForUser(w.tenantId, w.userId, 'mcp-server-api');
    expect(got).toMatchObject({ id: mcpKey.id, audience: 'mcp-server-api', prefix: mcpKey.prefix });
    expect(got && 'keyHash' in got).toBe(false);
    expect(await repos().apiKeys.getForUser(w.tenantId, other.userId, 'mcp-server-api')).toBeUndefined();
    expect(await repos().apiKeys.getForUser(other.tenantId, w.userId, 'mcp-server-api')).toBeUndefined();

    expect(await repos().apiKeys.deleteForUser(w.tenantId, w.userId, 'mcp-server-api')).toBe(true);
    expect(await repos().apiKeys.deleteForUser(w.tenantId, w.userId, 'mcp-server-api')).toBe(false);
    expect(await repos().apiKeys.getByHash(publicKey.keyHash)).toBeDefined();
    expect(await repos().apiKeys.getByHash(otherKey.keyHash)).toBeDefined();
  });
});

describe('BuilderSessionRepository (P5-66)', () => {
  it('creates on first upsert, then changes only the keys the patch holds', async () => {
    const w = await workspace();
    const sessions = repos().builderSessions;
    expect(await sessions.get(w.tenantId, w.workflowId, w.userId)).toBeUndefined();

    // C0a's BuilderMessage shape is not this part's to pin; the column stores what it is given
    const message = {
      id: 'm1',
      role: 'user',
      text: 'Build a webhook',
      createdAt: '2026-11-08T00:00:00Z',
    } as unknown as NonNullable<BuilderSessionPatch['messages']>[number];
    const created = await sessions.upsert(w.tenantId, w.workflowId, w.userId, { messages: [message] });
    expect(created).toMatchObject({
      tenantId: w.tenantId,
      workflowId: w.workflowId,
      userId: w.userId,
      messages: [message],
      previousSummary: null,
      allowedWebDomains: [],
    });

    const updated = await sessions.upsert(w.tenantId, w.workflowId, w.userId, {
      previousSummary: 'summary',
      allowedWebDomains: ['docs.example.com'],
      activeVersionCardId: undefined,
    });
    expect(updated.id).toBe(created.id);
    expect(updated).toMatchObject({
      messages: [message],
      previousSummary: 'summary',
      allowedWebDomains: ['docs.example.com'],
      activeVersionCardId: null,
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    const reset = await sessions.upsert(w.tenantId, w.workflowId, w.userId, { previousSummary: null });
    expect(reset.previousSummary).toBeNull();
    expect(await sessions.get(w.tenantId, w.workflowId, w.userId)).toEqual(reset);
  });

  it('keeps each user’s chat apart and never reads across tenants', async () => {
    const w = await workspace();
    const other = await workspace();
    const sessions = repos().builderSessions;
    await sessions.upsert(w.tenantId, w.workflowId, w.userId, { previousSummary: 'mine' });
    await sessions.upsert(w.tenantId, w.workflowId, other.userId, { previousSummary: 'theirs' });

    expect((await sessions.get(w.tenantId, w.workflowId, w.userId))?.previousSummary).toBe('mine');
    expect((await sessions.get(w.tenantId, w.workflowId, other.userId))?.previousSummary).toBe('theirs');
    expect(await sessions.get(other.tenantId, w.workflowId, w.userId)).toBeUndefined();
    expect(await sessions.get(w.tenantId, 'not-a-uuid', w.userId)).toBeUndefined();

    expect(await sessions.clear(other.tenantId, w.workflowId, w.userId)).toBe(false);
    expect(await sessions.clear(w.tenantId, w.workflowId, w.userId)).toBe(true);
    expect(await sessions.get(w.tenantId, w.workflowId, w.userId)).toBeUndefined();
    expect(await sessions.get(w.tenantId, w.workflowId, other.userId)).toBeDefined();
    expect(await sessions.clear(w.tenantId, w.workflowId, w.userId)).toBe(false);
  });
});

describe('repository registration', () => {
  it('registers builderSessions and mcpOAuth; the OAuth sweep stub removes nothing and does not throw', async () => {
    expect(repos().builderSessions).toBeInstanceOf(BuilderSessionRepository);
    expect(repos().mcpOAuth).toBeInstanceOf(McpOAuthRepository);
    for (const name of [
      'createClient',
      'getClient',
      'listClients',
      'countClients',
      'deleteClient',
      'saveCode',
      'takeCode',
      'saveTokens',
      'getAccessToken',
      'getRefreshToken',
      'rotateRefreshToken',
      'revokeToken',
      'revokeForClient',
      'getConsent',
      'saveConsent',
      'sweepExpired',
    ] as const) {
      expect(typeof repos().mcpOAuth[name], name).toBe('function');
    }
    await expect(repos().mcpOAuth.sweepExpired(new Date())).resolves.toEqual({
      codes: 0,
      accessTokens: 0,
      refreshTokens: 0,
    });
  });
});

describe('config.mcp and config.ai (P5-03, P5-04, P5-09, P5-14)', () => {
  it('has the planned defaults', () => {
    const config = loadConfig({ NODE_ENV: 'test', BASE_URL: 'http://localhost:5678/' });
    expect(config.mcp).toEqual({
      baseUrl: 'http://localhost:5678',
      managedByEnv: false,
      accessEnabled: false,
      builderEnabled: true,
      maxRegisteredClients: 5000,
      endpoint: 'mcp',
      endpointTest: 'mcp-test',
      sessionIdleTtlMs: 900000,
      sessionSweepMs: 300000,
      rateLimit: 100,
      oauthRateLimits: { register: 10, authorize: 50, token: 20, revoke: 30, wellKnown: 100 },
    });
    expect(config.ai).toEqual({ enabled: false, timeoutMaxS: 3600, allowSendingParameterValues: true });
  });

  it('reads every variable', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      BASE_URL: 'http://localhost:8080',
      MCP_BASE_URL: 'http://localhost:5678//',
      MCP_MANAGED_BY_ENV: 'true',
      MCP_ACCESS_ENABLED: 'true',
      MCP_BUILDER_ENABLED: 'false',
      MCP_MAX_REGISTERED_CLIENTS: '3',
      ENDPOINT_MCP: 'my-mcp',
      ENDPOINT_MCP_TEST: 'my_mcp_test',
      MCP_SERVER_SESSION_IDLE_TTL_MS: '1000',
      MCP_SERVER_SESSION_SWEEP_INTERVAL_MS: '500',
      MCP_SERVER_RATE_LIMIT: '7',
      OAUTH_SERVER_REGISTER_RATE_LIMIT: '1',
      OAUTH_SERVER_AUTHORIZE_RATE_LIMIT: '2',
      OAUTH_SERVER_TOKEN_RATE_LIMIT: '3',
      OAUTH_SERVER_REVOKE_RATE_LIMIT: '4',
      OAUTH_SERVER_WELL_KNOWN_RATE_LIMIT: '5',
      AI_ENABLED: 'true',
      AI_TIMEOUT_MAX: '60',
      AI_ALLOW_SENDING_PARAMETER_VALUES: 'false',
    });
    expect(config.baseUrl).toBe('http://localhost:8080');
    expect(config.mcp).toEqual({
      baseUrl: 'http://localhost:5678',
      managedByEnv: true,
      accessEnabled: true,
      builderEnabled: false,
      maxRegisteredClients: 3,
      endpoint: 'my-mcp',
      endpointTest: 'my_mcp_test',
      sessionIdleTtlMs: 1000,
      sessionSweepMs: 500,
      rateLimit: 7,
      oauthRateLimits: { register: 1, authorize: 2, token: 3, revoke: 4, wellKnown: 5 },
    });
    expect(config.ai).toEqual({ enabled: true, timeoutMaxS: 60, allowSendingParameterValues: false });
  });

  it('refuses a bad MCP base URL, an endpoint that is not one segment and two equal endpoints', () => {
    for (const env of [
      { MCP_BASE_URL: 'not a url' },
      { ENDPOINT_MCP: 'a/b' },
      { ENDPOINT_MCP_TEST: '' },
      { ENDPOINT_MCP: 'same', ENDPOINT_MCP_TEST: 'same' },
      { MCP_MAX_REGISTERED_CLIENTS: '0' },
      { AI_TIMEOUT_MAX: '0' },
    ]) {
      expect(() => loadConfig({ NODE_ENV: 'test', ...env }), JSON.stringify(env)).toThrow(ConfigError);
    }
  });
});
