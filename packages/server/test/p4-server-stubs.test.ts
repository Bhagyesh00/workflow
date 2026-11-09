/**
 * Phase 4 contract step (C0d): the real code of the server's new stub files. Route wiring (role,
 * validation, arguments handed to the service), the scope list, the provider registry and the boot
 * paths C0c calls. No database: each register function takes its services as explicit deps, so these
 * run on a bare Fastify with recording fakes. Stub return values are never asserted (lanes fill those).
 */
import { GLOBAL_ROLE_SCOPES, PROJECT_ROLE_SCOPES, type Scope } from '@workflow/workflow';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceDeps } from '../src/context';
import type { DbOrTx } from '../src/db/client';
import { API_KEY_SCOPES, assertApiKeyScope } from '../src/http/api-key-scopes';
import type { AuthContext } from '../src/http/auth';
import { handleError } from '../src/http/errors';
import { createRepositories } from '../src/repositories';
import { DataTableRepository } from '../src/repositories/data-tables';
import { SecretConnectionRepository } from '../src/repositories/secrets';
import { registerDataTableRoutes } from '../src/routes/data-tables';
import { registerFormAuthRoutes } from '../src/routes/form-auth';
import { PUBLIC_DATA_TABLE_ROUTES, publicDataTableHandlers } from '../src/routes/public-data-tables';
import { registerSecretConnectionRoutes } from '../src/routes/secret-connections';
import type { AccessService } from '../src/services/access';
import { DataTableService } from '../src/services/data-tables';
import { FormAuthService } from '../src/services/form-auth';
import { FormTokenService } from '../src/services/form-tokens';
import { SecretsManager } from '../src/services/secrets/manager';
import { SECRET_PROVIDER_TYPES } from '../src/services/secrets/providers';
import { collectSecretKeys, resolveCredentialData } from '../src/services/secrets/resolver';
import { SECRET_PROVIDER_STATES, type SecretProviderType } from '../src/services/secrets/types';

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const TABLE = '00000000-0000-4000-8000-000000000003';
const COLUMN = '00000000-0000-4000-8000-000000000004';
const PROJECT = '00000000-0000-4000-8000-000000000005';
const deps = {} as ServiceDeps;

type Role = 'viewer' | 'editor' | 'admin' | 'owner';
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const RANK: Role[] = ['viewer', 'editor', 'admin', 'owner'];

interface Call {
  method: string;
  args: unknown[];
}

