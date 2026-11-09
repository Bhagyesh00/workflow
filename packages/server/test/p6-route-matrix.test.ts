/**
 * P6 S1 (C0e): the route matrix. Every route of the server has a row in p6-route-matrix.rows.ts; for each
 * row the four roles owner, admin, editor and viewer call it on a real row of the owner's workspace.
 * Allowed means anything but 403 (a signed-in route also never 401), refused means 403. A 2xx on a write
 * rebuilds the rows it may have removed, so the next role meets a real row again.
 *
 * True mode (P6-39, the cutover): scopes only. `editor` and `viewer` are test names for a `member` holding
 * `project:editor` or `project:viewer` on the team project where the fixture rows live. A role may call a row
 * when it holds the row's scope where the route checks it (`expectedScopes`): on the row's target (a workflow,
 * credential, data table, folder, run, variable or project; a review or test run on its workflow), on the
 * caller's personal project for a create with no project (`check: 'personal'`), else the workspace role's
 * global scopes. A `null` scope is any signed-in user with `access`, and the owner alone without it.
 * Each row with a scope also runs in true mode for members of custom roles (`exactCallers`): one holding
 * exactly the row's scope passes, one holding another scope gets 403 (unless every member holds it), a
 * member with no relation to the row's project gets 403 (the hidden row), and another workspace's id is 404.
 *
 * `route matrix completeness` captures every route Fastify registers (an `onRoute` hook on each instance)
 * and fails when a route has no row or a row has no route. M(f) = `-t "route file <f>"`.
 */
import { randomUUID } from 'node:crypto';
import { customRoleAllowedScopes, type Scope } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => [] as Array<{ method: string | string[]; url: string }>);

vi.mock('fastify', async (importOriginal) => {
  const mod = await importOriginal<typeof import('fastify')>();
  const create = mod.default as unknown as (options?: unknown) => {
    addHook(name: 'onRoute', hook: (route: { method: string | string[]; url: string }) => void): void;
  };
  const wrapped = (options?: unknown) => {
    const app = create(options);
    app.addHook('onRoute', (route) => {
      captured.push({ method: route.method, url: route.url });
    });
    return app;
  };
  return { ...mod, default: wrapped, fastify: wrapped };
});

import type { AccessTarget } from '../src/services/access';
import {
  addToProject,
  createTestServer,
  credentialIn,
  dataTableIn,
  folderIn,
  freePort,
  memberAs,
  ORIGIN,
  projectIn,
  signup,
  TestClient,
  type TestServer,
  teamProjectOf,
  workflowIn,
} from './helpers';
import { ROUTE_MATRIX_ROWS, type RouteMatrixRow } from './p6-route-matrix.rows';

const ROLES = ['viewer', 'editor', 'admin', 'owner'] as const;
type MatrixRole = (typeof ROLES)[number];
const FULL_METHODS = 'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT,QUERY,TRACE';
/** one caller IP per role, so the per-IP rate limits never mix roles */
const ADDRESS: Record<MatrixRole, string> = {
  viewer: '10.91.0.1',
  editor: '10.91.0.2',
  admin: '10.91.0.3',
  owner: '10.91.0.4',
};

interface Caller {
  client: TestClient;
  userId: string;
  email: string;
  key: string;
  /** the caller's IP (the four roles use `ADDRESS`) */
  address?: string;
}

interface Fixtures {
  team: string;
  project: string;
  workflow: string;
  versionId: string;
  credential: string;
  dataTable: string;
  column: string;
  folder: string;
  execution: string;
  variable: string;
  tag: string;
  annotationTag: string;
  member: string;
  review: string;
  testRun: string;
  thread: string;
}

let server: TestServer;
let baseUrl: string;
let tenantId: string;
let tenantSlug: string;
const callers = {} as Record<MatrixRole, Caller>;
const fx = {} as Fixtures;
let seq = 0;

/** the rows of another workspace, for the 404 of a foreign id */
type ForeignFixtures = Pick<
  Fixtures,
  | 'workflow'
  | 'versionId'
  | 'credential'
  | 'dataTable'
  | 'column'
  | 'folder'
  | 'execution'
  | 'variable'
  | 'project'
