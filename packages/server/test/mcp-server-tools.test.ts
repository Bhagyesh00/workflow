/**
 * P5-04 tool table of the tenant MCP server: the drift test (names, scopes, roles over `tools minus
 * MCP_BUILDER_TOOLS`; L9 tests its own), the role and scope matrix in the list and again in the call
 * path, the workflow gate with n8n's texts, tenant isolation, and the behaviour of each tool group
 * (workflows, versions, runs, executions, credentials, tags, data tables, folders) plus the audit row.
 */
import { randomUUID } from 'node:crypto';
import type { DataObject } from '@workflow/workflow';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Role, workflows } from '../src/db/schema';
import { handleMcpRequest, listMcpTools, mcpToolDescriptor, mcpToolTable } from '../src/services/mcp/server';
import { MCP_BUILDER_TOOLS } from '../src/services/mcp/tools/builder';
import {
  MCP_KEY_AUDIENCE,
  MCP_KEY_LABEL,
  MCP_SCOPES,
  type McpCaller,
  type McpScope,
} from '../src/services/mcp/types';
import { MCP_WORKFLOW_TEXTS } from '../src/services/mcp/workflow-gate';
import {
  chain,
  createWorkflow,
  node,
  setNode,
  startMcpTestServer,
  TestClient,
  type TestServer,
  waitForExecution,
} from './helpers';

let server: TestServer & { url: string; port: number };

beforeAll(async () => {
  server = await startMcpTestServer({ MCP_ACCESS_ENABLED: 'true' });
});
afterAll(async () => {
  await server?.close();
});

/** the expected table: scope that unlocks the tool and its REST route's role */
const EXPECTED: Record<string, { scope: McpScope; minRole: Role }> = {
  search_workflows: { scope: 'workflow:read', minRole: 'viewer' },
  get_workflow_details: { scope: 'workflow:read', minRole: 'viewer' },
  get_workflow_history: { scope: 'workflow:read', minRole: 'viewer' },
  get_workflow_version: { scope: 'workflow:read', minRole: 'viewer' },
  get_workflow_versions_diff: { scope: 'workflow:read', minRole: 'viewer' },
  publish_workflow: { scope: 'workflow:write', minRole: 'editor' },
  unpublish_workflow: { scope: 'workflow:write', minRole: 'editor' },
  get_workflow_execution: { scope: 'execution:read', minRole: 'viewer' },
  search_workflow_executions: { scope: 'execution:read', minRole: 'viewer' },
  execute_workflow: { scope: 'workflow:execute', minRole: 'editor' },
  test_workflow: { scope: 'workflow:execute', minRole: 'editor' },
  prepare_workflow_pin_data: { scope: 'workflow:execute', minRole: 'editor' },
  list_credentials: { scope: 'credential:read', minRole: 'viewer' },
  list_workflow_tags: { scope: 'tag:read', minRole: 'viewer' },
  search_data_tables: { scope: 'dataTable:read', minRole: 'viewer' },
  get_data_table_rows: { scope: 'dataTable:read', minRole: 'viewer' },
  create_data_table: { scope: 'dataTable:write', minRole: 'editor' },
  rename_data_table: { scope: 'dataTable:write', minRole: 'editor' },
  add_data_table_column: { scope: 'dataTable:write', minRole: 'editor' },
  rename_data_table_column: { scope: 'dataTable:write', minRole: 'editor' },
  delete_data_table_column: { scope: 'dataTable:write', minRole: 'editor' },
  add_data_table_rows: { scope: 'dataTable:write', minRole: 'editor' },
  search_folders: { scope: 'project:read', minRole: 'viewer' },
  create_folder: { scope: 'project:write', minRole: 'editor' },
  update_folder: { scope: 'project:write', minRole: 'editor' },
  move_workflows_to_folder: { scope: 'workflow:write', minRole: 'editor' },
};

const ROLES: Role[] = ['viewer', 'editor', 'admin', 'owner'];
const RANK: Record<Role, number> = { member: 0, viewer: 1, editor: 2, admin: 3, owner: 4 };

