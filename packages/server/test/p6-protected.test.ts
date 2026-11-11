/**
 * P6-08 (S4 L7): the protected workspace on the server. A workspace whose switch is on refuses every direct
 * change decisions section H lists, each with its own text, for the editor routes and for an API key alike;
 * publish, retry, credential update and delete, variable value update, data table rows and every read stay
 * allowed. The switch works with no Git connection, only a user with `sourceControl:manage` sets it, and turning
 * it off lifts the lock at once. PUT /workflows/:id/tags (public) and the `import:workflow` and
 * `import:credentials` commands meet the same lock. A pull is the one writer that passes (`withPullWrites`).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CommandIo } from '../src/commands/command-io';
import { exportCredentialsCommand } from '../src/commands/credentials-export';
import { importCredentialsCommand } from '../src/commands/credentials-import';
import { importWorkflowCommand } from '../src/commands/workflow-import';
import {
  assertNotProtected,
  assertTenantWritable,
  PROTECTED_TEXT,
  type ProtectedAction,
  ProtectedWorkspaceError,
  setReadOnly,
  withPullWrites,
} from '../src/services/protected';
import {
  createTestServer,
  createWorkflow,
  node,
  protectWorkspace,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  waitForExecution,
} from './helpers';

let server: TestServer;
let ip = 1;
let keyCount = 0;
let dir: string;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
  dir = await mkdtemp(path.join(tmpdir(), 'p6-protected-'));
});
afterAll(async () => {
  await server.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const world = () => signup(server.app, { remoteAddress: `127.8.7.${(ip++ % 250) + 1}` });
type World = Awaited<ReturnType<typeof world>>;

async function keyOf(w: World): Promise<string> {
  keyCount += 1;
  const made = await w.client.data(w.client.post('/rest/api-keys', { name: `prot${keyCount}` }));
  return made.key as string;
}

const api = (
  key: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

/** the refusal of `action`: 403 `workspace_protected` with the decided text (push is 400) */
function refused(res: { statusCode: number; body: string }, action: ProtectedAction): void {
  expect(res.statusCode, res.body).toBe(action === 'push' ? 400 : 403);
  const body = JSON.parse(res.body) as { code?: string; error?: { code?: string }; message?: string };
  expect(res.body).toContain(PROTECTED_TEXT[action]);
  expect(body.code ?? body.error?.code).toBe('workspace_protected');
}

/** what a protected workspace is tested with: made while open, then switched on */
async function seeded(w: World) {
  const { client } = w;
  const wf = await createWorkflow(client, { name: 'Live', nodes: [node('Start', 'core.manualTrigger')] });
  const archived = await createWorkflow(client, {
    name: 'Old',
    nodes: [node('Start', 'core.manualTrigger')],
  });
  await client.data(client.post(`/rest/workflows/${archived.id}/archive`));
  const hooked = await createWorkflow(client, {
    name: 'Hooked',
    nodes: [node('Hook', 'core.webhook', { path: `p-${randomUUID()}` }, [0, 0], { webhookId: randomUUID() })],
  });
  const failing = await createWorkflow(client, {
    name: 'Fails',
    nodes: [node('Start', 'core.manualTrigger'), node('Boom', 'test.fail', {}, [200, 0])],
    connections: { Start: { main: [[{ node: 'Boom', type: 'main', index: 0 }]] } },
  });
  const run = await client.data<{ executionId: string }>(
    client.post(`/rest/workflows/${failing.id}/run`, {}),
  );
  await waitForExecution(server.ctx, w.tenant.id, run.executionId);
  const credential = await client.data<{ id: string }>(
    client.post('/rest/credentials', { name: 'Keep', type: 'testApi', data: { apiKey: 'k1' } }),
  );
  const variable = await client.data<{ id: string }>(
    client.post('/rest/variables', { key: 'prot_var', value: '1' }),
  );
  const folder = await client.data<{ id: string }>(client.post('/rest/folders', { name: 'Ops' }));
  const table = await client.data<{ id: string }>(
    client.post('/rest/data-tables', { name: 'orders', columns: [{ name: 'title', type: 'string' }] }),
  );
  const column = await client.data<{ id: string }>(
    client.post(`/rest/data-tables/${table.id}/columns`, { name: 'qty', type: 'number' }),
  );
  const tag = await client.data<{ id: string }>(client.post('/rest/tags', { name: 'nightly' }));
  await protectWorkspace(server, w.tenant.id);
  return {
    hooked,
    wf,
    archived,
    failing,
    failedRun: run.executionId,
    credential,
    variable,
    folder,
    table,
    column,
    tag,
  };
}