>;
const foreign = {} as ForeignFixtures;
/** the targets a foreign id is checked on (rows the route loads by id) */
const FOREIGN_TARGETS = new Set([
  'workflow',
  'credential',
  'dataTable',
  'folder',
  'execution',
  'variable',
  'project',
]);

/** makes every fixture row that does not exist (any more) */
async function ensureFixtures(): Promise<void> {
  const { repos } = server.ctx;
  const owner = callers.owner;
  seq++;
  if (!fx.team) fx.team = await teamProjectOf(server, tenantId);
  if (!fx.project || !(await repos.projects.get(tenantId, fx.project))) {
    fx.project = (await projectIn(server, tenantId, `Matrix project ${seq}`)).id;
    await addToProject(server, tenantId, fx.project, owner.userId, 'project:admin');
  }
  if (!fx.workflow || !(await repos.workflows.get(tenantId, fx.workflow))) {
    const workflow = await workflowIn(server, tenantId, fx.team, {
      name: `Matrix ${seq}`,
      createdBy: owner.userId,
    });
    fx.workflow = workflow.id;
    fx.versionId = workflow.versionId;
    await repos.versions.create(tenantId, {
      id: workflow.versionId,
      workflowId: workflow.id,
      name: workflow.name,
      nodes: [],
      connections: {},
      settings: {},
      authorId: owner.userId,
    });
  }
  if (!fx.credential || !(await repos.credentials.get(tenantId, fx.credential))) {
    fx.credential = (await credentialIn(server, tenantId, fx.team, { name: `Matrix ${seq}` })).id;
  }
  if (!fx.dataTable || !(await repos.dataTables.get(tenantId, fx.dataTable))) {
    fx.dataTable = (await dataTableIn(server, tenantId, fx.team, `matrix_${seq}`)).id;
    fx.column = (
      await repos.dataTables.addColumn(tenantId, fx.dataTable, { name: 'name', type: 'string', position: 0 })
    ).id;
  }
  if (!fx.folder || !(await repos.folders.get(tenantId, fx.folder))) {
    fx.folder = (await folderIn(server, tenantId, fx.team, `Matrix ${seq}`)).id;
  }
  if (!fx.execution || !(await repos.executions.get(tenantId, fx.execution))) {
    const now = new Date();
    fx.execution = (
      await repos.executions.create(
        tenantId,
        {
          id: randomUUID(),
          workflowId: fx.workflow,
          workflowName: 'Matrix',
          mode: 'manual',
          status: 'success',
          startedAt: now,
          stoppedAt: now,
        },
        { workflowData: {}, runOptions: { projectId: fx.team } },
      )
    ).id;
  }
  if (!fx.variable || !(await repos.variables.get(tenantId, fx.variable))) {
    fx.variable = (await repos.variables.create(tenantId, { key: `MATRIX_${seq}`, value: 'v' })).id;
  }
  if (!fx.tag || !(await repos.tags.get(tenantId, fx.tag))) {
    fx.tag = (await repos.tags.create(tenantId, `matrix-${seq}`)).id;
  }
  if (
    !fx.annotationTag ||
    (await repos.annotations.existingTags(tenantId, [fx.annotationTag])).length === 0
  ) {
    fx.annotationTag = (await repos.annotations.createTag(tenantId, `matrix-${seq}`)).id;
  }
  if (!fx.member || !(await repos.memberships.get(tenantId, fx.member))) {
    fx.member = (await memberAs(owner, 'viewer', { name: `Matrix member ${seq}` })).user.id;
  }
  if (!fx.review || !(await repos.reviews.get(tenantId, fx.review))) {
    fx.review = (
      await repos.reviews.create(tenantId, {
        workflowId: fx.workflow,
        workflowVersionId: fx.versionId,
        title: `Matrix ${seq}`,
        description: null,
        createdBy: callers.editor.userId,
        reviewerUserIds: [callers.admin.userId],
      })
    ).id;
  }
  if (!fx.testRun || !(await repos.testRuns.get(tenantId, fx.workflow, fx.testRun))) {
    fx.testRun = (await repos.testRuns.create(tenantId, { workflowId: fx.workflow })).id;
  }
  if (!fx.thread || !(await repos.assistantThreads.get(tenantId, owner.userId, fx.thread))) {
    fx.thread = (await repos.assistantThreads.create(tenantId, owner.userId, { title: 'Matrix' })).id;
  }
}