/** the tenant server's own tools: the table minus the build tools (P5-13, tested by L9) */
const ownTools = () => {
  const builder = new Set(MCP_BUILDER_TOOLS);
  return mcpToolTable().filter((tool) => !builder.has(tool));
};

async function signup() {
  const client = new TestClient(server.app, server.url);
  const id = randomUUID().slice(0, 8);
  const res = await client.post('/rest/auth/signup', {
    email: `mcp-tools-${id}@example.com`,
    password: 'Passw0rd!',
    name: `Tools ${id}`,
    workspaceName: `Tools ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as { user: { id: string }; tenant: { id: string; slug: string } };
  const key = (
    await server.ctx.auth.createApiKey(data.tenant.id, data.user.id, MCP_KEY_LABEL, [], MCP_KEY_AUDIENCE)
  ).key;
  return { client, ...data, key, url: `${server.url}/mcp-server/${data.tenant.slug}/http` };
}

/** a user of `owner`'s workspace with `role` and an MCP key */
async function member(owner: Awaited<ReturnType<typeof signup>>, role: Role) {
  const other = await signup();
  await server.ctx.repos.memberships.add(owner.tenant.id, other.user.id, role);
  await server.ctx.repos.projects.ensurePersonal(
    owner.tenant.id,
    (await server.ctx.repos.users.get(other.user.id))!,
  );
  const key = (
    await server.ctx.auth.createApiKey(owner.tenant.id, other.user.id, MCP_KEY_LABEL, [], MCP_KEY_AUDIENCE)
  ).key;
  return { ...other, key };
}

async function caller(tenantId: string, userId: string, role: Role, scopes: McpScope[]): Promise<McpCaller> {
  const [user, tenant] = await Promise.all([
    server.ctx.repos.users.get(userId),
    server.ctx.repos.tenants.get(tenantId),
  ]);
  return { user: user!, tenant: tenant!, role, scopes, via: 'oauth', clientId: 'test-client' };
}

let rpcId = 0;
async function rpcCall(url: string, key: string, method: string, params?: DataObject) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  return (await res.json()) as { result?: any; error?: { code: number; message: string } };
}

/** one tool call: the parsed value, or the error text */
async function call(user: { url: string; key: string }, name: string, args: DataObject = {}) {
  const body = await rpcCall(user.url, user.key, 'tools/call', { name, arguments: args });
  if (body.error)
    return { rpcError: body.error, isError: true, text: body.error.message, value: undefined as any };
  const text = (body.result.content ?? []).map((p: { text?: string }) => p.text ?? '').join('');
  if (body.result.isError) return { isError: true, text, value: undefined as any };
  return { isError: false, text, value: JSON.parse(text) };
}

async function ok(user: { url: string; key: string }, name: string, args: DataObject = {}) {
  const result = await call(user, name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.text}`);
  return result.value;
}

async function webhookWorkflow(client: TestClient, settings: DataObject = { availableInMCP: true }) {
  return createWorkflow(client, {
    name: `Hook ${randomUUID().slice(0, 8)}`,
    nodes: [
      node('Webhook', 'core.webhook', { path: `w-${randomUUID().slice(0, 8)}`, httpMethod: 'POST' }, [0, 0], {
        webhookId: randomUUID(),
      }),
      setNode('Set', 'greeting', 'hello'),
    ],
    connections: chain('Webhook', 'Set'),
    settings,
  });
}

describe('tool table (drift)', () => {
  it('every own tool has a scope and a role, and the names match the expected list', () => {
    const tools = ownTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.scopes.length, tool.name).toBeGreaterThan(0);
      for (const scope of tool.scopes) expect(MCP_SCOPES as readonly string[]).toContain(scope);
      expect(ROLES, tool.name).toContain(tool.minRole);
      expect(tool.scopes, tool.name).toContain(EXPECTED[tool.name].scope);
      expect(tool.minRole, tool.name).toBe(EXPECTED[tool.name].minRole);
      expect(tool.description.length, tool.name).toBeGreaterThan(10);
      expect(mcpToolDescriptor(tool).inputSchema.type, tool.name).toBe('object');
      // read tools say so; a tool that a viewer may call never writes
      if (tool.minRole === 'viewer') expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });

  it('role matrix: a role sees exactly the tools whose minRole it meets', async () => {
    const user = await signup();
    for (const role of ROLES) {
      const c = await caller(user.tenant.id, user.user.id, role, [...MCP_SCOPES]);
      const listed = listMcpTools(c, server.ctx.config).filter((t) => !MCP_BUILDER_TOOLS.includes(t));
      const expected = Object.entries(EXPECTED)
        .filter(([, e]) => RANK[role] >= RANK[e.minRole])
        .map(([name]) => name)
        .sort();
      expect(listed.map((t) => t.name).sort(), role).toEqual(expected);
    }
  });

  it('scope matrix: one scope shows exactly the tools it unlocks; none shows nothing', async () => {
    const user = await signup();
    for (const scope of MCP_SCOPES) {
      const c = await caller(user.tenant.id, user.user.id, 'owner', [scope]);
      const listed = listMcpTools(c, server.ctx.config).filter((t) => !MCP_BUILDER_TOOLS.includes(t));
      const expected = ownTools()
        .filter((t) => t.scopes.includes(scope))
        .map((t) => t.name)
        .sort();
      expect(listed.map((t) => t.name).sort(), scope).toEqual(expected);
    }
    const none = await caller(user.tenant.id, user.user.id, 'owner', []);
    expect(listMcpTools(none, server.ctx.config)).toEqual([]);
  });

  it('build tools are left out when MCP_BUILDER_ENABLED is false', async () => {
    const user = await signup();
    const c = await caller(user.tenant.id, user.user.id, 'owner', [...MCP_SCOPES]);
    const off = { ...server.ctx.config, mcp: { ...server.ctx.config.mcp, builderEnabled: false } };
    const listed = listMcpTools(c, off);
    for (const tool of MCP_BUILDER_TOOLS) expect(listed).not.toContain(tool);
    expect(listed.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('the call path checks role and scope again (a hidden tool is refused when called)', async () => {
    const user = await signup();
    const wf = await webhookWorkflow(user.client);
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
          resource: user.url,
        })
      ).body as { result?: any; error?: { code: number; message: string } };
    const viewer = await caller(user.tenant.id, user.user.id, 'viewer', [...MCP_SCOPES]);
    expect((await send(viewer, 'publish_workflow', { workflowId: wf.id })).error).toEqual({
      code: -32602,
      message: 'You do not have access to the tool publish_workflow',
    });
    const tagsOnly = await caller(user.tenant.id, user.user.id, 'owner', ['tag:read']);
    expect((await send(tagsOnly, 'search_workflows', {})).error?.code).toBe(-32602);
    expect((await send(tagsOnly, 'list_workflow_tags', {})).result.isError).toBeUndefined();
    const row = await server.ctx.repos.workflows.get(user.tenant.id, wf.id);
    expect(row?.active).toBe(false);
  });

  it('a viewer key lists only read tools and cannot run or write over the endpoint', async () => {
    const owner = await signup();
    const viewer = await member(owner, 'viewer');
    const wf = await webhookWorkflow(owner.client);
    const listed = (await rpcCall(owner.url, viewer.key, 'tools/list')).result.tools.map(
      (t: { name: string }) => t.name,
    );
    // the own read tools plus L9's support tools (node search and details, format reference, validate):
    // read only, no write, no run, no secret
    const builderReadTools = [
      'get_node_types',
      'get_workflow_best_practices',
      'get_workflow_format_reference',
      'search_nodes',
      'validate_node_config',
      'validate_workflow',
    ];
    expect(listed.sort()).toEqual(
      [
        ...Object.entries(EXPECTED)
          .filter(([, e]) => e.minRole === 'viewer')
          .map(([name]) => name),
        ...builderReadTools,
      ].sort(),
    );
    for (const tool of MCP_BUILDER_TOOLS.filter((t) => builderReadTools.includes(t.name))) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
    const viewerAtOwner = { url: owner.url, key: viewer.key };
    const run = await call(viewerAtOwner, 'execute_workflow', { workflowId: wf.id, executionMode: 'manual' });
    expect(run.rpcError?.code).toBe(-32602);
    expect((await call(viewerAtOwner, 'get_workflow_details', { workflowId: wf.id })).isError).toBe(false);
    const editor = await member(owner, 'editor');
    expect(
      (await ok({ url: owner.url, key: editor.key }, 'publish_workflow', { workflowId: wf.id })).active,
    ).toBe(true);
  });
});