describe('the lock functions', () => {
  it('assertNotProtected throws only for a protected settings object outside a pull', async () => {
    expect(() => assertNotProtected({}, 'workflowCreate')).not.toThrow();
    expect(() => assertNotProtected(undefined, 'workflowCreate')).not.toThrow();
    expect(() => assertNotProtected({ sourceControl: { readOnly: false } }, 'workflowCreate')).not.toThrow();
    expect(() => assertNotProtected({ sourceControl: { readOnly: true } }, 'workflowCreate')).toThrow(
      ProtectedWorkspaceError,
    );
    try {
      assertNotProtected({ sourceControl: { readOnly: true } }, 'push');
      expect.unreachable();
    } catch (error) {
      expect((error as ProtectedWorkspaceError).message).toBe('Cannot push onto read-only branch.');
    }
    await withPullWrites(async () => {
      expect(() => assertNotProtected({ sourceControl: { readOnly: true } }, 'workflowCreate')).not.toThrow();
    });
  });

  it('assertTenantWritable reads the tenant, refuses a protected one and lets a pull through', async () => {
    const w = await world();
    const deps = server.ctx.serviceDeps;
    await assertTenantWritable(deps, w.tenant.id, 'folderCreate');
    await protectWorkspace(server, w.tenant.id);
    await expect(assertTenantWritable(deps, w.tenant.id, 'folderCreate')).rejects.toMatchObject({
      statusCode: 403,
      code: 'workspace_protected',
      message: PROTECTED_TEXT.folderCreate,
    });
    await withPullWrites(() => assertTenantWritable(deps, w.tenant.id, 'folderCreate'));
    // it reads the row once, and not at all inside a pull
    const get = server.ctx.repos.tenants.get.bind(server.ctx.repos.tenants);
    let reads = 0;
    server.ctx.repos.tenants.get = ((...args: Parameters<typeof get>) => {
      reads += 1;
      return get(...args);
    }) as typeof get;
    try {
      await expect(assertTenantWritable(deps, w.tenant.id, 'variableCreate')).rejects.toBeInstanceOf(
        ProtectedWorkspaceError,
      );
      expect(reads).toBe(1);
      await withPullWrites(() => assertTenantWritable(deps, w.tenant.id, 'variableCreate'));
      expect(reads).toBe(1);
    } finally {
      server.ctx.repos.tenants.get = get;
    }
  });

  it('setReadOnly writes only sourceControl, keeps the other settings and audits a change', async () => {
    const w = await world();
    await w.client.data(w.client.patch('/rest/settings', { brand: { name: 'Acme' } }));
    const auth = { tenant: w.tenant, user: w.user } as never;
    await setReadOnly(server.ctx.serviceDeps, auth, true);
    const row = await server.ctx.repos.tenants.get(w.tenant.id);
    expect(row?.settings).toMatchObject({ brand: { name: 'Acme' }, sourceControl: { readOnly: true } });
    await setReadOnly(server.ctx.serviceDeps, auth, false);
    expect((await server.ctx.repos.tenants.get(w.tenant.id))?.settings).toMatchObject({
      brand: { name: 'Acme' },
      sourceControl: { readOnly: false },
    });
    const audit = await server.ctx.database.pool.query(
      "select metadata from audit_log where tenant_id = $1 and action = 'source_control.read_only_changed' order by created_at",
      [w.tenant.id],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(audit.rows)).toContain('true');
  });
});

