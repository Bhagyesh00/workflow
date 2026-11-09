/**
 * P6-35: the MCP server, its settings and its OAuth clients by project scope. True tests of a `member`
 * (`realMember`, `addToProject`): an MCP key or OAuth token reaches only the projects its user is in,
 * with the scopes of the user's project role; a removed relation or a narrowed role takes effect on
 * the next call with the same key; the OAuth grant is a second gate; a member lists and revokes only
 * its own OAuth client grant.
 */
import { randomUUID } from 'node:crypto';
import type { DataObject } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/services/auth';
import { handleMcpRequest, listMcpTools, mcpToolTable } from '../src/services/mcp/server';
import { MCP_KEY_AUDIENCE, MCP_KEY_LABEL, MCP_SCOPES, type McpCaller } from '../src/services/mcp/types';
import { MCP_WORKFLOW_TEXTS } from '../src/services/mcp/workflow-gate';
import {
  addToProject,
  chain,
  credentialIn,
  dataTableIn,
  folderIn,
  memberAs,
  node,
  projectIn,
  realMember,
  setNode,
  startMcpTestServer,
  TestClient,
  type TestMember,
  type TestServer,
  teamProjectOf,
  workflowIn,
} from './helpers';

const MISSING = 'User is missing a scope required to perform this action';
const ADDRESS = () =>
  `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;

let server: TestServer & { url: string; port: number };

beforeAll(async () => {
  server = await startMcpTestServer({ MCP_ACCESS_ENABLED: 'true', MCP_SERVER_RATE_LIMIT: '100000' });
});
afterAll(async () => {
  await server?.close();
});

/** a new workspace whose owner is signed in on the test server's own origin (the CSRF check) */
async function signup(_app?: unknown, input: { remoteAddress?: string } = {}) {
  const client = new TestClient(server.app, server.url, input.remoteAddress ?? ADDRESS());
  const id = randomUUID().slice(0, 8);
  const res = await client.post('/rest/auth/signup', {
    email: `mcp-scope-${id}@example.com`,
    password: 'Passw0rd!',
    name: `Scope ${id}`,
    workspaceName: `Scope ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as {
    user: { id: string; email: string };
    tenant: { id: string; slug: string };
  };
  // P6-39: signup makes no team project; the old default (where these tests' work lives) is made here
  const team = await client.data<{ id: string }>(client.post('/rest/projects', { name: `Scope ${id}` }));
  client.defaultProjectId = team.id;
  return { client, ...data };
}

/** a real `member` of the owner's workspace, signed in on the test server's origin */
const member_ = (owner: Awaited<ReturnType<typeof signup>>) =>
  realMember(owner, { remoteAddress: ADDRESS(), origin: server.url });

let rpcId = 0;

/** one JSON-RPC call to the workspace's MCP server with an MCP key */
async function rpc(slug: string, key: string, method: string, params?: DataObject) {
  const res = await fetch(`${server.url}/mcp-server/${slug}/http`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { result?: any; error?: { code: number; message: string } },
  };
}

interface Actor {
  slug: string;
  key: string;
  tenantId: string;
  userId: string;
  client: TestMember['client'];
}

async function keyFor(tenantId: string, userId: string): Promise<string> {
  return (await server.ctx.auth.createApiKey(tenantId, userId, MCP_KEY_LABEL, [], MCP_KEY_AUDIENCE)).key;
}

/** a tool call: the parsed value, or the refusal text */
async function call(actor: Actor, name: string, args: DataObject = {}) {
  const { body } = await rpc(actor.slug, actor.key, 'tools/call', { name, arguments: args });
  if (body.error)
    return { isError: true, text: body.error.message, value: undefined as any, code: body.error.code };
  const text = (body.result.content ?? []).map((p: { text?: string }) => p.text ?? '').join('');
  if (body.result.isError) return { isError: true, text, value: undefined as any, code: undefined };
  return { isError: false, text, value: JSON.parse(text), code: undefined };
}

/** a saved webhook workflow (with a version) that can be published, flagged for MCP */
async function webhookIn(tenantId: string, projectId: string, name: string) {
  return server.ctx.workflows.create(
    tenantId,
    {
      name,
      nodes: [
        node(
          'Webhook',
          'core.webhook',
          { path: `w-${randomUUID().slice(0, 8)}`, httpMethod: 'POST' },
          [0, 0],
          {
            webhookId: randomUUID(),
          },
        ),
        setNode('Set', 'greeting', 'hello'),
      ],
      connections: chain('Webhook', 'Set'),
      settings: { availableInMCP: true },
      projectId,
    } as never,
    {},
  );
}