const FAKE = '00000000-0000-4000-8000-00000000c0e5';

/** the value of `:id` for a row's target */
function idFor(row: RouteMatrixRow, f: Fixtures): string {
  switch (row.target) {
    case 'workflow':
      return f.workflow;
    case 'credential':
      return f.credential;
    case 'dataTable':
      return f.dataTable;
    case 'folder':
      return f.folder;
    case 'execution':
      return f.execution;
    case 'variable':
      return f.variable;
    case 'tag':
      return fx.tag;
    case 'annotationTag':
      return fx.annotationTag;
    case 'review':
      return fx.review;
    case 'testRun':
      return fx.testRun;
    case 'project':
      return f.project;
    case 'member':
      return fx.member;
    default:
      return FAKE;
  }
}

/** fills the path params with the fixture rows (by `target` for `:id`, by name for the others) */
function urlOf(row: RouteMatrixRow, f: Fixtures = fx): string {
  const named: Record<string, string> = {
    id: idFor(row, f),
    workflowId: f.workflow,
    versionId: f.versionId,
    dataTableId: f.dataTable,
    columnId: f.column,
    folderId: f.folder,
    executionId: f.execution,
    projectId: f.project,
    userId: fx.member,
    runId: fx.testRun,
    caseId: FAKE,
    threadId: fx.thread,
    draftId: FAKE,
    requestId: FAKE,
    clientId: 'matrix-client',
    slug: 'project:viewer',
    providerKey: 'matrix-vault',
    type: 'matrix-type',
    token: 'c0e5'.repeat(8),
    tenantSlug,
    resourceType: 'workflow',
    resourceId: fx.workflow,
  };
  return row.path
    .replace(/:(\w+)/g, (_match, name: string) => {
      const value = named[name];
      if (value === undefined) throw new Error(`no fixture for :${name} in ${row.path}`);
      return value;
    })
    .replace(/\*$/, 'matrix');
}

/** one call of `row` as `role` (or another caller); returns the status */
async function call(
  row: RouteMatrixRow,
  role: MatrixRole,
  caller: Caller = callers[role],
  url = urlOf(row),
): Promise<number> {
  const method = row.method === 'ALL' ? 'GET' : row.method;
  const headers: Record<string, string> = {};
  if (row.path.startsWith('/api/v1/')) headers['x-api-key'] = caller.key;
  else if (caller.client.cookie) headers.cookie = caller.client.cookie;
  const withBody = method !== 'GET' && method !== 'OPTIONS';
  if (withBody || method === 'OPTIONS') headers.origin = ORIGIN;
  if (withBody) headers['content-type'] = 'application/json';
  const payload = withBody ? '{}' : undefined;
  if (row.stream) {
    // an open stream never ends for `inject`: read the status through the listener, then abort
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    try {
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers: { ...headers, 'x-forwarded-for': caller.address ?? ADDRESS[role] },
        body: payload,
        redirect: 'manual',
        signal: abort.signal,
      });
      const status = res.status;
      abort.abort();
      await res.body?.cancel().catch(() => undefined);
      return status;
    } finally {
      clearTimeout(timer);
    }
  }
  const res = await server.app.inject({
    method: method as 'GET',
    url,
    headers: { ...headers, host: new URL(baseUrl).host },
    payload,
    remoteAddress: caller.address ?? ADDRESS[role],
  });
  return res.statusCode;
}

/** where the route checks the row's scope (null: the global scopes) */
async function checkTarget(row: RouteMatrixRow, userId: string): Promise<AccessTarget | null> {
  if (row.check === 'global') return null;
  if (row.check === 'personal') {
    return {
      projectId: (await server.ctx.repos.projects.ensurePersonal(tenantId, { id: userId, name: 'Personal' }))
        .id,
    };
  }
  switch (row.target) {
    case 'workflow':
    case 'review':
    case 'testRun':
      return { workflowId: fx.workflow };
    case 'credential':
      return { credentialId: fx.credential };
    case 'dataTable':
      return { dataTableId: fx.dataTable };
    case 'folder':
      return { folderId: fx.folder };
    case 'execution':
      return { executionId: fx.execution };
    case 'variable':
      return { variableId: fx.variable };
    case 'project':
      return { projectId: fx.project };
    default:
      return null;
  }
}