describe('workflow gate and tenant isolation', () => {
  it("a flagged-off, an archived and another tenant's workflow are refused with n8n's texts", async () => {
    const user = await signup();
    const other = await signup();
    const off = await webhookWorkflow(user.client, {});
    const archived = await webhookWorkflow(user.client);
    await user.client.data(user.client.post(`/rest/workflows/${archived.id}/archive`));
    const foreign = await webhookWorkflow(other.client);
    for (const name of [
      'get_workflow_details',
      'get_workflow_history',
      'publish_workflow',
      'prepare_workflow_pin_data',
    ]) {
      expect((await call(user, name, { workflowId: off.id })).text, name).toContain(
        MCP_WORKFLOW_TEXTS.notAvailable,
      );
      expect((await call(user, name, { workflowId: archived.id })).text, name).toContain(
        MCP_WORKFLOW_TEXTS.archived(archived.id),
      );
      expect((await call(user, name, { workflowId: foreign.id })).text, name).toContain(
        MCP_WORKFLOW_TEXTS.notFound,
      );
    }
    expect(
      (await call(user, 'execute_workflow', { workflowId: off.id, executionMode: 'manual' })).text,
    ).toContain(MCP_WORKFLOW_TEXTS.notAvailable);
    // search shows the flag, never another tenant's workflow, and no archived one
    const search = await ok(user, 'search_workflows', {});
    const flags = Object.fromEntries(
      search.data.map((w: { id: string; availableInMCP: boolean }) => [w.id, w.availableInMCP]),
    );
    expect(flags[off.id]).toBe(false);
    expect(flags[foreign.id]).toBeUndefined();
    expect(flags[archived.id]).toBeUndefined();
    // another tenant's data table id reads as missing
    const table = await ok(other, 'create_data_table', { name: `t${randomUUID().slice(0, 6)}`, columns: [] });
    const foreignRows = await call(user, 'get_data_table_rows', { dataTableId: table.id });
    expect(foreignRows.isError).toBe(true);
    expect(foreignRows.text).toMatch(/could not be found/);
  });
});