/** an owner, two team projects (A, B), a member who is `role` in A only, and a flagged workflow in each */
async function setup(role = 'project:editor') {
  const owner = await signup(server.app, { remoteAddress: ADDRESS() });
  const tenantId = owner.tenant.id;
  const a = await projectIn(server, tenantId, 'Project A');
  const b = await projectIn(server, tenantId, 'Project B');
  const member = await member_(owner);
  await addToProject(server, tenantId, a.id, member.user.id, role);
  const flagged = { availableInMCP: true };
  const nodes = [node('Start', 'core.manualTrigger')];
  const wfA = await workflowIn(server, tenantId, a.id, { name: 'Alpha flow', nodes, settings: flagged });
  const wfB = await workflowIn(server, tenantId, b.id, { name: 'Beta flow', nodes, settings: flagged });
  const actor: Actor = {
    slug: owner.tenant.slug,
    key: await keyFor(tenantId, member.user.id),
    tenantId,
    userId: member.user.id,
    client: member.client,
  };
  const ownerActor: Actor = {
    slug: owner.tenant.slug,
    key: await keyFor(tenantId, owner.user.id),
    tenantId,
    userId: owner.user.id,
    client: owner.client,
  };
  return { owner, member, actor, ownerActor, a, b, wfA, wfB, tenantId };
}

describe('tool table', () => {
  it('every tool has an access scope and a grant scope, and none has a role', () => {
    const tools = mcpToolTable();
    expect(tools.length).toBeGreaterThanOrEqual(38);
    expect(tools.map((t) => t.name)).toContain('search_projects');
    for (const tool of tools) {
      expect(tool.access, tool.name).toMatch(/^[A-Za-z]+:[A-Za-z]+$/);
      expect(tool.scopes.length, tool.name).toBeGreaterThan(0);
      expect('minRole' in tool, tool.name).toBe(false);
    }
  });
});