/** the scopes a user holds where `row` is checked */
async function expectedScopes(row: RouteMatrixRow, userId: string): Promise<ReadonlySet<Scope>> {
  const target = await checkTarget(row, userId);
  if (target) return server.ctx.access.scopesFor(tenantId, userId, target);
  const membership = await server.ctx.repos.memberships.get(tenantId, userId);
  return membership ? server.ctx.access.globalScopes(tenantId, membership.role) : new Set<Scope>();
}

/** whether the user may call `row` (scopes only) */
async function allowed(row: RouteMatrixRow, userId: string): Promise<boolean> {
  if (row.scope === null) {
    if (row.access) return true;
    return (await server.ctx.repos.memberships.get(tenantId, userId))?.role === 'owner';
  }
  return (await expectedScopes(row, userId)).has(row.scope);
}

/** the project a row's target lives in (null: a workspace-wide row) */
function projectOfTarget(row: RouteMatrixRow): string | null {
  if (row.check) return null;
  if (row.target === 'project') return fx.project;
  return ['workflow', 'review', 'testRun', 'credential', 'dataTable', 'folder', 'execution'].includes(
    row.target,
  )
    ? fx.team
    : null;
}

const customCache = new Map<string, Caller>();
let customSeq = 0;
let lonely: Caller | undefined;

/** a signed-in member of the workspace whose workspace role is `role`, made through the repositories */
async function directMember(role: string): Promise<Caller> {
  customSeq++;
  const address = `10.92.${customSeq >> 8}.${customSeq & 255}`;
  const email = `matrix-${customSeq}-${randomUUID().slice(0, 8)}@example.com`;
  const user = await server.ctx.repos.users.create({
    email,
    name: `Matrix ${customSeq}`,
    passwordHash: 'unused',
  });
  await server.ctx.repos.memberships.add(tenantId, user.id, role);
  await server.ctx.repos.projects.ensurePersonal(tenantId, user);
  const client = new TestClient(server.app, ORIGIN, address);
  client.cookie = `wf_session=${await server.ctx.auth.createSession(user.id, tenantId, { ip: address })}`;
  const { key } = await server.ctx.auth.createApiKey(tenantId, user.id, 'matrix');
  return { client, userId: user.id, email, key, address };
}

/**
 * A `member` whose only grant is a custom role holding `scopes`: a project role on `projectId`, or its
 * workspace role (a custom global role) when the row is workspace wide. Made once per scope list and project.
 */
async function customCaller(scopes: Scope[], projectId: string | null): Promise<Caller> {
  const cacheKey = `${projectId ?? 'global'}:${scopes.join(',')}`;
  const hit = customCache.get(cacheKey);
  if (hit) return hit;
  const owner = callers.owner;
  const roleType = projectId ? 'project' : 'global';
  const role = await owner.client.data<{ slug: string }>(
    owner.client.post('/rest/roles', {
      displayName: `Matrix ${roleType} ${customCache.size + 1} ${randomUUID().slice(0, 6)}`,
      roleType,
      scopes,
    }),
  );
  const caller = await directMember(projectId ? 'member' : role.slug);
  if (projectId) await addToProject(server, tenantId, projectId, caller.userId, role.slug);
  customCache.set(cacheKey, caller);
  return caller;
}

/**
 * True mode for custom roles (plan-S1 L24): a member holding exactly the row's scope passes, one holding a
 * scope of another resource gets 403 unless the model gives it the row anyway (every member's global
 * scopes), a member with no relation to the row's project gets the same (the hidden row), and another
 * workspace's id is 404. A create into the personal project is open to every member, so it has no such case.
 */
