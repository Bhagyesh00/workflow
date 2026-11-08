/**
 * P5-04 /rest/mcp settings routes: the access switch and auto expose (admin), `MCP_MANAGED_BY_ENV`
 * (409), the caller's own MCP key (shown once, masked after, rotate), the editor's workflow list and
 * the admin's toggle-access (ids max 100, folder with subfolders, all). Shapes are the editor's DTOs.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '../src/db/schema';
import { createWorkflow, node, startMcpTestServer, TestClient, type TestServer } from './helpers';

let server: TestServer & { url: string; port: number };

beforeAll(async () => {
  server = await startMcpTestServer();
});
afterAll(async () => {
  await server?.close();
});

async function signup(target: TestServer & { url: string } = server) {
  const client = new TestClient(target.app, target.url);
  const id = randomUUID().slice(0, 8);
  const res = await client.post('/rest/auth/signup', {
    email: `mcp-settings-${id}@example.com`,
    password: 'Passw0rd!',
    name: `Settings ${id}`,
    workspaceName: `Settings ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as { user: { id: string }; tenant: { id: string; slug: string } };
  return { client, ...data, url: `${target.url}/mcp-server/${data.tenant.slug}/http` };
}

/** the user's role in its own workspace (the session reads it per request) */
const setRole = (tenantId: string, userId: string, role: Role) =>
  server.ctx.repos.memberships.updateRole(tenantId, userId, role);

const toolsList = (url: string, key: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

const flagOf = async (tenantId: string, id: string) => {
  const row = await server.ctx.repos.workflows.get(tenantId, id);
  return (row?.settings as { availableInMCP?: boolean } | undefined)?.availableInMCP === true;
};

const simple = (client: TestClient, name: string, extra: Record<string, unknown> = {}) =>
  client.data<{ id: string }>(
    client.post('/rest/workflows', {
      name,
      nodes: [node('Start', 'core.manualTrigger')],
      connections: {},
      ...extra,
    }),
  );

describe('settings', () => {
  it('viewer reads, admin changes; the change is merged and audited; auto expose flags new workflows', async () => {
    const user = await signup();
    await user.client.data(user.client.patch('/rest/settings', { timezone: 'Europe/Berlin' }));
    expect(await user.client.data(user.client.get('/rest/mcp/settings'))).toEqual({
      mcpAccessEnabled: false,
      managedByEnv: false,
      autoExposeNewWorkflows: false,
    });
    const patched = await user.client.data(
      user.client.patch('/rest/mcp/settings', { mcpAccessEnabled: true, autoExposeNewWorkflows: true }),
    );
    expect(patched).toEqual({ mcpAccessEnabled: true, managedByEnv: false, autoExposeNewWorkflows: true });
    const tenant = await server.ctx.repos.tenants.get(user.tenant.id);
    expect(tenant?.settings).toMatchObject({
      timezone: 'Europe/Berlin',
      mcp: { enabled: true, autoExposeNewWorkflows: true },
    });
    const audit = await server.ctx.repos.audit.list(user.tenant.id, 20);
    expect(audit.map((r) => r.action)).toContain('mcp.settings_updated');
    const wf = await createWorkflow(user.client, { nodes: [node('Start', 'core.manualTrigger')] });
    expect(await flagOf(user.tenant.id, wf.id)).toBe(true);
    // a partial patch keeps the other field
    expect(
      await user.client.data(user.client.patch('/rest/mcp/settings', { mcpAccessEnabled: false })),
    ).toMatchObject({
      autoExposeNewWorkflows: true,
    });
    expect((await user.client.patch('/rest/mcp/settings', { other: true })).statusCode).toBe(400);

    await setRole(user.tenant.id, user.user.id, 'viewer');
    expect((await user.client.get('/rest/mcp/settings')).statusCode).toBe(200);
    expect((await user.client.patch('/rest/mcp/settings', { mcpAccessEnabled: true })).statusCode).toBe(403);
    await setRole(user.tenant.id, user.user.id, 'editor');
    expect((await user.client.patch('/rest/mcp/settings', { mcpAccessEnabled: true })).statusCode).toBe(403);
    expect((await new TestClient(server.app, server.url).get('/rest/mcp/settings')).statusCode).toBe(401);
  });

  it('MCP_MANAGED_BY_ENV: the environment decides and PATCH is 409', async () => {
    const managed = await startMcpTestServer(
      { MCP_MANAGED_BY_ENV: 'true', MCP_ACCESS_ENABLED: 'true' },
      { reset: false, startMain: false },
    );
    try {
      const user = await signup(managed);
      expect(await user.client.data(user.client.get('/rest/mcp/settings'))).toEqual({
        mcpAccessEnabled: true,
        managedByEnv: true,
        autoExposeNewWorkflows: false,
      });
      const res = await user.client.patch('/rest/mcp/settings', { mcpAccessEnabled: false });
      expect(res.statusCode).toBe(409);
    } finally {
      await managed.close();
    }
  });
});

describe('api key', () => {
  it('created on first read and shown once, then masked; rotate replaces it; it works on the MCP server only', async () => {
    const user = await signup();
    await user.client.data(user.client.patch('/rest/mcp/settings', { mcpAccessEnabled: true }));
    const first = await user.client.data(user.client.get('/rest/mcp/api-key'));
    expect(first).toMatchObject({ name: 'MCP Server API Key', revealed: true });
    expect(first.key).toMatch(new RegExp(`^wfk_${first.prefix}_[A-Za-z0-9_-]{20,}$`));
    const again = await user.client.data(user.client.get('/rest/mcp/api-key'));
    expect(again).toEqual({ ...first, key: `wfk_${first.prefix}_...`, revealed: false });
    expect((await toolsList(user.url, first.key)).status).toBe(200);
    // not on the API keys page
    const keys = await user.client.data(user.client.get('/rest/api-keys'));
    expect(keys.map((k: { id: string }) => k.id)).not.toContain(first.id);

    const rotated = await user.client.data(user.client.post('/rest/mcp/api-key/rotate'));
    expect(rotated.revealed).toBe(true);
    expect(rotated.id).not.toBe(first.id);
    expect((await toolsList(user.url, first.key)).status).toBe(401);
    expect((await toolsList(user.url, rotated.key)).status).toBe(200);
    const audit = (await server.ctx.repos.audit.list(user.tenant.id, 20)).map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['mcp.api_key_created', 'mcp.api_key_rotated']));
    expect(JSON.stringify(await server.ctx.repos.audit.list(user.tenant.id, 20))).not.toContain(rotated.key);

    // a viewer has an own key too
    await setRole(user.tenant.id, user.user.id, 'viewer');
    expect((await user.client.get('/rest/mcp/api-key')).statusCode).toBe(200);
    expect((await user.client.post('/rest/mcp/api-key/rotate')).statusCode).toBe(200);
  });
});

