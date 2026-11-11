/**
 * Phase 6 S4 C0d: the protected workspace wiring and the settings flag. With the PASS stubs every wired write
 * still answers as before (on a workspace that is not protected, which L7 keeps); `withPullWrites` and
 * `inPullWrite` share one AsyncLocalStorage; GET /settings shows `sourceControl.readOnly`, read from the
 * one key `isProtected` reads; `repos.tenants.mergeSettings` writes only its own top-level keys, so a
 * PATCH /settings right after a protect keeps the flag and the brand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  inPullWrite,
  isProtected,
  PROTECTED_TEXT,
  type ProtectedAction,
  ProtectedWorkspaceError,
  withPullWrites,
} from '../src/services/protected';
import {
  createTestServer,
  createWorkflow,
  node,
  realMember,
  signup,
  type TestServer,
  teamProjectOf,
  waitForExecution,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});

const ACTIONS: ProtectedAction[] = [
  'manualRun',
  'workflowCreate',
  'workflowUpdate',
  'workflowDelete',
  'workflowArchive',
  'workflowRestore',
  'credentialCreate',
  'variableCreate',
  'variableDelete',
  'variableRename',
  'folderCreate',
  'folderUpdate',
  'folderDelete',
  'projectCreate',
  'dataTableCreate',
  'dataTableStructure',
  'push',
];

async function settingsRow(tenantId: string): Promise<Record<string, unknown>> {
  const row = await server.ctx.repos.tenants.get(tenantId);
  return (row?.settings ?? {}) as Record<string, unknown>;
}

describe('protected.ts names', () => {
  it('has a text for every action, with the two decided texts verbatim', () => {
    expect(Object.keys(PROTECTED_TEXT).sort()).toEqual([...ACTIONS].sort());
    expect(PROTECTED_TEXT.manualRun).toBe(
      'Cannot run workflows manually on a protected workspace. This workspace is in read-only mode.',
    );
    expect(PROTECTED_TEXT.push).toBe('Cannot push onto read-only branch.');
    for (const action of ACTIONS) {
      expect(PROTECTED_TEXT[action]).not.toMatch(/instance|n8n/i);
    }
  });

  it('ProtectedWorkspaceError is 403 workspace_protected, and 400 for push', () => {
    const run = new ProtectedWorkspaceError('manualRun');
    expect(run.statusCode).toBe(403);
    expect(run.code).toBe('workspace_protected');
    expect(run.message).toBe(PROTECTED_TEXT.manualRun);
    expect(run.action).toBe('manualRun');
    const push = new ProtectedWorkspaceError('push');
    expect(push.statusCode).toBe(400);
    expect(push.code).toBe('workspace_protected');
    expect(push.message).toBe(PROTECTED_TEXT.push);
  });

  it('isProtected reads only sourceControl.readOnly === true', () => {
    expect(isProtected(undefined)).toBe(false);
    expect(isProtected(null)).toBe(false);
    expect(isProtected({})).toBe(false);
    expect(isProtected({ sourceControl: {} })).toBe(false);
    expect(isProtected({ sourceControl: { readOnly: false } })).toBe(false);
    expect(isProtected({ sourceControl: { readOnly: 'true' } } as never)).toBe(false);
    expect(isProtected({ readOnly: true, mfa: { enforced: true } } as never)).toBe(false);
    expect(isProtected({ workflowReviews: { enabled: true }, mcp: { enabled: true } })).toBe(false);
    expect(isProtected({ sourceControl: { readOnly: true } })).toBe(true);
  });
});

describe('withPullWrites and inPullWrite', () => {
  it('is true inside withPullWrites and in a promise started there, false outside', async () => {
    expect(inPullWrite()).toBe(false);
    let later: Promise<boolean> | undefined;
    const result = await withPullWrites(async () => {
      expect(inPullWrite()).toBe(true);
      later = new Promise((resolve) => setTimeout(() => resolve(inPullWrite()), 10));
      await Promise.resolve();
      return inPullWrite();
    });
    expect(result).toBe(true);
    expect(await later).toBe(true);
    expect(inPullWrite()).toBe(false);
  });

  it('is false in work running at the same time, and passes a rejection through', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pull = withPullWrites(async () => {
      await gate;
      return inPullWrite();
    });
    const other = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return inPullWrite();
    })();
    // a request served while the pull is open
    const owner = await signup(server.app);
    const served = await owner.client.data(owner.client.get('/rest/settings'));
    expect(served.sourceControl).toEqual({ readOnly: false });
    expect(inPullWrite()).toBe(false);
    expect(await other).toBe(false);
    release();
    expect(await pull).toBe(true);
    await expect(
      withPullWrites(async () => {
        throw new Error('pull failed');
      }),
    ).rejects.toThrow('pull failed');
    expect(inPullWrite()).toBe(false);
  });
});

describe('mergeSettings', () => {
  it('writes only its own top-level keys; null removes a key; undefined leaves it', async () => {
    const owner = await signup(server.app);
    const { tenants } = server.ctx.repos;
    await tenants.mergeSettings(owner.tenant.id, { timezone: 'Europe/Paris', other: { a: 1 } });
    const row = await tenants.mergeSettings(owner.tenant.id, { sourceControl: { readOnly: true } });
    expect(row?.settings).toMatchObject({
      timezone: 'Europe/Paris',
      other: { a: 1 },
      sourceControl: { readOnly: true },
    });
    await tenants.mergeSettings(owner.tenant.id, { other: null, timezone: undefined });
    const after = await settingsRow(owner.tenant.id);
    expect(after).not.toHaveProperty('other');
    expect(after.timezone).toBe('Europe/Paris');
    expect(after.sourceControl).toEqual({ readOnly: true });
    expect(await tenants.mergeSettings('not-a-uuid', { timezone: 'UTC' })).toBeUndefined();
  });
});

describe('GET and PATCH /settings', () => {
  it('shows readOnly false, then true after mergeSettings, to the owner and a member', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    expect((await owner.client.data(owner.client.get('/rest/settings'))).sourceControl).toEqual({
      readOnly: false,
    });
    await server.ctx.repos.tenants.mergeSettings(owner.tenant.id, { sourceControl: { readOnly: true } });
    expect((await owner.client.data(owner.client.get('/rest/settings'))).sourceControl).toEqual({
      readOnly: true,
    });
    expect((await member.client.data(member.client.get('/rest/settings'))).sourceControl).toEqual({
      readOnly: true,
    });
  });

  it('a PATCH right after a protect keeps readOnly and the brand, and never writes sourceControl', async () => {
    const owner = await signup(server.app);
    await owner.client.data(owner.client.patch('/rest/settings', { brand: { name: 'Acme' } }));
    await server.ctx.repos.tenants.mergeSettings(owner.tenant.id, { sourceControl: { readOnly: true } });
    const patched = await owner.client.data(
      owner.client.patch('/rest/settings', { timezone: 'Europe/Berlin', sourceControl: { readOnly: false } }),
    );
    expect(patched.brand).toEqual({ name: 'Acme' });
    expect(patched.timezone).toBe('Europe/Berlin');
    const settings = await owner.client.data(owner.client.get('/rest/settings'));
    expect(settings.sourceControl).toEqual({ readOnly: true });
    expect(settings.brand.name).toBe('Acme');
    expect(settings.timezone).toBe('Europe/Berlin');
    const stored = await settingsRow(owner.tenant.id);
    expect(stored.sourceControl).toEqual({ readOnly: true });
    expect(stored.brand).toEqual({ name: 'Acme' });
  });
});

describe('with the PASS stubs every wired path still works', () => {
  it('workflow create, save, run, restore, archive, unarchive, move and delete', async () => {
    const owner = await signup(server.app);
    const { client } = owner;
    const wf = await createWorkflow(client, { nodes: [node('Start', 'core.manualTrigger')] });
    const saved = await client.data<{ versionId: string; name: string }>(
      client.patch(`/rest/workflows/${wf.id}`, { versionId: wf.versionId, name: 'Renamed' }),
    );
    expect(saved.name).toBe('Renamed');
    const { executionId } = await client.data<{ executionId: string }>(
      client.post(`/rest/workflows/${wf.id}/run`, {}),
    );
    expect((await waitForExecution(server.ctx, owner.tenant.id, executionId)).status).toBe('success');
    const restored = await client.data<{ id: string }>(
      client.post(`/rest/workflows/${wf.id}/versions/${wf.versionId}/restore`),
    );
    expect(restored.id).toBe(wf.id);
    const folder = await client.data<{ id: string }>(client.post('/rest/folders', { name: 'Target' }));
    const moved = await server.ctx.workflowArchive.move(owner.tenant.id, [wf.id], folder.id, {
      userId: owner.user.id,
    });
    expect(moved.moved).toEqual([wf.id]);
    await client.data(client.post(`/rest/workflows/${wf.id}/archive`));
    await client.data(client.post(`/rest/workflows/${wf.id}/unarchive`));
    await client.data(client.post(`/rest/workflows/${wf.id}/archive`));
    expect((await client.delete(`/rest/workflows/${wf.id}`)).statusCode).toBe(200);
  });

  it('folder create, change and delete; project create', async () => {
    const owner = await signup(server.app);
    expect(owner.client.defaultProjectId).toBeTruthy();
    const { client } = owner;
    const folder = await client.data<{ id: string }>(client.post('/rest/folders', { name: 'F' }));
    const changed = await client.data<{ name: string }>(
      client.patch(`/rest/folders/${folder.id}`, { name: 'F2' }),
    );
    expect(changed.name).toBe('F2');
    expect((await client.delete(`/rest/folders/${folder.id}`)).statusCode).toBe(200);
    const project = await client.data<{ id: string }>(client.post('/rest/projects', { name: 'Second' }));
    expect(project.id).toBeTruthy();
  });

  it('variable create, value change, key rename and delete', async () => {
    const owner = await signup(server.app);
    const { client } = owner;
    const made = await client.data<{ id: string }>(
      client.post('/rest/variables', { key: 'wiring_a', value: '1' }),
    );
    expect((await client.data(client.patch(`/rest/variables/${made.id}`, { value: '2' }))).value).toBe('2');
    expect((await client.data(client.patch(`/rest/variables/${made.id}`, { key: 'wiring_b' }))).key).toBe(
      'wiring_b',
    );
    expect((await client.delete(`/rest/variables/${made.id}`)).statusCode).toBe(200);
  });

  it('data table create, rename, columns (add, rename, move, delete) and delete', async () => {
    const owner = await signup(server.app);
    const { client } = owner;
    const table = await client.data<{ id: string }>(
      client.post('/rest/data-tables', { name: 'Orders', columns: [{ name: 'title', type: 'string' }] }),
    );
    const renamed = await client.data<{ name: string }>(
      client.patch(`/rest/data-tables/${table.id}`, { name: 'Orders2' }),
    );
    expect(renamed.name).toBe('Orders2');
    const column = await client.data<{ id: string }>(
      client.post(`/rest/data-tables/${table.id}/columns`, { name: 'qty', type: 'number' }),
    );
    await client.data(
      client.patch(`/rest/data-tables/${table.id}/columns/${column.id}/rename`, { name: 'amount' }),
    );
    await client.data(
      client.patch(`/rest/data-tables/${table.id}/columns/${column.id}/move`, { targetIndex: 0 }),
    );
    const columns = await client.data<Array<{ name: string }>>(
      client.get(`/rest/data-tables/${table.id}/columns`),
    );
    expect(columns.map((c) => c.name)).toEqual(['amount', 'title']);
    expect((await client.delete(`/rest/data-tables/${table.id}/columns/${column.id}`)).statusCode).toBe(200);
    expect((await client.delete(`/rest/data-tables/${table.id}`)).statusCode).toBe(200);
  });

  it("a node's table create, rename and column add", async () => {
    const owner = await signup(server.app);
    const access = server.ctx.dataTables.forProject(
      owner.tenant.id,
      await teamProjectOf(server, owner.tenant.id),
      { workflowId: 'w' },
    );
    const table = await access.createTable({ name: 'NodeMade', columns: [{ name: 'a', type: 'number' }] });
    expect((await access.renameTable(table.id, 'NodeMade2')).name).toBe('NodeMade2');
    expect((await access.addColumn(table.id, { name: 'b', type: 'string' })).name).toBe('b');
    await access.deleteTable(table.id);
  });

  it('runs a pull inside withPullWrites the same way', async () => {
    const owner = await signup(server.app);
    const { client } = owner;
    const wf = await withPullWrites(() =>
      createWorkflow(client, { name: 'Pulled', nodes: [node('Start', 'core.manualTrigger')] }),
    );
    expect(wf.id).toBeTruthy();
  });
});