async function customChecks(row: RouteMatrixRow, scope: Scope): Promise<string[]> {
  const wrong: string[] = [];
  if (row.check === 'personal') return wrong;
  // read when used: a write the check allowed may have made the row's project again
  const projectId = () => projectOfTarget(row);
  const grantable = customRoleAllowedScopes(projectId() ? 'project' : 'global');
  const verify = async (label: string, caller: Caller, mustAllow = false) => {
    const may = await allowed(row, caller.userId);
    if (mustAllow && !may) {
      wrong.push(`${label}: the scope alone does not reach the row`);
      return;
    }
    const status = await call(row, 'viewer', caller);
    if (may && status === 403) wrong.push(`${label}: 403, expected allowed`);
    if (may && status === 401) wrong.push(`${label}: 401, expected signed in`);
    if (!may && status !== 403) wrong.push(`${label}: ${status}, expected 403`);
    if (status >= 200 && status < 300 && row.method !== 'GET' && row.method !== 'OPTIONS')
      await ensureFixtures();
  };
  const exact = row.exactScopes ?? [scope];
  if (exact.every((s) => grantable.has(s)))
    await verify('exact', await customCaller(exact, projectId()), true);
  const resource = scope.split(':')[0];
  const other = [...grantable].sort().find((s) => s.split(':')[0] !== resource);
  if (other) await verify('without', await customCaller([other], projectId()));
  if (projectId()) {
    lonely ??= await directMember('member');
    await verify('hidden', lonely);
  }
  // a row the route loads from its path: `:id` of the target, or a named id
  const fromPath = /:(id|workflowId|dataTableId|folderId|executionId|projectId)(\/|$)/.test(row.path);
  if (FOREIGN_TARGETS.has(row.target) && fromPath) {
    const status = await call(row, 'owner', callers.owner, urlOf(row, { ...fx, ...foreign }));
    if (status !== 404) wrong.push(`another workspace's id: ${status}, expected 404`);
  }
  return wrong;
}

/** signs a role back in after a row ended its session (POST /rest/auth/logout) */
async function signIn(role: MatrixRole): Promise<void> {
  const { client, email } = callers[role];
  await client.data(client.post('/rest/auth/login', { email, password: 'Passw0rd!' }));
  if (role !== 'owner') {
    await client.data(client.post('/rest/auth/switch-tenant', { tenantId }));
  }
}