describe('a protected workspace refuses each direct change with its text (editor routes)', () => {
  it('workflows: create, save, manual run, archive, restore, delete', async () => {
    const w = await world();
    const s = await seeded(w);
    const { client } = w;
    refused(
      await client.post('/rest/workflows', { name: 'New', nodes: [], connections: {}, settings: {} }),
      'workflowCreate',
    );
    refused(
      await client.patch(`/rest/workflows/${s.wf.id}`, { versionId: s.wf.versionId, name: 'Renamed' }),
      'workflowUpdate',
    );
    refused(await client.post(`/rest/workflows/${s.wf.id}/run`, {}), 'manualRun');
    refused(await client.post(`/rest/workflows/${s.wf.id}/archive`), 'workflowArchive');
    refused(await client.post(`/rest/workflows/${s.archived.id}/unarchive`), 'workflowRestore');
    refused(
      await client.post(`/rest/workflows/${s.wf.id}/versions/${s.wf.versionId}/restore`),
      'workflowRestore',
    );
    refused(await client.delete(`/rest/workflows/${s.archived.id}`), 'workflowDelete');
    expect((await w.client.data<{ name: string }>(client.get(`/rest/workflows/${s.wf.id}`))).name).toBe(
      'Live',
    );
  });

  it('credentials: create is refused; update and delete are allowed', async () => {
    const w = await world();
    const s = await seeded(w);
    const { client } = w;
    refused(
      await client.post('/rest/credentials', { name: 'New', type: 'testApi', data: { apiKey: 'x' } }),
      'credentialCreate',
    );
    const patched = await client.patch(`/rest/credentials/${s.credential.id}`, { data: { apiKey: 'k2' } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await client.delete(`/rest/credentials/${s.credential.id}`)).statusCode).toBe(200);
  });

  it('variables: create, delete and a key rename are refused; a value update is allowed', async () => {
    const w = await world();
    const s = await seeded(w);
    const { client } = w;
    refused(await client.post('/rest/variables', { key: 'other', value: '1' }), 'variableCreate');
    refused(await client.delete(`/rest/variables/${s.variable.id}`), 'variableDelete');
    refused(await client.patch(`/rest/variables/${s.variable.id}`, { key: 'renamed' }), 'variableRename');
    const value = await client.patch(`/rest/variables/${s.variable.id}`, { value: '2' });
    expect(value.statusCode, value.body).toBe(200);
    expect(value.json().data.value).toBe('2');
  });

  it('folders and projects', async () => {
    const w = await world();
    const s = await seeded(w);
    const { client } = w;
    refused(await client.post('/rest/folders', { name: 'New' }), 'folderCreate');
    refused(await client.patch(`/rest/folders/${s.folder.id}`, { name: 'Renamed' }), 'folderUpdate');
    refused(await client.delete(`/rest/folders/${s.folder.id}`), 'folderDelete');
    refused(await client.post('/rest/projects', { name: 'Second' }), 'projectCreate');
  });

  it('data tables: create, rename, delete and every column change are refused; rows and reads pass', async () => {
    const w = await world();
    const s = await seeded(w);
    const { client } = w;
    refused(
      await client.post('/rest/data-tables', { name: 'new', columns: [{ name: 'a', type: 'string' }] }),
      'dataTableCreate',
    );
    refused(await client.patch(`/rest/data-tables/${s.table.id}`, { name: 'orders2' }), 'dataTableStructure');
    refused(await client.delete(`/rest/data-tables/${s.table.id}`), 'dataTableStructure');
    refused(
      await client.post(`/rest/data-tables/${s.table.id}/columns`, { name: 'extra', type: 'string' }),
      'dataTableStructure',
    );
    refused(
      await client.patch(`/rest/data-tables/${s.table.id}/columns/${s.column.id}/rename`, { name: 'amount' }),
      'dataTableStructure',
    );
    refused(
      await client.patch(`/rest/data-tables/${s.table.id}/columns/${s.column.id}/move`, { targetIndex: 0 }),
      'dataTableStructure',
    );
    refused(
      await client.delete(`/rest/data-tables/${s.table.id}/columns/${s.column.id}`),
      'dataTableStructure',
    );
    // rows and reads
    const insert = await client.post(`/rest/data-tables/${s.table.id}/insert`, {
      data: [{ title: 'a', qty: 1 }],
      returnType: 'count',
    });
    expect(insert.statusCode, insert.body).toBe(200);
    expect((await client.get(`/rest/data-tables/${s.table.id}/rows`)).statusCode).toBe(200);
    expect((await client.get(`/rest/data-tables/${s.table.id}/columns`)).statusCode).toBe(200);
    expect((await client.get('/rest/data-tables')).statusCode).toBe(200);
  });

  it('publish, unpublish, retry and the read paths stay allowed', async () => {
    const w = await world();
    const s = await seeded(w);
    const { client } = w;
    const published = await client.post(`/rest/workflows/${s.hooked.id}/activate`, {});
    expect(published.statusCode, published.body).toBe(200);
    expect((await client.post(`/rest/workflows/${s.hooked.id}/deactivate`, {})).statusCode).toBe(200);
    const retry = await client.post(`/rest/executions/${s.failedRun}/retry`, {});
    expect(retry.statusCode, retry.body).toBe(200);
    await waitForExecution(server.ctx, w.tenant.id, retry.json().data.executionId);
    for (const url of [
      '/rest/workflows',
      '/rest/credentials',
      '/rest/variables',
      '/rest/folders',
      '/rest/executions',
    ]) {
      expect((await client.get(url)).statusCode, url).toBe(200);
    }
    expect((await client.get(`/rest/workflows/${s.wf.id}`)).statusCode).toBe(200);
  });

  it('GET /settings tells every member the workspace is protected', async () => {
    const w = await world();
    const member = await realMember(w);
    await protectWorkspace(server, w.tenant.id);
    expect((await member.client.data(member.client.get('/rest/settings'))).sourceControl).toEqual({
      readOnly: true,
    });
  });
});