describe('a member reaches its own projects only', () => {
  it('search and details: only project A; project B reads as missing; a named project B is refused', async () => {
    const { actor, a, b, wfA, wfB } = await setup();
    const search = await call(actor, 'search_workflows', {});
    expect(search.value.data.map((w: { id: string }) => w.id)).toEqual([wfA.id]);
    expect(search.value.data[0].projectId).toBe(a.id);
    const inB = await call(actor, 'search_workflows', { projectId: b.id });
    expect(inB.isError).toBe(true);
    expect(inB.text).toContain(MISSING);
    expect((await call(actor, 'search_workflows', { projectId: a.id })).value.data).toHaveLength(1);
    expect((await call(actor, 'get_workflow_details', { workflowId: wfA.id })).isError).toBe(false);
    const hidden = await call(actor, 'get_workflow_details', { workflowId: wfB.id });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toContain(MCP_WORKFLOW_TEXTS.notFound);
    for (const name of [
      'get_workflow_history',
      'publish_workflow',
      'unpublish_workflow',
      'prepare_workflow_pin_data',
    ]) {
      const res = await call(actor, name, { workflowId: wfB.id });
      expect(res.isError, name).toBe(true);
      expect(res.text, name).toContain(MCP_WORKFLOW_TEXTS.notFound);
    }
    const run = await call(actor, 'execute_workflow', { workflowId: wfB.id, executionMode: 'manual' });
    expect(run.isError).toBe(true);
    expect(run.text).toContain(MCP_WORKFLOW_TEXTS.notFound);
    const edit = await call(actor, 'archive_workflow', { workflowId: wfB.id });
    expect(edit.text).toContain(MCP_WORKFLOW_TEXTS.notFound);
    const row = await server.ctx.repos.workflows.get(actor.tenantId, wfB.id);
    expect(row?.isArchived).toBe(false);
  });

  it('search_projects lists the projects it can read, the exact name first', async () => {
    const { actor, owner, member, a, b } = await setup();
    const c = await projectIn(server, owner.tenant.id, 'Project A extra');
    await addToProject(server, owner.tenant.id, c.id, member.user.id, 'project:viewer');
    const all = (await call(actor, 'search_projects', {})).value.data as Array<{ id: string; type: string }>;
    expect(all.map((p) => p.id)).toEqual(expect.arrayContaining([a.id, c.id]));
    expect(all.map((p) => p.id)).not.toContain(b.id);
    const found = (await call(actor, 'search_projects', { query: 'project a' })).value.data as Array<{
      id: string;
      name: string;
    }>;
    expect(found.map((p) => p.name)).toEqual(['Project A', 'Project A extra']);
    expect((await call(actor, 'search_projects', { query: 'Project B' })).value.data).toEqual([]);
  });

  it('create_workflow: in its project yes, in another project or with another project credential no', async () => {
    const { actor, a, b, owner } = await setup();
    const definition = {
      name: 'Made by MCP',
      nodes: [node('Start', 'core.manualTrigger')].map((n) => ({ ...n })),
      connections: {},
    };
    const refused = await call(actor, 'create_workflow', { workflow: definition, projectId: b.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(MISSING);
    const made = await call(actor, 'create_workflow', { workflow: definition, projectId: a.id });
    expect(made.isError, made.text).toBe(false);
    const row = await server.ctx.repos.workflows.get(actor.tenantId, made.value.workflowId);
    expect(row?.projectId).toBe(a.id);
    // a credential of project B is not usable in project A
    const foreign = await credentialIn(server, owner.tenant.id, b.id, { type: 'httpHeaderAuth' });
    const withCred = {
      name: 'Uses credential',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('HTTP', 'core.httpRequest', { url: 'https://example.com/' }, [200, 0], {
          credentials: { httpHeaderAuth: { id: foreign.id, name: foreign.name } },
        }),
      ],
      connections: { Start: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] } },
    };
    const denied = await call(actor, 'create_workflow', { workflow: withCred, projectId: a.id });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('does not have access to the credential');
    // by name only: no usable row of project A holds the name, so the answer is the invalid credential, with its hint
    const byName = await call(actor, 'create_workflow', {
      workflow: {
        ...withCred,
        nodes: [
          withCred.nodes[0],
          { ...withCred.nodes[1], credentials: { httpHeaderAuth: { id: null, name: foreign.name } } },
        ],
      },
      projectId: a.id,
    });
    expect(byName.isError).toBe(true);
    expect(byName.text).toContain('uses invalid credential. Please recreate the credential.');
    expect(
      (await server.ctx.repos.workflows.list(actor.tenantId, { search: 'Uses credential', limit: 10 }))
        .length,
    ).toBe(0);
  });

  it('list_credentials, data tables and folders are narrowed to its project', async () => {
    const { actor, a, b, owner } = await setup();
    const mine = await credentialIn(server, owner.tenant.id, a.id, { name: 'Mine' });
    const theirs = await credentialIn(server, owner.tenant.id, b.id, { name: 'Theirs' });
    const creds = (await call(actor, 'list_credentials', {})).value.data as Array<{ id: string }>;
    expect(creds.map((c) => c.id)).toContain(mine.id);
    expect(creds.map((c) => c.id)).not.toContain(theirs.id);

    const tableA = await dataTableIn(server, owner.tenant.id, a.id);
    const tableB = await dataTableIn(server, owner.tenant.id, b.id);
    const tables = (await call(actor, 'search_data_tables', {})).value.data as Array<{ id: string }>;
    expect(tables.map((t) => t.id)).toEqual([tableA.id]);
    expect((await call(actor, 'get_data_table_rows', { dataTableId: tableA.id })).isError).toBe(false);
    const rowsB = await call(actor, 'get_data_table_rows', { dataTableId: tableB.id });
    expect(rowsB.isError).toBe(true);
    expect(rowsB.text).toContain(MISSING);
    expect((await call(actor, 'rename_data_table', { dataTableId: tableB.id, name: 'x' })).text).toContain(
      MISSING,
    );
    expect(
      (await call(actor, 'add_data_table_rows', { dataTableId: tableB.id, rows: [{ a: 1 }] })).text,
    ).toContain(MISSING);
    expect((await call(actor, 'create_data_table', { name: 'in_b', projectId: b.id })).text).toContain(
      MISSING,
    );
    expect((await call(actor, 'create_data_table', { name: 'in_a', projectId: a.id })).isError).toBe(false);

    const folderA = await folderIn(server, owner.tenant.id, a.id, 'Folder A');
    const folderB = await folderIn(server, owner.tenant.id, b.id, 'Folder B');
    const folders = (await call(actor, 'search_folders', {})).value.data as Array<{ id: string }>;
    expect(folders.map((f) => f.id)).toEqual([folderA.id]);
    expect((await call(actor, 'update_folder', { folderId: folderB.id, name: 'Renamed' })).text).toContain(
      MISSING,
    );
    expect((await call(actor, 'create_folder', { name: 'Nope', projectId: b.id })).text).toContain(MISSING);
    expect((await call(actor, 'create_folder', { name: 'Yes', projectId: a.id })).isError).toBe(false);
  });

  it('executions: only those of workflows in its projects', async () => {
    const { actor, owner, wfA, wfB } = await setup();
    const exec = async (workflowId: string) => {
      const id = randomUUID();
      await server.ctx.repos.executions.create(
        owner.tenant.id,
        { id, workflowId, workflowName: 'W', mode: 'manual', status: 'success', startedAt: new Date() },
        {
          workflowData: { id: workflowId, name: 'W', nodes: [], connections: {}, settings: {} },
          runOptions: {},
        },
      );
      return { id };
    };
    const eA = await exec(wfA.id);
    const eB = await exec(wfB.id);
    const list = (await call(actor, 'search_workflow_executions', {})).value.data as Array<{ id: string }>;
    expect(list.map((e) => e.id)).toEqual([eA.id]);
    expect(
      (await call(actor, 'get_workflow_execution', { workflowId: wfA.id, executionId: eA.id })).isError,
    ).toBe(false);
    const other = await call(actor, 'get_workflow_execution', { workflowId: wfB.id, executionId: eB.id });
    expect(other.isError).toBe(true);
  });
});