beforeAll(async () => {
  // MCP routes answer 403 to a Host other than MCP_BASE_URL's: the listener's address is that host
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = await createTestServer({ AI_ENABLED: 'true', MCP_ACCESS_ENABLED: 'true', MCP_BASE_URL: baseUrl });
  await server.app.listen({ port, host: '127.0.0.1' });
  const owner = await signup(server.app, { remoteAddress: ADDRESS.owner });
  tenantId = owner.tenant.id;
  tenantSlug = owner.tenant.slug;
  // the Assistant's MCP connections answer 404 while the workspace has MCP access off
  const tenant = await server.ctx.repos.tenants.get(tenantId);
  const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
  await server.ctx.repos.tenants.updateSettings(tenantId, {
    ...settings,
    assistant: { ...((settings.assistant as object | undefined) ?? {}), mcpAccessEnabled: true },
  });
  const key = async (client: TestClient) =>
    (await client.data<{ key: string }>(client.post('/rest/api-keys', { name: 'matrix' }))).key;
  callers.owner = {
    client: owner.client,
    userId: owner.user.id,
    email: owner.user.email,
    key: await key(owner.client),
  };
  for (const role of ['admin', 'editor', 'viewer'] as const) {
    const member = await memberAs(owner, role, { remoteAddress: ADDRESS[role] });
    callers[role] = {
      client: member.client,
      userId: member.user.id,
      email: member.email,
      key: await key(member.client),
    };
  }
  await ensureFixtures();

  // another workspace's rows (the 404 of a foreign id)
  const stranger = await signup(server.app, { remoteAddress: '10.93.0.1' });
  const strangerTeam = await teamProjectOf(server, stranger.tenant.id);
  const workflow = await workflowIn(server, stranger.tenant.id, strangerTeam, { name: 'Foreign' });
  await server.ctx.repos.versions.create(stranger.tenant.id, {
    id: workflow.versionId,
    workflowId: workflow.id,
    name: workflow.name,
    nodes: [],
    connections: {},
    settings: {},
    authorId: stranger.user.id,
  });
  const table = await dataTableIn(server, stranger.tenant.id, strangerTeam, 'foreign');
  const now = new Date();
  Object.assign(foreign, {
    workflow: workflow.id,
    versionId: workflow.versionId,
    credential: (await credentialIn(server, stranger.tenant.id, strangerTeam, { name: 'Foreign' })).id,
    dataTable: table.id,
    column: (
      await server.ctx.repos.dataTables.addColumn(stranger.tenant.id, table.id, {
        name: 'name',
        type: 'string',
        position: 0,
      })
    ).id,
    folder: (await folderIn(server, stranger.tenant.id, strangerTeam, 'Foreign')).id,
    execution: (
      await server.ctx.repos.executions.create(
        stranger.tenant.id,
        {
          id: randomUUID(),
          workflowId: workflow.id,
          workflowName: 'Foreign',
          mode: 'manual',
          status: 'success',
          startedAt: now,
          stoppedAt: now,
        },
        { workflowData: {}, runOptions: { projectId: strangerTeam } },
      )
    ).id,
    variable: (await server.ctx.repos.variables.create(stranger.tenant.id, { key: 'FOREIGN', value: 'v' }))
      .id,
    project: strangerTeam,
  } satisfies ForeignFixtures);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

const files = [...new Set(ROUTE_MATRIX_ROWS.map((row) => row.file))].sort();

for (const file of files) {
  describe(`route file ${file}`, () => {
    for (const row of ROUTE_MATRIX_ROWS.filter((r) => r.file === file)) {
      it(`${row.method} ${row.path}`, async () => {
        const wrong: string[] = [];
        for (const role of ROLES) {
          // read before the call: a write may remove the row
          const may = await allowed(row, callers[role].userId);
          const status = await call(row, role);
          if (may && status === 403) wrong.push(`${role}: 403, expected allowed`);
          if (may && status === 401 && row.access !== 'public')
            wrong.push(`${role}: 401, expected signed in`);
          if (!may && status !== 403) wrong.push(`${role}: ${status}, expected 403`);
          if (row.method === 'POST' && row.path === '/rest/auth/logout') await signIn(role);
          if (status >= 200 && status < 300 && row.method !== 'GET' && row.method !== 'OPTIONS') {
            await ensureFixtures();
          }
        }
        if (row.scope !== null) wrong.push(...(await customChecks(row, row.scope)));
        expect(wrong).toEqual([]);
      });
    }
  });
}

describe('route matrix', () => {
  it('route matrix completeness', () => {
    const gets = new Set(captured.filter((route) => route.method === 'GET').map((route) => route.url));
    const routes = captured
      .map((route) => ({
        url: route.url,
        methods: (Array.isArray(route.method) ? route.method : [route.method]).map((m) => m.toUpperCase()),
      }))
      // HEAD routes Fastify adds for every GET
      .filter((route) => !(route.methods.length === 1 && route.methods[0] === 'HEAD' && gets.has(route.url)));
    expect(routes.length).toBeGreaterThan(100);
    const matches = (row: RouteMatrixRow, route: { url: string; methods: string[] }) =>
      row.path === route.url &&
      (row.method === 'ALL'
        ? [...route.methods].sort().join(',') === FULL_METHODS
        : route.methods.includes(row.method));
    const missingRows = routes
      .filter((route) => !ROUTE_MATRIX_ROWS.some((row) => matches(row, route)))
      .map((route) => `${route.methods.join(',')} ${route.url}`);
    const missingRoutes = ROUTE_MATRIX_ROWS.filter((row) => !routes.some((route) => matches(row, route))).map(
      (row) => `${row.method} ${row.path} (${row.file})`,
    );
    const keys = ROUTE_MATRIX_ROWS.map((row) => `${row.method} ${row.path}`);
    const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect({ missingRows, missingRoutes, duplicates }).toEqual({
      missingRows: [],
      missingRoutes: [],
      duplicates: [],
    });
  });
});