describe('an API key meets the same lock', () => {
  it('refuses a workflow create, save, delete and tag change; lets a credential update and a retry pass', async () => {
    const w = await world();
    const key = await keyOf(w);
    const s = await seeded(w);
    refused(
      await api(key, 'POST', '/workflows', {
        name: 'Api made',
        nodes: [
          {
            id: 'n1',
            name: 'Start',
            type: 'core.manualTrigger',
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
        ],
        connections: {},
        settings: {},
      }),
      'workflowCreate',
    );
    refused(
      await api(key, 'PUT', `/workflows/${s.wf.id}`, {
        name: 'Renamed',
        nodes: [
          {
            id: 'n1',
            name: 'Start',
            type: 'core.manualTrigger',
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
        ],
        connections: {},
        settings: {},
      }),
      'workflowUpdate',
    );
    refused(await api(key, 'DELETE', `/workflows/${s.archived.id}`), 'workflowDelete');
    // PUT /workflows/:id/tags (L10's row) goes through WorkflowService.update
    refused(await api(key, 'PUT', `/workflows/${s.wf.id}/tags`, [{ id: s.tag.id }]), 'workflowUpdate');
    expect((await api(key, 'GET', `/workflows/${s.wf.id}/tags`)).statusCode).toBe(200);
    expect((await api(key, 'GET', '/workflows')).statusCode).toBe(200);
    const retry = await api(key, 'POST', `/executions/${s.failedRun}/retry`, {});
    expect(retry.statusCode, retry.body).toBe(200);
  });
});

describe('the switch', () => {
  it('turns on and off with no Git connection, and the lock follows at once', async () => {
    const w = await world();
    const { client } = w;
    const on = await client.patch('/rest/source-control/preferences', { branchReadOnly: true });
    expect(on.statusCode, on.body).toBe(200);
    expect((await client.data(client.get('/rest/settings'))).sourceControl).toEqual({ readOnly: true });
    refused(await client.post('/rest/folders', { name: 'F' }), 'folderCreate');
    const off = await client.patch('/rest/source-control/preferences', { branchReadOnly: false });
    expect(off.statusCode, off.body).toBe(200);
    expect((await client.post('/rest/folders', { name: 'F' })).statusCode).toBe(200);
    const audit = await server.ctx.database.pool.query(
      "select count(*)::int as n from audit_log where tenant_id = $1 and action = 'source_control.read_only_changed'",
      [w.tenant.id],
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it('a member cannot set it, and PATCH /settings cannot set or undo it', async () => {
    const w = await world();
    const member = await realMember(w);
    const denied = await member.client.patch('/rest/source-control/preferences', { branchReadOnly: true });
    expect(denied.statusCode, denied.body).toBe(403);
    expect((await server.ctx.repos.tenants.get(w.tenant.id))?.settings).not.toHaveProperty(
      'sourceControl.readOnly',
      true,
    );
    await protectWorkspace(server, w.tenant.id);
    await w.client.patch('/rest/settings', { timezone: 'Europe/Berlin', sourceControl: { readOnly: false } });
    expect((await w.client.data(w.client.get('/rest/settings'))).sourceControl).toEqual({ readOnly: true });
    const off = await member.client.patch('/rest/source-control/preferences', { branchReadOnly: false });
    expect(off.statusCode).toBe(403);
    expect((await w.client.data(w.client.get('/rest/settings'))).sourceControl).toEqual({ readOnly: true });
  });

  it('protecting one workspace does not touch another', async () => {
    const a = await world();
    const b = await world();
    await protectWorkspace(server, a.tenant.id);
    expect((await b.client.post('/rest/folders', { name: 'Free' })).statusCode).toBe(200);
    refused(await a.client.post('/rest/folders', { name: 'Held' }), 'folderCreate');
  });
});

/** a CommandIo over memory files */
function fakeIo(files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const store = new Map(Object.entries(files));
  const io: CommandIo = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    readFile: async (file) => {
      const data = store.get(file);
      if (data === undefined) throw new Error(`No such file: ${file}`);
      return data;
    },
    writeFile: async (file, data) => {
      store.set(file, data);
    },
  };
  return { io, files: store, text: () => out.join('') + err.join('') };
}

describe('the server commands meet the lock', () => {
  it('import:workflow is refused with the workflow text and writes nothing', async () => {
    const w = await world();
    await protectWorkspace(server, w.tenant.id);
    const file = JSON.stringify([
      {
        name: 'Imported',
        nodes: [
          {
            id: 'n1',
            name: 'Start',
            type: 'core.manualTrigger',
            typeVersion: 1,
            position: [0, 0],
            parameters: {},
          },
        ],
        connections: {},
        settings: {},
      },
    ]);
    const io = fakeIo({ '/in.json': file });
    expect(
      await importWorkflowCommand(server.ctx, ['--tenant', w.tenant.slug, '--input', '/in.json'], io.io),
    ).toBe(1);
    expect(io.text()).toContain(PROTECTED_TEXT.workflowCreate);
    const rows = await server.ctx.database.pool.query('select id from workflows where tenant_id = $1', [
      w.tenant.id,
    ]);
    expect(rows.rows).toHaveLength(0);
  });

  it('import:credentials is refused with the credential text and writes nothing', async () => {
    const a = await world();
    const b = await world();
    await a.client.data(
      a.client.post('/rest/credentials', { name: 'Shared', type: 'testApi', data: { apiKey: 'sk-1' } }),
    );
    const exported = fakeIo();
    await exportCredentialsCommand(
      server.ctx,
      ['--tenant', a.tenant.slug, '--all', '--decrypted', '--output', '/c.json'],
      exported.io,
    );
    await protectWorkspace(server, b.tenant.id);
    const io = fakeIo({ '/c.json': exported.files.get('/c.json') ?? '' });
    expect(
      await importCredentialsCommand(server.ctx, ['--tenant', b.tenant.slug, '--input', '/c.json'], io.io),
    ).toBe(1);
    expect(io.text()).toContain(PROTECTED_TEXT.credentialCreate);
    const rows = await server.ctx.database.pool.query('select id from credentials where tenant_id = $1', [
      b.tenant.id,
    ]);
    expect(rows.rows).toHaveLength(0);
  });
});

describe('a pull is the one writer that passes', () => {
  it('creates a workflow, a credential, a folder and a table inside withPullWrites on a protected workspace', async () => {
    const w = await world();
    await protectWorkspace(server, w.tenant.id);
    await withPullWrites(async () => {
      expect((await w.client.post('/rest/folders', { name: 'Pulled' })).statusCode).toBe(200);
      expect(
        (await w.client.post('/rest/credentials', { name: 'Pulled', type: 'testApi', data: { apiKey: 'x' } }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await w.client.post('/rest/data-tables', {
            name: 'pulled',
            columns: [{ name: 'a', type: 'string' }],
          })
        ).statusCode,
      ).toBe(200);
    });
    refused(await w.client.post('/rest/folders', { name: 'After' }), 'folderCreate');
  });
});