describe('removal and narrowing take effect on the next call with the same key', () => {
  it('a removed relation hides the project at once', async () => {
    const { actor, owner, member, a, wfA } = await setup();
    expect((await call(actor, 'get_workflow_details', { workflowId: wfA.id })).isError).toBe(false);
    await server.ctx.repos.projects.relations.remove(owner.tenant.id, a.id, member.user.id);
    expect((await call(actor, 'search_workflows', {})).value.data).toEqual([]);
    expect((await call(actor, 'get_workflow_details', { workflowId: wfA.id })).text).toContain(
      MCP_WORKFLOW_TEXTS.notFound,
    );
  });

  it('a narrowed project role takes the write tools away at once', async () => {
    const { actor, owner, member, a } = await setup();
    const wfA = await webhookIn(owner.tenant.id, a.id, 'Hook A');
    const publish = await call(actor, 'publish_workflow', { workflowId: wfA.id });
    expect(publish.isError, publish.text).toBe(false);
    await addToProject(server, owner.tenant.id, a.id, member.user.id, 'project:viewer');
    expect((await call(actor, 'get_workflow_details', { workflowId: wfA.id })).isError).toBe(false);
    for (const name of ['unpublish_workflow', 'archive_workflow']) {
      const res = await call(actor, name, { workflowId: wfA.id });
      expect(res.isError, name).toBe(true);
      expect(res.text, name).toContain(MCP_WORKFLOW_TEXTS.notFound);
    }
    expect(
      (await call(actor, 'execute_workflow', { workflowId: wfA.id, executionMode: 'manual' })).isError,
    ).toBe(true);
    const row = await server.ctx.repos.workflows.get(owner.tenant.id, wfA.id);
    expect(row?.isArchived).toBe(false);
    expect(row?.active).toBe(true);
  });

  it('a removed member loses the key at once', async () => {
    const { actor, owner, member } = await setup();
    expect((await rpc(actor.slug, actor.key, 'tools/list')).status).toBe(200);
    await server.ctx.repos.memberships.remove(owner.tenant.id, member.user.id);
    expect((await rpc(actor.slug, actor.key, 'tools/list')).status).toBe(401);
  });
});