/** a stand-in service: any `a.b(...)` records the call and answers an empty list */
function recorder(calls: Call[], sync: string[] = [], path: string[] = []): any {
  return new Proxy(() => {}, {
    get: (_target, key) =>
      key === 'then' || typeof key === 'symbol' ? undefined : recorder(calls, sync, [...path, key]),
    apply: (_target, _self, args) => {
      const method = path.join('.');
      calls.push({ method, args });
      return sync.includes(method) ? [] : Promise.resolve([]);
    },
  });
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * P6-39: the test names `editor` and `viewer` are a `member` holding `project:editor` or `project:viewer` on
 * the project of every row here (the row lookup of the real service is not on this bare app).
 */
const TEST_ROLE_SCOPES: Readonly<Record<'editor' | 'viewer', ReadonlySet<Scope>>> = {
  editor: new Set([...GLOBAL_ROLE_SCOPES.member, ...PROJECT_ROLE_SCOPES['project:editor']]),
  viewer: new Set([...GLOBAL_ROLE_SCOPES.member, ...PROJECT_ROLE_SCOPES['project:viewer']]),
};

/**
 * P6 S1: `requireScope` reads `request.server.access`. This fake answers owner and admin their global scopes
 * and the test names `TEST_ROLE_SCOPES`, without a row lookup.
 */
const testFakeAccess = {
  async scopesForAuth(auth: AuthContext): Promise<ReadonlySet<Scope>> {
    const role = auth.role as string;
    if (role === 'owner' || role === 'admin') return GLOBAL_ROLE_SCOPES[role];
    if (role === 'editor' || role === 'viewer') return TEST_ROLE_SCOPES[role];
    return new Set();
  },
  /** a create with no project goes to the project of every row here (the real service: the personal project) */
  async targetProject(_auth: AuthContext, projectId?: string | null): Promise<string> {
    return projectId ?? PROJECT;
  },
} as unknown as AccessService;

async function build(register: (rest: FastifyInstance) => void): Promise<FastifyInstance> {
  const instance = Fastify();
  instance.setErrorHandler(handleError);
  instance.decorateRequest('auth', null);
  instance.decorate('access', testFakeAccess);
  instance.addHook('onRequest', async (request) => {
    const role = request.headers['x-test-role'];
    if (role) {
      request.auth = { user: { id: USER }, tenant: { id: TENANT }, role } as unknown as AuthContext;
    }
  });
  await instance.register(async (rest) => register(rest), { prefix: '/rest' });
  app = instance;
  return instance;
}

const send = (instance: FastifyInstance, method: Method, url: string, role?: Role, payload?: object) =>
  instance.inject({
    method,
    url,
    headers: role ? { 'x-test-role': role } : {},
    ...(payload ? { payload } : {}),
  });

interface RouteRow {
  method: Method;
  url: string;
  minimum: Role;
  /** the service method the route hands over to */
  calls: string;
  payload?: object;
}

async function checkRoles(instance: FastifyInstance, calls: Call[], row: RouteRow): Promise<void> {
  const label = `${row.method} ${row.url}`;
  expect((await send(instance, row.method, row.url, undefined, row.payload)).statusCode, label).toBe(401);
  for (const role of RANK) {
    calls.length = 0;
    const answer = await send(instance, row.method, row.url, role, row.payload);
    if (RANK.indexOf(role) < RANK.indexOf(row.minimum)) {
      expect(answer.statusCode, `${label} as ${role}`).toBe(403);
      expect(calls, `${label} as ${role}`).toEqual([]);
    } else {
      expect(answer.statusCode, `${label} as ${role}: ${answer.body}`).toBe(200);
      expect(
        calls.map((c) => c.method),
        label,
      ).toEqual([row.calls]);
    }
  }
}

const base = `/rest/data-tables`;
const one = `${base}/${TABLE}`;
const column = `${one}/columns/${COLUMN}`;
const filter = { type: 'and', filters: [{ columnName: 'a', condition: 'eq', value: 1 }] };

const DATA_TABLE_ROUTES: RouteRow[] = [
  { method: 'GET', url: base, minimum: 'viewer', calls: 'list' },
  { method: 'GET', url: `${base}/limits`, minimum: 'viewer', calls: 'limits' },
  {
    method: 'POST',
    url: base,
    minimum: 'editor',
    calls: 'create',
    payload: { name: 'orders', columns: [{ name: 'total', type: 'number' }] },
  },
  {
    method: 'POST',
    url: `${base}/csv/preview`,
    minimum: 'editor',
    calls: 'csvPreview',
    payload: { csv: 'a,b\n1,2', hasHeaders: true },
  },
  { method: 'GET', url: one, minimum: 'viewer', calls: 'get' },
  { method: 'PATCH', url: one, minimum: 'editor', calls: 'patch', payload: { name: 'renamed' } },
  { method: 'DELETE', url: one, minimum: 'editor', calls: 'delete' },
  { method: 'GET', url: `${one}/dependencies`, minimum: 'viewer', calls: 'dependencies' },
  { method: 'GET', url: `${one}/columns`, minimum: 'viewer', calls: 'columns.list' },
  {
    method: 'POST',
    url: `${one}/columns`,
    minimum: 'editor',
    calls: 'columns.add',
    payload: { name: 'total', type: 'number' },
  },
  { method: 'DELETE', url: column, minimum: 'editor', calls: 'columns.delete' },
  {
    method: 'PATCH',
    url: `${column}/move`,
    minimum: 'editor',
    calls: 'columns.move',
    payload: { targetIndex: 1 },
  },
  {
    method: 'PATCH',
    url: `${column}/rename`,
    minimum: 'editor',
    calls: 'columns.rename',
    payload: { name: 'sum' },
  },
  { method: 'GET', url: `${one}/rows`, minimum: 'viewer', calls: 'rows.list' },
  {
    method: 'POST',
    url: `${one}/insert`,
    minimum: 'editor',
    calls: 'rows.insert',
    payload: { data: [{ a: 1 }], returnType: 'id' },
  },
  {
    method: 'POST',
    url: `${one}/upsert`,
    minimum: 'editor',
    calls: 'rows.upsert',
    payload: { filter, data: { a: 2 } },
  },
  {
    method: 'PATCH',
    url: `${one}/rows`,
    minimum: 'editor',
    calls: 'rows.update',
    payload: { filter, data: { a: 2 } },
  },
  { method: 'DELETE', url: `${one}/rows`, minimum: 'editor', calls: 'rows.delete' },
  { method: 'DELETE', url: `${one}/rows/clear`, minimum: 'editor', calls: 'rows.clear' },
  { method: 'GET', url: `${one}/download-csv`, minimum: 'viewer', calls: 'downloadCsv' },
  {
    method: 'POST',
    url: `${one}/import-csv`,
    minimum: 'editor',
    calls: 'importCsv',
    payload: { csv: 'a\n1' },
  },
];

describe('routes/data-tables.ts', () => {
  async function tables() {
    const calls: Call[] = [];
    const instance = await build((rest) => registerDataTableRoutes(rest, { dataTables: recorder(calls) }));
    return { calls, instance };
  }

  it.each(DATA_TABLE_ROUTES.map((row) => [`${row.method} ${row.url}`, row] as const))(
    '%s: signed out 401, below the role 403 and no service call, the role reaches the service',
    async (_label, row) => {
      const { calls, instance } = await tables();
      await checkRoles(instance, calls, row);
    },
  );

  it('answers a page of tables or rows under data, with its count, as the editor client reads it', async () => {
    const page = { count: 12, data: [{ id: 1 }] };
    const dataTables = { list: async () => page, rows: { list: async () => page } } as never;
    const instance = await build((rest) => registerDataTableRoutes(rest, { dataTables }));
    for (const url of [base, `${one}/rows`]) {
      const answer = await send(instance, 'GET', url, 'viewer');
      expect(answer.statusCode, url).toBe(200);
      expect(answer.json(), url).toEqual({ data: page });
    }
  });

  it('always scopes the service call to the signed-in tenant', async () => {
    const { calls, instance } = await tables();
    for (const row of DATA_TABLE_ROUTES) {
      calls.length = 0;
      await send(instance, row.method, row.url, 'owner', row.payload);
      expect(calls[0]?.args[0], row.calls).toBe(TENANT);
    }
  });

  it('refuses an id that is not a uuid, before any service call', async () => {
    const { calls, instance } = await tables();
    expect((await send(instance, 'GET', `${base}/nope`, 'viewer')).statusCode).toBe(400);
    expect((await send(instance, 'GET', `${one}/rows?filter=`, 'viewer')).statusCode).toBe(400);
    expect((await send(instance, 'DELETE', `${one}/columns/nope`, 'editor')).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('reads filter as JSON, and refuses bad JSON or an unknown condition', async () => {
    const { calls, instance } = await tables();
    const q = (value: unknown) => encodeURIComponent(JSON.stringify(value));
    const ok = await send(instance, 'GET', `${one}/rows?filter=${q(filter)}`, 'viewer');
    expect(ok.statusCode).toBe(200);
    expect(calls[0]?.args[2]).toMatchObject({ filter });

    calls.length = 0;
    expect((await send(instance, 'GET', `${one}/rows?filter=%7Bnope`, 'viewer')).statusCode).toBe(400);
    const unknown = q({ type: 'and', filters: [{ columnName: 'a', condition: 'regex', value: '.' }] });
    expect((await send(instance, 'GET', `${one}/rows?filter=${unknown}`, 'viewer')).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('caps take at 250 as n8n, and reads sortBy as column:direction', async () => {
    const { calls, instance } = await tables();
    await send(instance, 'GET', `${one}/rows?take=9000&skip=5&sortBy=total:desc&search=x`, 'viewer');
    expect(calls[0]?.args[2]).toMatchObject({
      take: 250,
      skip: 5,
      sortBy: { column: 'total', direction: 'desc' },
      search: 'x',
    });

    calls.length = 0;
    await send(
      instance,
      'GET',
      `${base}?sortBy=updatedAt:asc&filter=${encodeURIComponent('{"name":"or"}')}`,
      'viewer',
    );
    expect(calls[0]?.args[1]).toMatchObject({
      name: 'or',
      sortBy: { column: 'updatedAt', direction: 'asc' },
    });
    calls.length = 0;
    await send(instance, 'GET', `${base}?sortBy=size:desc`, 'viewer');
    expect(calls[0]?.args[1]).toMatchObject({ sortBy: { column: 'size', direction: 'desc' } });
    expect((await send(instance, 'GET', `${base}?sortBy=bogus:asc`, 'viewer')).statusCode).toBe(400);
  });

  it('hands DELETE rows an empty filter so the service answers the "no filter" text', async () => {
    const { calls, instance } = await tables();
    await send(instance, 'DELETE', `${one}/rows?dryRun=true`, 'editor');
    expect(calls[0]?.args[2]).toEqual({ type: 'and', filters: [] });
    expect(calls[0]?.args[3]).toMatchObject({ dryRun: true, returnData: false });
  });

  it('checks the column name rule, and insert answers count unless asked', async () => {
    const { calls, instance } = await tables();
    const bad = { name: 'x', columns: [{ name: '1bad', type: 'string' }] };
    expect((await send(instance, 'POST', base, 'editor', bad)).statusCode).toBe(400);
    const badType = { name: 'x', columns: [{ name: 'a', type: 'json' }] };
    expect((await send(instance, 'POST', base, 'editor', badType)).statusCode).toBe(400);
    expect(calls).toEqual([]);

    await send(instance, 'POST', `${one}/insert`, 'editor', { data: [{ a: 1 }] });
    expect(calls[0]?.args[3]).toBe('count');
  });
});

const providers = '/rest/secret-providers';
const connection = `${providers}/connections/vaultOne`;
const SECRET_ROUTES: RouteRow[] = [
  { method: 'GET', url: `${providers}/types`, minimum: 'admin', calls: 'listTypes' },
  { method: 'GET', url: `${providers}/connections`, minimum: 'admin', calls: 'listConnections' },
  {
    method: 'POST',
    url: `${providers}/connections`,
    minimum: 'admin',
    calls: 'createConnection',
    payload: { providerKey: 'vaultOne', type: 'vault', settings: { url: 'https://v/' } },
  },
  { method: 'GET', url: connection, minimum: 'admin', calls: 'getConnection' },
  {
    method: 'PATCH',
    url: connection,
    minimum: 'admin',
    calls: 'updateConnection',
    payload: { isEnabled: true },
  },
  { method: 'DELETE', url: connection, minimum: 'admin', calls: 'deleteConnection' },
  { method: 'POST', url: `${connection}/test`, minimum: 'admin', calls: 'testConnection' },
  { method: 'POST', url: `${connection}/reload`, minimum: 'admin', calls: 'reloadConnection' },
  // P6-39: the global names need the global `externalSecret:list` (owner and admin); a project editor lists a
  // project's names on `/completions/secrets/project/:projectId`
  { method: 'GET', url: `${providers}/completions/secrets`, minimum: 'admin', calls: 'completions' },
  {
    method: 'GET',
    url: `${providers}/completions/secrets/global`,
    minimum: 'admin',
    calls: 'completions',
  },
];

describe('routes/secret-connections.ts', () => {
  async function secrets() {
    const calls: Call[] = [];
    const instance = await build((rest) =>
      registerSecretConnectionRoutes(rest, { secrets: recorder(calls, ['listTypes']) }),
    );
    return { calls, instance };
  }

  it.each(SECRET_ROUTES.map((row) => [`${row.method} ${row.url}`, row] as const))(
    '%s: admin manages, editor lists names, nobody else gets in',
    async (_label, row) => {
      const { calls, instance } = await secrets();
      await checkRoles(instance, calls, row);
    },
  );

  it('keeps the provider key to n8n rule', async () => {
    const { calls, instance } = await secrets();
    for (const providerKey of ['', '1vault', 'my-vault', 'a.b', 'x'.repeat(129)]) {
      const answer = await send(instance, 'POST', `${providers}/connections`, 'admin', {
        providerKey,
        type: 'vault',
        settings: {},
      });
      expect(answer.statusCode, providerKey).toBe(400);
    }
    expect((await send(instance, 'GET', `${providers}/connections/a.b`, 'admin')).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('answers a provider type without its create function, 404 when unknown', async () => {
    const type: SecretProviderType = {
      name: 'fake',
      displayName: 'Fake',
      properties: [],
      create: () => {
        throw new Error('not called');
      },
    };
    const manager = new SecretsManager(deps, { secretProviderTypes: [type] });
    const instance = await build((rest) => registerSecretConnectionRoutes(rest, { secrets: manager }));
    const list = await send(instance, 'GET', `${providers}/types`, 'admin');
    expect(list.statusCode).toBe(200);
    const fake = list.json().data.find((t: { name: string }) => t.name === 'fake');
    expect(fake).toEqual({ name: 'fake', displayName: 'Fake', properties: [] });

    const single = await send(instance, 'GET', `${providers}/types/fake`, 'admin');
    expect(single.json().data).toEqual({ name: 'fake', displayName: 'Fake', properties: [] });
    expect((await send(instance, 'GET', `${providers}/types/nope`, 'admin')).statusCode).toBe(404);
    expect((await send(instance, 'GET', `${providers}/types/fake`, 'editor')).statusCode).toBe(403);
  });
});

describe('routes/form-auth.ts', () => {
  async function formAuth() {
    const calls: Call[] = [];
    const instance = await build((rest) => registerFormAuthRoutes(rest, { formAuth: recorder(calls) }));
    return { calls, instance };
  }
  const code = '/rest/form-auth/code';

  it('POST /form-auth/code: a session is required, any member may ask, for themselves only', async () => {
    const { calls, instance } = await formAuth();
    const payload = { returnTo: '/form/acme/survey?x=1' };
    expect((await send(instance, 'POST', code, undefined, payload)).statusCode).toBe(401);
    expect((await send(instance, 'POST', code, 'viewer', payload)).statusCode).toBe(200);
    expect(calls).toEqual([{ method: 'issueCode', args: [USER, payload.returnTo] }]);
  });

  it.each(['/form-test/acme/survey', '/form-waiting/abc'])('accepts returnTo %s', async (returnTo) => {
    const { instance } = await formAuth();
    expect((await send(instance, 'POST', code, 'viewer', { returnTo })).statusCode).toBe(200);
  });

  it.each(['https://evil.example/form/x', '//evil.example/form/x', '/rest/me', '/formx/a', ''])(
    'refuses returnTo %s (no open redirect)',
    async (returnTo) => {
      const { calls, instance } = await formAuth();
      expect((await send(instance, 'POST', code, 'viewer', { returnTo })).statusCode).toBe(400);
      expect(calls).toEqual([]);
    },
  );
});

describe('routes/public-data-tables.ts', () => {
  it("lists n8n's 16 routes, each with a handler and a scope from API_KEY_SCOPES", () => {
    expect(PUBLIC_DATA_TABLE_ROUTES).toHaveLength(16);
    expect(Object.keys(publicDataTableHandlers)).toHaveLength(16);
    expect(new Set(PUBLIC_DATA_TABLE_ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(16);
    for (const route of PUBLIC_DATA_TABLE_ROUTES) {
      expect(API_KEY_SCOPES, route.path).toContain(route.scope);
      expect(typeof route.handler, route.path).toBe('function');
      expect(route.tag).toBe('DataTable');
    }
  });

  it('checks the data-table scope of the key user: reads read, writes write, the list filters', () => {
    const scopes = Object.fromEntries(
      PUBLIC_DATA_TABLE_ROUTES.map((r) => [
        `${r.method} ${r.path}`,
        'scope' in r.access ? r.access.scope : null,
      ]),
    );
    const one = '/data-tables/:dataTableId';
    expect(scopes).toEqual({
      'GET /data-tables': 'dataTable:listProject',
      'POST /data-tables': 'dataTable:create',
      [`GET ${one}`]: 'dataTable:read',
      [`PATCH ${one}`]: 'dataTable:update',
      [`DELETE ${one}`]: 'dataTable:delete',
      [`GET ${one}/dependencies`]: 'dataTable:read',
      [`GET ${one}/columns`]: 'dataTable:readColumn',
      [`POST ${one}/columns`]: 'dataTable:writeColumn',
      [`PATCH ${one}/columns/:columnId`]: 'dataTable:writeColumn',
      [`DELETE ${one}/columns/:columnId`]: 'dataTable:writeColumn',
      [`GET ${one}/rows`]: 'dataTable:readRow',
      [`POST ${one}/rows`]: 'dataTable:writeRow',
      [`POST ${one}/rows/upsert`]: 'dataTable:writeRow',
      [`PATCH ${one}/rows/update`]: 'dataTable:writeRow',
      [`DELETE ${one}/rows/delete`]: 'dataTable:writeRow',
      [`DELETE ${one}/rows/clear`]: 'dataTable:writeRow',
    });
    for (const route of PUBLIC_DATA_TABLE_ROUTES) {
      expect('role' in route, `${route.method} ${route.path}`).toBe(false);
    }
  });

  it('pages with limit (default 100, max 250) and cursor', () => {
    const listed = PUBLIC_DATA_TABLE_ROUTES.filter((r) => r.list);
    expect(listed.map((r) => r.path)).toEqual(['/data-tables', '/data-tables/:dataTableId/rows']);
    for (const route of listed) {
      expect(route.query?.parse({})).toMatchObject({ limit: 100 });
      expect(route.query?.safeParse({ limit: '251' }).success).toBe(false);
      expect(route.query?.parse({ limit: '250', cursor: 'abc' })).toMatchObject({
        limit: 250,
        cursor: 'abc',
      });
    }
  });
});

describe('http/api-key-scopes.ts', () => {
  it("names every scope once, in n8n's resource:action form", () => {
    expect(new Set(API_KEY_SCOPES).size).toBe(API_KEY_SCOPES.length);
    for (const scope of API_KEY_SCOPES) expect(scope).toMatch(/^[a-zA-Z]+:[a-zA-Z]+$/);
  });

  it('holds what the plan names for the public routes', () => {
    expect(API_KEY_SCOPES).toEqual(
      expect.arrayContaining([
        'workflow:list',
        'workflow:activate',
        'workflowTags:update',
        'execution:retry',
        'credential:create',
        'tag:list',
        'variable:update',
        'user:list',
        'project:list',
        'sourceControl:pull',
        'securityAudit:generate',
        'folder:list',
        'dataTable:list',
        'dataTable:create',
        'dataTable:read',
        'dataTable:update',
        'dataTable:delete',
        'dataTableColumn:create',
        'dataTableColumn:read',
        'dataTableColumn:update',
        'dataTableColumn:delete',
        'dataTableRow:create',
        'dataTableRow:read',
        'dataTableRow:update',
        'dataTableRow:upsert',
        'dataTableRow:delete',
      ]),
    );
  });

  it('exports the assert the public API calls', () => {
    expect(typeof assertApiKeyScope).toBe('function');
  });
});

describe('services/secrets', () => {
  it('lists the six states', () => {
    expect(SECRET_PROVIDER_STATES).toEqual([
      'initializing',
      'initialized',
      'connecting',
      'connected',
      'error',
      'retrying',
    ]);
  });

  it('registers the six providers once each, with a create function', () => {
    expect(SECRET_PROVIDER_TYPES.map((t) => t.name)).toEqual([
      'awsSecretsManager',
      'gcpSecretsManager',
      'azureKeyVault',
      'vault',
      'onepassword',
      'infisical',
    ]);
    for (const type of SECRET_PROVIDER_TYPES) {
      expect(type.displayName, type.name).not.toBe('');
      expect(Array.isArray(type.properties), type.name).toBe(true);
      expect(typeof type.create, type.name).toBe('function');
    }
  });

  it('adds extra provider types to the built-in six, and an extra can replace one by name', () => {
    const extra = (name: string, displayName: string): SecretProviderType => ({
      name,
      displayName,
      properties: [],
      create: () => {
        throw new Error('not called');
      },
    });
    const plain = new SecretsManager(deps);
    expect(plain.listTypes()).toHaveLength(6);
    expect(plain.getType('nope')).toBeUndefined();

    const manager = new SecretsManager(deps, {
      secretProviderTypes: [extra('testVault', 'Test vault'), extra('vault', 'Own vault')],
    });
    expect(manager.listTypes().map((t) => t.name)).toEqual([
      'awsSecretsManager',
      'gcpSecretsManager',
      'azureKeyVault',
      'vault',
      'onepassword',
      'infisical',
      'testVault',
    ]);
    expect(manager.getType('testVault')?.displayName).toBe('Test vault');
    expect(manager.getType('vault')?.displayName).toBe('Own vault');
  });

  it('start and stop run at boot and close, so they must not fail before L9', async () => {
    const manager = new SecretsManager(deps);
    await expect(manager.start()).resolves.toBeUndefined();
    await expect(manager.stop()).resolves.toBeUndefined();
  });

  it('exports the resolver lanes call', () => {
    expect(typeof resolveCredentialData).toBe('function');
    expect(typeof collectSecretKeys).toBe('function');
  });
});

describe('boot paths C0c builds on', () => {
  it('forProject hands out an access object: every execution builds one, so it must not throw', () => {
    const access = new DataTableService(deps).forProject(TENANT, PROJECT, { workflowId: 'w1' });
    for (const method of [
      'listTables',
      'getTable',
      'createTable',
      'renameTable',
      'deleteTable',
      'clearTable',
      'listColumns',
      'insertRows',
      'getRows',
      'updateRows',
      'upsertRow',
      'deleteRows',
      'rowsExist',
    ] as const) {
      expect(typeof access[method], method).toBe('function');
    }
    expect(typeof new DataTableService(deps).forProject(TENANT, PROJECT).getRows).toBe('function');
  });

  it('the services build with their deps alone', () => {
    expect(new FormTokenService(deps)).toBeInstanceOf(FormTokenService);
    const formAuth = new FormAuthService(deps);
    for (const method of ['signInUrl', 'exchangeCode', 'verifyToken', 'canExecute', 'issueCode'] as const) {
      expect(typeof formAuth[method], method).toBe('function');
    }
  });

  it('repositories/index.ts gains dataTables and secrets', () => {
    const repos = createRepositories({} as DbOrTx);
    expect(repos.dataTables).toBeInstanceOf(DataTableRepository);
    expect(repos.secrets).toBeInstanceOf(SecretConnectionRepository);
    expect(typeof repos.dataTables.get).toBe('function');
  });
});