describe('tools', () => {
  it('details sanitize node credentials; history, version and diff; publish and unpublish', async () => {
    const user = await signup();
    const wf = await webhookWorkflow(user.client);
    // a credential slot with an extra field (written past the API) must come back as { id, name } only
    const row = await server.ctx.repos.workflows.get(user.tenant.id, wf.id);
    const nodes = (row!.nodes as DataObject[]).map((n) =>
      n.name === 'Set'
        ? { ...n, credentials: { httpHeaderAuth: { id: 'c1', name: 'Key', data: 'leak-me' } } }
        : n,
    );
    await server.ctx.database.db
      .update(workflows)
      .set({ nodes })
      .where(and(eq(workflows.tenantId, user.tenant.id), eq(workflows.id, wf.id)));
    const details = await ok(user, 'get_workflow_details', { workflowId: wf.id });
    expect(JSON.stringify(details)).not.toContain('leak-me');
    const set = details.workflow.nodes.find((n: { name: string }) => n.name === 'Set');
    expect(set.credentials).toEqual({ httpHeaderAuth: { id: 'c1', name: 'Key' } });
    expect(details.workflow.availableInMCP).toBe(true);
    expect(details.triggerInfo.triggers).toEqual([
      { name: 'Webhook', type: 'core.webhook', disabled: false, kind: 'webhook', supported: true },
    ]);

    const first = await user.client.data(user.client.get(`/rest/workflows/${wf.id}`));
    await user.client.data(
      user.client.patch(`/rest/workflows/${wf.id}`, { versionId: first.versionId, name: `${first.name} v2` }),
    );
    const history = await ok(user, 'get_workflow_history', { workflowId: wf.id });
    expect(history.data.length).toBeGreaterThanOrEqual(2);
    const oldest = history.data.at(-1).versionId;
    const version = await ok(user, 'get_workflow_version', { workflowId: wf.id, versionId: oldest });
    expect(version.versionId).toBe(oldest);
    expect(version.nodes.map((n: { name: string }) => n.name)).toContain('Webhook');
    const diff = await ok(user, 'get_workflow_versions_diff', { workflowId: wf.id, versionId: oldest });
    expect(diff).toMatchObject({ from: oldest, to: 'current' });
    expect(JSON.stringify(diff)).not.toContain('leak-me');
    expect(
      (
        await call(user, 'get_workflow_versions_diff', {
          workflowId: wf.id,
          versionId: oldest,
          compareTo: 'published',
        })
      ).text,
    ).toContain('no published version');

    expect((await ok(user, 'publish_workflow', { workflowId: wf.id })).active).toBe(true);
    expect((await ok(user, 'unpublish_workflow', { workflowId: wf.id })).active).toBe(false);
  });

  it('execute_workflow trigger rules; test_workflow with pin data; prepare_workflow_pin_data', async () => {
    const user = await signup();
    const manual = await createWorkflow(user.client, {
      name: 'Manual',
      nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'n', 1)],
      connections: chain('Start', 'Set'),
      settings: { availableInMCP: true },
    });
    expect(
      (await call(user, 'execute_workflow', { workflowId: manual.id, executionMode: 'production' })).text,
    ).toContain('has no published (active) version');
    // executionMode is required (as n8n): no default to a live run
    const noMode = await call(user, 'execute_workflow', { workflowId: manual.id });
    expect(noMode.isError).toBe(true);
    expect(noMode.text).toContain('executionMode');
    const started = await ok(user, 'execute_workflow', { workflowId: manual.id, executionMode: 'manual' });
    expect((await waitForExecution(server.ctx, user.tenant.id, started.executionId)).status).toBe('success');
    expect(
      (
        await call(user, 'execute_workflow', {
          workflowId: manual.id,
          executionMode: 'manual',
          inputs: { type: 'chat', chatInput: 'hi' },
        })
      ).text,
    ).toContain('does not take chat inputs');

    const two = await createWorkflow(user.client, {
      name: 'Two triggers',
      nodes: [
        node(
          'Hook A',
          'core.webhook',
          { path: `a-${randomUUID().slice(0, 6)}`, httpMethod: 'POST' },
          [0, 0],
          { webhookId: randomUUID() },
        ),
        node(
          'Hook B',
          'core.webhook',
          { path: `b-${randomUUID().slice(0, 6)}`, httpMethod: 'POST' },
          [0, 200],
          { webhookId: randomUUID() },
        ),
        node('Start', 'core.manualTrigger', {}, [0, 400]),
        setNode('Set', 'n', 1),
      ],
      connections: { ...chain('Hook A', 'Set'), ...chain('Hook B', 'Set') },
      settings: { availableInMCP: true },
    });
    expect(
      (await call(user, 'execute_workflow', { workflowId: two.id, executionMode: 'manual' })).text,
    ).toContain('several triggers');
    expect(
      (
        await call(user, 'execute_workflow', {
          workflowId: two.id,
          executionMode: 'manual',
          triggerNodeName: 'Nope',
        })
      ).text,
    ).toContain("Trigger node 'Nope' was not found");
    await user.client.data(user.client.post(`/rest/workflows/${two.id}/activate`));
    expect(
      (
        await call(user, 'execute_workflow', {
          workflowId: two.id,
          executionMode: 'production',
          triggerNodeName: 'Start',
        })
      ).text,
    ).toContain('runs in manual mode only');
    const b = await ok(user, 'execute_workflow', {
      workflowId: two.id,
      executionMode: 'production',
      triggerNodeName: 'Hook B',
      inputs: { type: 'webhook', webhookData: { body: { via: 'b' } } },
    });
    const bRun = await waitForExecution(server.ctx, user.tenant.id, b.executionId);
    expect([bRun.status, bRun.mode]).toEqual(['success', 'webhook']);
    // a form trigger runs in production with the mode n8n gives it: trigger
    const form = await createWorkflow(user.client, {
      name: 'Form',
      nodes: [
        node(
          'Form',
          'core.formTrigger',
          {
            formTitle: 'Sign up',
            path: `f-${randomUUID().slice(0, 6)}`,
            formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] },
          },
          [0, 0],
          { webhookId: randomUUID() },
        ),
        setNode('Set', 'n', 1),
      ],
      connections: chain('Form', 'Set'),
      settings: { availableInMCP: true },
    });
    await user.client.data(user.client.post(`/rest/workflows/${form.id}/activate`));
    const formRun = await ok(user, 'execute_workflow', {
      workflowId: form.id,
      executionMode: 'production',
      inputs: { type: 'form', formData: { Name: 'Ada' } },
    });
    const formRow = await waitForExecution(server.ctx, user.tenant.id, formRun.executionId);
    expect([formRow.status, formRow.mode]).toEqual(['success', 'trigger']);

    const credential = await user.client.data(
      user.client.post('/rest/credentials', {
        name: 'Key',
        type: 'httpHeaderAuth',
        data: { name: 'X-Key', value: 'v' },
      }),
    );
    const pinned = await createWorkflow(user.client, {
      name: 'Pinned',
      nodes: [
        node(
          'Webhook',
          'core.webhook',
          { path: `p-${randomUUID().slice(0, 6)}`, httpMethod: 'POST' },
          [0, 0],
          { webhookId: randomUUID() },
        ),
        setNode('Set', 'greeting', 'hello'),
        node('Call', 'core.httpRequest', { url: 'http://127.0.0.1:9/never' }, [400, 0], {
          credentials: { httpHeaderAuth: { id: credential.id, name: 'Key' } },
        }),
      ],
      connections: { ...chain('Webhook', 'Set', 'Call') },
      settings: { availableInMCP: true },
    });
    const prepared = await ok(user, 'prepare_workflow_pin_data', { workflowId: pinned.id });
    expect(prepared.nodes.map((n: { name: string; reason: string }) => [n.name, n.reason])).toEqual([
      ['Webhook', 'trigger'],
      ['Call', 'credentials'],
    ]);
    expect(prepared.template).toEqual({ Webhook: [{}], Call: [{}] });
    const tested = await ok(user, 'test_workflow', {
      workflowId: pinned.id,
      pinData: { Webhook: [{ body: { pinned: true } }], Call: [{ status: 'pinned' }] },
    });
    expect(tested).toMatchObject({ status: 'success', timedOut: false });
    const result = await ok(user, 'get_workflow_execution', {
      workflowId: pinned.id,
      executionId: tested.executionId,
      includeData: true,
      truncateData: 1,
    });
    expect(result.data.nodes.Call[0].data.main[0][0]).toEqual({ status: 'pinned' });
    expect(result.data.nodes.Set[0].data.main[0][0]).toMatchObject({ greeting: 'hello' });
    expect(
      (await call(user, 'test_workflow', { workflowId: pinned.id, pinData: { Ghost: [{}] } })).text,
    ).toContain("Node 'Ghost' was not found");

    // executions: one workflow's list, all exposed ones, and an execution of another workflow is not found
    const listed = await ok(user, 'search_workflow_executions', { workflowId: pinned.id });
    expect(listed.data.map((e: { id: string }) => e.id)).toEqual([tested.executionId]);
    const all = await ok(user, 'search_workflow_executions', { status: ['success'] });
    expect(all.data.map((e: { id: string }) => e.id)).toEqual(
      expect.arrayContaining([tested.executionId, b.executionId]),
    );
    const wrong = await call(user, 'get_workflow_execution', {
      workflowId: manual.id,
      executionId: tested.executionId,
    });
    expect(wrong.text).toContain('not found for this workflow');
  });

  it('credentials (id, name, type only), tags, data tables and folders', async () => {
    const user = await signup();
    await user.client.data(
      user.client.post('/rest/credentials', {
        name: 'Hdr',
        type: 'httpHeaderAuth',
        data: { name: 'X', value: 'y' },
      }),
    );
    const credentials = await ok(user, 'list_credentials', {});
    expect(credentials.data).toEqual([{ id: expect.any(String), name: 'Hdr', type: 'httpHeaderAuth' }]);
    expect((await ok(user, 'list_credentials', { type: 'httpBasicAuth' })).data).toEqual([]);

    await user.client.data(user.client.post('/rest/tags', { name: 'ops' }));
    expect((await ok(user, 'list_workflow_tags', {})).data.map((t: { name: string }) => t.name)).toEqual([
      'ops',
    ]);

    const table = await ok(user, 'create_data_table', {
      name: 'orders',
      columns: [{ name: 'item', type: 'string' }],
    });
    expect(table.columns.map((c: { name: string }) => c.name)).toEqual(['item']);
    expect((await ok(user, 'rename_data_table', { dataTableId: table.id, name: 'orders2' })).name).toBe(
      'orders2',
    );
    const qty = await ok(user, 'add_data_table_column', {
      dataTableId: table.id,
      name: 'qty',
      type: 'number',
    });
    const renamed = await ok(user, 'rename_data_table_column', {
      dataTableId: table.id,
      columnId: qty.id,
      name: 'count',
    });
    expect(renamed.name).toBe('count');
    await ok(user, 'add_data_table_rows', {
      dataTableId: table.id,
      rows: [
        { item: 'pen', count: 2 },
        { item: 'cup', count: 1 },
      ],
    });
    const rows = await ok(user, 'get_data_table_rows', {
      dataTableId: table.id,
      filter: { type: 'and', filters: [{ columnName: 'item', condition: 'eq', value: 'pen' }] },
    });
    expect(rows.data.map((r: { item: string; count: number }) => [r.item, r.count])).toEqual([['pen', 2]]);
    await ok(user, 'delete_data_table_column', { dataTableId: table.id, columnId: qty.id });
    const found = await ok(user, 'search_data_tables', { query: 'orders' });
    expect(found.data.map((t: { id: string }) => t.id)).toEqual([table.id]);
    expect(found.data[0].columns.map((c: { name: string }) => c.name)).toEqual(['item']);

    const parent = await ok(user, 'create_folder', { name: 'Parent' });
    const child = await ok(user, 'create_folder', { name: 'Child', parentFolderId: parent.id });
    expect((await ok(user, 'update_folder', { folderId: child.id, name: 'Kid' })).name).toBe('Kid');
    expect((await call(user, 'update_folder', { folderId: child.id })).text).toContain('Nothing to update');
    const folders = await ok(user, 'search_folders', { parentFolderId: parent.id });
    expect(folders.data.map((f: { name: string }) => f.name)).toEqual(['Kid']);
    const wf = await webhookWorkflow(user.client);
    const hidden = await webhookWorkflow(user.client, {});
    const moved = await ok(user, 'move_workflows_to_folder', { workflowIds: [wf.id], folderId: child.id });
    expect(moved.moved).toEqual([wf.id]);
    expect(
      (await call(user, 'move_workflows_to_folder', { workflowIds: [hidden.id], folderId: child.id })).text,
    ).toContain(MCP_WORKFLOW_TEXTS.notAvailable);
    expect((await server.ctx.repos.workflows.get(user.tenant.id, hidden.id))?.folderId).toBeNull();
  });

  it('each call writes the audit row mcp.tool_called with the tool name and no arguments', async () => {
    const user = await signup();
    await ok(user, 'search_workflows', { query: 'needle-text-123' });
    const rows = await server.ctx.repos.audit.list(user.tenant.id, 50);
    const row = rows.find((r) => r.action === 'mcp.tool_called');
    expect(row).toMatchObject({
      resourceType: 'mcp_tool',
      resourceId: 'search_workflows',
      userId: user.user.id,
    });
    expect(row?.metadata).toEqual({ tool: 'search_workflows', via: 'key' });
    expect(JSON.stringify(rows)).not.toContain('needle-text-123');
  });
});