describe('the OAuth grant is a second gate', () => {
  async function callerOf(actor: Actor, scopes: McpCaller['scopes']): Promise<McpCaller> {
    const [user, tenant, membership] = await Promise.all([
      server.ctx.repos.users.get(actor.userId),
      server.ctx.repos.tenants.get(actor.tenantId),
      server.ctx.repos.memberships.get(actor.tenantId, actor.userId),
    ]);
    return {
      user: user!,
      tenant: tenant!,
      role: membership!.role,
      globalScopes: await server.ctx.access.globalScopes(actor.tenantId, membership!.role),
      scopes,
      via: 'oauth',
      clientId: 'test-client',
    };
  }

  it('a tool needs the grant scope and the access scope; either one missing hides and refuses it', async () => {
    const { actor, member, wfA, a } = await setup('project:viewer');
    const send = async (c: McpCaller, name: string, args: DataObject) =>
      (
        await handleMcpRequest(server.ctx, {
          caller: c,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
          headers: {},
          resource: `${server.url}/mcp-server/${actor.slug}/http`,
        })
      ).body as { result?: any; error?: { code: number; message: string } };
    // the grant has no write scope: the tool is hidden and refused though the user's role allows it
    await addToProject(server, actor.tenantId, a.id, member.user.id, 'project:editor');
    const readGrant = await callerOf(actor, ['workflow:read']);
    expect((await listMcpTools(server.ctx, readGrant)).map((t) => t.name)).not.toContain('publish_workflow');
    expect((await send(readGrant, 'publish_workflow', { workflowId: wfA.id })).error?.code).toBe(-32602);
    const full = await callerOf(actor, [...MCP_SCOPES]);
    expect((await listMcpTools(server.ctx, full)).map((t) => t.name)).toContain('publish_workflow');
    // the grant holds the scope, the user has no project role and no workspace scope for it: hidden and refused
    const other = await signup(server.app, { remoteAddress: ADDRESS() });
    const nobody: McpCaller = {
      ...full,
      user: (await server.ctx.repos.users.get(other.user.id))!,
      role: 'member',
      globalScopes: await server.ctx.access.globalScopes(actor.tenantId, 'member'),
    };
    const names = (await listMcpTools(server.ctx, nobody)).map((t) => t.name);
    expect(names).not.toContain('publish_workflow');
    expect(names).not.toContain('create_workflow');
    expect(names).not.toContain('search_projects');
    expect(names).toContain('list_workflow_tags');
    expect(
      (await send(nobody, 'create_workflow', { workflow: { name: 'x', nodes: [], connections: {} } })).error,
    ).toEqual({ code: -32602, message: 'You do not have access to the tool create_workflow' });
  });
});

