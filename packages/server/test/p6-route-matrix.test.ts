/**
 * P6 S1 (C0e): the route matrix. Every route of the server has a row in p6-route-matrix.rows.ts; for each
 * row the four roles owner, admin, editor and viewer call it on a real row of the owner's workspace.
 * Allowed means anything but 403 (a signed-in route also never 401), refused means 403. A 2xx on a write
 * rebuilds the rows it may have removed, so the next role meets a real row again.
 *
 * MODE 'legacy' (commit 0 until L24): a row's `legacyMin` is today's `requireRole` rule and wins; rows
 * without it follow the scope through the workspace's role scopes (`AccessService.globalScopes`: owner and
 * admin their global scopes, editor and viewer the legacy role map). So the matrix passes at commit 0 and
 * keeps passing while lanes convert routes to `requireScope`. L24 sets MODE to 'true' (scopes only).
 *
 * `route matrix completeness` captures every route Fastify registers (an `onRoute` hook on each instance)
 * and fails when a route has no row or a row has no route. M(f) = `-t "route file <f>"`.
 */
import { randomUUID } from 'node:crypto';
import type { Scope } from '@workflow/workflow';
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

import type { Role } from '../src/db/schema';
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
  type TestClient,
  type TestServer,
  teamProjectOf,
  workflowIn,
} from './helpers';
import { ROUTE_MATRIX_ROWS, type RouteMatrixRow } from './p6-route-matrix.rows';

/** 'legacy' until L24 (`legacyMin` pins today's rule); L24 sets 'true' */
const MODE = 'legacy' as 'legacy' | 'true';
const ROLES = ['viewer', 'editor', 'admin', 'owner'] as const;
type MatrixRole = (typeof ROLES)[number];
const RANK: Record<Role, number> = { member: 0, viewer: 1, editor: 2, admin: 3, owner: 4 };
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
const scopeCache = new Map<MatrixRole, ReadonlySet<Scope>>();
let seq = 0;

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
function idFor(row: RouteMatrixRow): string {
  switch (row.target) {
    case 'workflow':
      return fx.workflow;
    case 'credential':
      return fx.credential;
    case 'dataTable':
      return fx.dataTable;
    case 'folder':
      return fx.folder;
    case 'execution':
      return fx.execution;
    case 'variable':
      return fx.variable;
    case 'tag':
      return fx.tag;
    case 'annotationTag':
      return fx.annotationTag;
    case 'review':
      return fx.review;
    case 'testRun':
      return fx.testRun;
    case 'project':
      return fx.project;
    case 'member':
      return fx.member;
    default:
      return FAKE;
  }
}

/** fills the path params with the fixture rows (by `target` for `:id`, by name for the others) */
function urlOf(row: RouteMatrixRow): string {
  const named: Record<string, string> = {
    id: idFor(row),
    workflowId: fx.workflow,
    versionId: fx.versionId,
    dataTableId: fx.dataTable,
    columnId: fx.column,
    folderId: fx.folder,
    executionId: fx.execution,
    projectId: fx.project,
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

/** one call of `row` as `role`; returns the status */
async function call(row: RouteMatrixRow, role: MatrixRole): Promise<number> {
  const caller = callers[role];
  const method = row.method === 'ALL' ? 'GET' : row.method;
  const url = urlOf(row);
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
        headers: { ...headers, 'x-forwarded-for': ADDRESS[role] },
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
    remoteAddress: ADDRESS[role],
  });
  return res.statusCode;
}

async function scopesOf(role: MatrixRole): Promise<ReadonlySet<Scope>> {
  let scopes = scopeCache.get(role);
  if (!scopes) {
    scopes = await server.ctx.access.globalScopes(tenantId, role);
    scopeCache.set(role, scopes);
  }
  return scopes;
}

/** whether `role` may call `row` in this MODE */
async function allowed(row: RouteMatrixRow, role: MatrixRole): Promise<boolean> {
  if (MODE === 'legacy' && row.legacyMin) return RANK[role] >= RANK[row.legacyMin];
  if (row.scope === null) return row.access ? true : RANK[role] >= RANK[row.legacyMin ?? 'owner'];
  return (await scopesOf(role)).has(row.scope);
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
          const status = await call(row, role);
          const may = await allowed(row, role);
          if (may && status === 403) wrong.push(`${role}: 403, expected allowed`);
          if (may && status === 401 && row.access !== 'public')
            wrong.push(`${role}: 401, expected signed in`);
          if (!may && status !== 403) wrong.push(`${role}: ${status}, expected 403`);
          if (row.method === 'POST' && row.path === '/rest/auth/logout') await signIn(role);
          if (status >= 200 && status < 300 && row.method !== 'GET' && row.method !== 'OPTIONS') {
            await ensureFixtures();
          }
        }
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