describe('workflows and toggle-access', () => {
  it('editor lists the live workflows with their flag; viewer 403', async () => {
    const user = await signup();
    const folder = await user.client.data(user.client.post('/rest/folders', { name: 'F' }));
    const a = await simple(user.client, 'Alpha report', { settings: { availableInMCP: true } });
    const b = await simple(user.client, 'Beta sync', { folderId: folder.id });
    const archived = await simple(user.client, 'Gamma old');
    await user.client.data(user.client.post(`/rest/workflows/${archived.id}/archive`));
    const list = await user.client.data(user.client.get('/rest/mcp/workflows'));
    expect(list.map((w: { id: string }) => w.id).sort()).toEqual([a.id, b.id].sort());
    expect(list.find((w: { id: string }) => w.id === a.id)).toEqual({
      id: a.id,
      name: 'Alpha report',
      active: false,
      availableInMCP: true,
      folderId: null,
      updatedAt: expect.any(String),
    });
    expect(
      (await user.client.data(user.client.get('/rest/mcp/workflows?search=beta'))).map(
        (w: { id: string }) => w.id,
      ),
    ).toEqual([b.id]);
    expect(
      (await user.client.data(user.client.get(`/rest/mcp/workflows?folderId=${folder.id}`))).map(
        (w: { id: string }) => w.id,
      ),
    ).toEqual([b.id]);
    await setRole(user.tenant.id, user.user.id, 'viewer');
    expect((await user.client.get('/rest/mcp/workflows')).statusCode).toBe(403);
  });

  it('toggle-access by ids, by folder (with subfolders) and for all; admin only; other tenants untouched', async () => {
    const user = await signup();
    const other = await signup();
    const foreign = await simple(other.client, 'Foreign');
    const parent = await user.client.data(user.client.post('/rest/folders', { name: 'Parent' }));
    const child = await user.client.data(
      user.client.post('/rest/folders', { name: 'Child', parentFolderId: parent.id }),
    );
    const one = await simple(user.client, 'One');
    const two = await simple(user.client, 'Two', { folderId: parent.id });
    const three = await simple(user.client, 'Three', { folderId: child.id });
    const toggle = (body: unknown) => user.client.patch('/rest/mcp/workflows/toggle-access', body);

    expect(
      await user.client.data(toggle({ availableInMCP: true, workflowIds: [one.id, foreign.id] })),
    ).toEqual({
      updatedCount: 1,
    });
    expect(await flagOf(user.tenant.id, one.id)).toBe(true);
    expect(await flagOf(other.tenant.id, foreign.id)).toBe(false);
    expect(await user.client.data(toggle({ availableInMCP: true, workflowIds: [one.id] }))).toEqual({
      updatedCount: 0,
    });

    expect(await user.client.data(toggle({ availableInMCP: true, folderId: parent.id }))).toEqual({
      updatedCount: 2,
    });
    expect([await flagOf(user.tenant.id, two.id), await flagOf(user.tenant.id, three.id)]).toEqual([
      true,
      true,
    ]);
    expect(await user.client.data(toggle({ availableInMCP: false, allWorkflows: true }))).toEqual({
      updatedCount: 3,
    });
    expect(await flagOf(user.tenant.id, one.id)).toBe(false);

    const tooMany = Array.from({ length: 101 }, () => randomUUID());
    expect((await toggle({ availableInMCP: true, workflowIds: tooMany })).statusCode).toBe(400);
    expect((await toggle({ availableInMCP: true })).statusCode).toBe(400);
    expect((await toggle({ availableInMCP: true, allWorkflows: true, folderId: parent.id })).statusCode).toBe(
      400,
    );
    const foreignFolder = await other.client.data(other.client.post('/rest/folders', { name: 'Theirs' }));
    expect((await toggle({ availableInMCP: true, folderId: foreignFolder.id })).statusCode).toBe(404);

    await setRole(user.tenant.id, user.user.id, 'editor');
    expect((await toggle({ availableInMCP: true, allWorkflows: true })).statusCode).toBe(403);
    expect(await flagOf(user.tenant.id, one.id)).toBe(false);
  });
});