describe('/rest/mcp settings by scope', () => {
  it('a member reads the settings and has its own key; it cannot change the settings', async () => {
    const { member } = await setup();
    expect((await member.client.get('/rest/mcp/settings')).statusCode).toBe(200);
    expect((await member.client.patch('/rest/mcp/settings', { mcpAccessEnabled: true })).statusCode).toBe(
      403,
    );
    expect((await member.client.get('/rest/mcp/api-key')).statusCode).toBe(200);
    expect((await member.client.post('/rest/mcp/api-key/rotate')).statusCode).toBe(200);
  });

  it('the workflow list and the toggle follow workflow:update per project', async () => {
    const { owner, member, wfA, wfB, a, b } = await setup();
    const list = (await member.client.data(member.client.get('/rest/mcp/workflows'))) as Array<{
      id: string;
    }>;
    expect(list.map((w) => w.id)).toEqual([wfA.id]);
    const toggle = (body: unknown) => member.client.patch('/rest/mcp/workflows/toggle-access', body);
    // another project's workflow, named: 403 and nothing changed
    expect((await toggle({ availableInMCP: false, workflowIds: [wfA.id, wfB.id] })).statusCode).toBe(403);
    const flag = async (id: string) =>
      ((await server.ctx.repos.workflows.get(owner.tenant.id, id))!.settings as DataObject).availableInMCP;
    expect(await flag(wfA.id)).toBe(true);
    expect(await flag(wfB.id)).toBe(true);
    // allWorkflows of a project it cannot edit: 403; of its own: only that project's workflows change
    expect((await toggle({ availableInMCP: false, allWorkflows: true, projectId: b.id })).statusCode).toBe(
      403,
    );
    expect(
      await member.client.data(toggle({ availableInMCP: false, allWorkflows: true, projectId: a.id })),
    ).toEqual({
      updatedCount: 1,
    });
    expect(await flag(wfA.id)).toBe(false);
    expect(await flag(wfB.id)).toBe(true);
    // allWorkflows with no project: every workflow the caller can edit, which is A's again
    expect(await member.client.data(toggle({ availableInMCP: true, allWorkflows: true }))).toEqual({
      updatedCount: 1,
    });
    expect(await flag(wfB.id)).toBe(true);
    // a folder of project B is not readable
    const folderB = await folderIn(server, owner.tenant.id, b.id);
    expect((await toggle({ availableInMCP: true, folderId: folderB.id })).statusCode).toBe(403);
    // `projectId` is a target of its own (n8n): A's workflows, already on; project B is refused
    expect(await member.client.data(toggle({ availableInMCP: true, projectId: a.id }))).toEqual({
      updatedCount: 0,
    });
    expect((await toggle({ availableInMCP: true, projectId: b.id })).statusCode).toBe(403);
    // a viewer of project A edits nothing there: the list is empty and a toggle of A's workflow is refused
    await addToProject(server, owner.tenant.id, a.id, member.user.id, 'project:viewer');
    expect(await member.client.data(member.client.get('/rest/mcp/workflows'))).toEqual([]);
    expect((await toggle({ availableInMCP: false, workflowIds: [wfA.id] })).statusCode).toBe(403);
    expect(await flag(wfA.id)).toBe(true);
  });

  it('a member with no project role in the team project lists none and toggles none', async () => {
    const owner = await signup(server.app, { remoteAddress: ADDRESS() });
    const stranger = await member_(owner);
    const team = await teamProjectOf(server, owner.tenant.id);
    const wf = await workflowIn(server, owner.tenant.id, team, {
      name: 'Team flow',
      settings: { availableInMCP: true },
    });
    expect(await stranger.client.data(stranger.client.get('/rest/mcp/workflows'))).toEqual([]);
    const res = await stranger.client.patch('/rest/mcp/workflows/toggle-access', {
      availableInMCP: false,
      workflowIds: [wf.id],
    });
    expect(res.statusCode).toBe(403);
    expect(
      ((await server.ctx.repos.workflows.get(owner.tenant.id, wf.id))!.settings as DataObject).availableInMCP,
    ).toBe(true);
  });
});

describe('OAuth clients: a member sees and revokes only its own grant', () => {
  async function registerClient(tenantId: string): Promise<string> {
    const id = `client-${randomUUID()}`;
    await server.ctx.repos.mcpOAuth.createClient({
      id,
      tenantId,
      name: `Client ${id.slice(-6)}`,
      redirectUris: ['http://localhost:4444/cb'],
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod: 'none',
    });
    return id;
  }

  async function grant(tenantId: string, userId: string, clientId: string, slug: string): Promise<string> {
    await server.ctx.repos.mcpOAuth.saveConsent({ tenantId, userId, clientId, scope: ['workflow:read'] });
    const access = `wfo_at_${randomUUID()}`;
    const row = {
      tenantId,
      clientId,
      userId,
      resource: `${server.url}/mcp-server/${slug}/http`,
      scope: ['workflow:read'],
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    await server.ctx.repos.mcpOAuth.saveTokens(
      { ...row, tokenHash: sha256(access) },
      { ...row, tokenHash: sha256(`wfo_rt_${randomUUID()}`) },
    );
    return access;
  }

  it('list: own clients; ownership=all needs mcp:manage; stats and redirect list too', async () => {
    const { owner, member } = await setup();
    const mine = await registerClient(owner.tenant.id);
    const owners = await registerClient(owner.tenant.id);
    await grant(owner.tenant.id, member.user.id, mine, owner.tenant.slug);
    await grant(owner.tenant.id, owner.user.id, owners, owner.tenant.slug);
    const own = (await member.client.data(member.client.get('/rest/mcp/oauth-clients'))) as Array<{
      id: string;
    }>;
    expect(own.map((c) => c.id)).toEqual([mine]);
    expect((await member.client.get('/rest/mcp/oauth-clients?ownership=all')).statusCode).toBe(403);
    expect((await member.client.get('/rest/mcp/instance-stats')).statusCode).toBe(403);
    expect((await member.client.get('/rest/mcp/oauth/allowed-redirect-uris')).statusCode).toBe(403);
    expect(
      (await member.client.patch('/rest/mcp/oauth/allowed-redirect-uris', { allowedRedirectUris: [] }))
        .statusCode,
    ).toBe(403);
    const ownersOwn = (await owner.client.data(owner.client.get('/rest/mcp/oauth-clients'))) as Array<{
      id: string;
    }>;
    expect(ownersOwn.map((c) => c.id)).toEqual([owners]);
    const all = (await owner.client.data(
      owner.client.get('/rest/mcp/oauth-clients?ownership=all'),
    )) as Array<{ id: string }>;
    expect(all.map((c) => c.id).sort()).toEqual([mine, owners].sort());
  });

  it("a delete removes one user's grant only (own by default); the client goes with its last consent; another user's needs mcp:manage", async () => {
    const { owner, member } = await setup();
    const shared = await registerClient(owner.tenant.id);
    const ownersOnly = await registerClient(owner.tenant.id);
    const memberToken = await grant(owner.tenant.id, member.user.id, shared, owner.tenant.slug);
    const ownerToken = await grant(owner.tenant.id, owner.user.id, shared, owner.tenant.slug);
    await grant(owner.tenant.id, owner.user.id, ownersOnly, owner.tenant.slug);
    const { mcpOAuth } = server.ctx.repos;
    // a client the member never consented to: 404, nothing removed
    expect((await member.client.delete(`/rest/mcp/oauth-clients/${ownersOnly}`)).statusCode).toBe(404);
    expect(await mcpOAuth.getConsent(owner.tenant.id, owner.user.id, ownersOnly)).toBeDefined();
    // another user's grant needs mcp:manage: a member is refused and nothing is removed
    expect(
      (await member.client.delete(`/rest/mcp/oauth-clients/${shared}?userId=${owner.user.id}`)).statusCode,
    ).toBe(403);
    expect(await mcpOAuth.getConsent(owner.tenant.id, owner.user.id, shared)).toBeDefined();
    // its own grant: consent and tokens go, the client and the owner's grant stay
    expect(await member.client.data(member.client.delete(`/rest/mcp/oauth-clients/${shared}`))).toEqual({
      ok: true,
    });
    expect(await mcpOAuth.getConsent(owner.tenant.id, member.user.id, shared)).toBeUndefined();
    expect(await mcpOAuth.getAccessToken(owner.tenant.id, sha256(memberToken))).toBeUndefined();
    expect(await mcpOAuth.getClient(owner.tenant.id, shared)).toBeDefined();
    expect(await mcpOAuth.getConsent(owner.tenant.id, owner.user.id, shared)).toBeDefined();
    expect(await mcpOAuth.getAccessToken(owner.tenant.id, sha256(ownerToken))).toBeDefined();
    expect((await member.client.delete(`/rest/mcp/oauth-clients/${shared}`)).statusCode).toBe(404);
    expect(await member.client.data(member.client.get('/rest/mcp/oauth-clients'))).toEqual([]);
    // the owner holds mcp:manage and its own consent: its delete is its own grant too, and the last one
    // takes the client with it
    expect(await owner.client.data(owner.client.delete(`/rest/mcp/oauth-clients/${shared}`))).toEqual({
      ok: true,
    });
    expect(await mcpOAuth.getAccessToken(owner.tenant.id, sha256(ownerToken))).toBeUndefined();
    expect(await mcpOAuth.getClient(owner.tenant.id, shared)).toBeUndefined();
    expect(await mcpOAuth.getClient(owner.tenant.id, ownersOnly)).toBeDefined();
    const audit = (await server.ctx.repos.audit.list(owner.tenant.id, 50)).map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['mcp.oauth_grant_revoked', 'mcp.oauth_client_deleted']));
  });

  it("an admin's delete never removes the client for the others; ?userId= picks another user's grant", async () => {
    const { owner, member } = await setup();
    const shared = await registerClient(owner.tenant.id);
    const memberToken = await grant(owner.tenant.id, member.user.id, shared, owner.tenant.slug);
    const ownerToken = await grant(owner.tenant.id, owner.user.id, shared, owner.tenant.slug);
    const { mcpOAuth } = server.ctx.repos;
    // the admin's own Revoke: its grant goes, the member's consent, token and the client stay
    expect(await owner.client.data(owner.client.delete(`/rest/mcp/oauth-clients/${shared}`))).toEqual({
      ok: true,
    });
    expect(await mcpOAuth.getAccessToken(owner.tenant.id, sha256(ownerToken))).toBeUndefined();
    expect(await mcpOAuth.getClient(owner.tenant.id, shared)).toBeDefined();
    expect(await mcpOAuth.getConsent(owner.tenant.id, member.user.id, shared)).toBeDefined();
    expect(await mcpOAuth.getAccessToken(owner.tenant.id, sha256(memberToken))).toBeDefined();
    // another user's grant through ?userId=: a user with no consent is 404, a bad id 400
    expect(
      (await owner.client.delete(`/rest/mcp/oauth-clients/${shared}?userId=${owner.user.id}`)).statusCode,
    ).toBe(404);
    expect((await owner.client.delete(`/rest/mcp/oauth-clients/${shared}?userId=nope`)).statusCode).toBe(400);
    expect(
      await owner.client.data(
        owner.client.delete(`/rest/mcp/oauth-clients/${shared}?userId=${member.user.id}`),
      ),
    ).toEqual({ ok: true });
    expect(await mcpOAuth.getAccessToken(owner.tenant.id, sha256(memberToken))).toBeUndefined();
    expect(await mcpOAuth.getClient(owner.tenant.id, shared)).toBeUndefined();
  });

  it('the member routes need mcp:oauth: a workspace role without it is refused', async () => {
    const { owner } = await setup();
    const shared = await registerClient(owner.tenant.id);
    const role = await owner.client.data<{ slug: string }>(
      owner.client.post('/rest/roles', {
        displayName: `No oauth ${randomUUID().slice(0, 6)}`,
        roleType: 'global',
        scopes: ['instanceAi:message'],
      }),
    );
    const bare = await memberAs(owner, role.slug as never, {
      email: `no-oauth-${randomUUID().slice(0, 8)}@example.com`,
      remoteAddress: ADDRESS(),
      origin: server.url,
    });
    await server.ctx.repos.mcpOAuth.saveConsent({
      tenantId: owner.tenant.id,
      userId: bare.user.id,
      clientId: shared,
      scope: ['workflow:read'],
    });
    expect((await bare.client.get('/rest/mcp/oauth-clients')).statusCode).toBe(403);
    expect((await bare.client.delete(`/rest/mcp/oauth-clients/${shared}`)).statusCode).toBe(403);
    expect(await server.ctx.repos.mcpOAuth.getConsent(owner.tenant.id, bare.user.id, shared)).toBeDefined();
  });

  it('repository: list by user and revoke by user are tenant and user bound', async () => {
    const one = await signup(server.app, { remoteAddress: ADDRESS() });
    const two = await signup(server.app, { remoteAddress: ADDRESS() });
    const client = await registerClient(one.tenant.id);
    await grant(one.tenant.id, one.user.id, client, one.tenant.slug);
    const { mcpOAuth } = server.ctx.repos;
    expect((await mcpOAuth.listClientsByUser(one.tenant.id, one.user.id)).map((c) => c.id)).toEqual([client]);
    expect(await mcpOAuth.listClientsByUser(one.tenant.id, two.user.id)).toEqual([]);
    expect(await mcpOAuth.listClientsByUser(two.tenant.id, one.user.id)).toEqual([]);
    expect(await mcpOAuth.revokeForUser(two.tenant.id, one.user.id, client)).toBe(false);
    expect(await mcpOAuth.revokeForUser(one.tenant.id, two.user.id, client)).toBe(false);
    expect(await mcpOAuth.revokeForUser(one.tenant.id, one.user.id, client)).toBe(true);
    expect(await mcpOAuth.revokeForUser(one.tenant.id, one.user.id, client)).toBe(false);
    // the client row goes only when no consent is left, and only in its own workspace
    await mcpOAuth.saveConsent({ tenantId: one.tenant.id, userId: two.user.id, clientId: client, scope: [] });
    expect(await mcpOAuth.deleteClientWithoutConsents(one.tenant.id, client)).toBe(false);
    expect(await mcpOAuth.revokeForUser(one.tenant.id, two.user.id, client)).toBe(true);
    expect(await mcpOAuth.deleteClientWithoutConsents(two.tenant.id, client)).toBe(false);
    expect(await mcpOAuth.deleteClientWithoutConsents(one.tenant.id, client)).toBe(true);
    expect(await mcpOAuth.getClient(one.tenant.id, client)).toBeUndefined();
  });
});
