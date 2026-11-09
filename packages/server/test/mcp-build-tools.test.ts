/**
 * P5-13 MCP build tools against the real app on a free port: names, scope and role of each tool (the
 * drift check L8's loops leave out), the role and scope matrix, `MCP_BUILDER_ENABLED` off, a real client
 * that builds a workflow (client 2.4.0 for 2026-07-28, sdk 1.32.2 for the 2025 fallback), refusals with
 * issues, unknown node types (no path lookup), credentials of another workspace (also through an
 * expression `authentication` and inside inline `workflowJson`), update with a stale version and every
 * operation type, archive and restore, `explore_node_resources`, and a seeded secret that no build tool
 * output may contain.
 */
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as SdkStreamable } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DataObject, Scope, WorkflowDefinition } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '../src/db/schema';
import { handleMcpRequest, listMcpTools, mcpToolDescriptor, mcpToolTable } from '../src/services/mcp/server';
import { MCP_BUILDER_TOOLS } from '../src/services/mcp/tools/builder';
import { assertCredentialsInTenant } from '../src/services/mcp/tools/builder/credential-check';
import { UPDATE_OPERATION_TYPES } from '../src/services/mcp/tools/builder/update';
import {
  MCP_KEY_AUDIENCE,
  MCP_KEY_LABEL,
  MCP_SCOPES,
  type McpCaller,
  type McpScope,
} from '../src/services/mcp/types';
import { MCP_WORKFLOW_TEXTS } from '../src/services/mcp/workflow-gate';
import { chain, node, setNode, startMcpTestServer, TestClient, type TestServer } from './helpers';

let server: TestServer & { url: string; port: number };

beforeAll(async () => {
  server = await startMcpTestServer({ MCP_ACCESS_ENABLED: 'true', MCP_SERVER_RATE_LIMIT: '100000' });
});
afterAll(async () => {
  await server?.close();
});

/** the expected table: the grant scopes that unlock the tool, its `access` scope and `read`: a project viewer may call it (else it needs a project editor) */
const EXPECTED: Record<string, { scopes: McpScope[]; access: Scope; read: boolean }> = {
  search_nodes: { scopes: ['workflow:read', 'workflow:write'], access: 'workflow:read', read: true },
  get_node_types: { scopes: ['workflow:read', 'workflow:write'], access: 'workflow:read', read: true },
  get_workflow_best_practices: {
    scopes: ['workflow:read', 'workflow:write'],
    access: 'workflow:read',
    read: true,
  },
  get_workflow_format_reference: {
    scopes: ['workflow:read', 'workflow:write'],
    access: 'workflow:read',
    read: true,
  },
  validate_workflow: { scopes: ['workflow:read', 'workflow:write'], access: 'workflow:read', read: true },
  validate_node_config: { scopes: ['workflow:read', 'workflow:write'], access: 'workflow:read', read: true },
  create_workflow: { scopes: ['workflow:write'], access: 'workflow:create', read: false },
  update_workflow: { scopes: ['workflow:write'], access: 'workflow:update', read: false },
  archive_workflow: { scopes: ['workflow:write'], access: 'workflow:delete', read: false },
  restore_workflow_version: { scopes: ['workflow:write'], access: 'workflow:update', read: false },
  explore_node_resources: { scopes: ['credential:read'], access: 'credential:read', read: false },
};
/** P6-39: the workspace roles (the old `editor` and `viewer` are members with a project role) */
const ROLES: Role[] = ['member', 'admin', 'owner'];

async function signup() {
  // signup allows 20 calls an hour per IP: every workspace comes from its own address
  const client = new TestClient(
    server.app,
    server.url,
    `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`,
  );
  const id = randomUUID().slice(0, 8);
  const res = await client.post('/rest/auth/signup', {
    email: `mcp-build-${id}@example.com`,
    password: 'Passw0rd!',
    name: `Build ${id}`,
    workspaceName: `Build ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as { user: { id: string }; tenant: { id: string; slug: string } };
  const key = (
    await server.ctx.auth.createApiKey(data.tenant.id, data.user.id, MCP_KEY_LABEL, [], MCP_KEY_AUDIENCE)
  ).key;
  return { client, ...data, key, url: `${server.url}/mcp-server/${data.tenant.slug}/http` };
}
type User = Awaited<ReturnType<typeof signup>>;

/** a user of `owner`'s workspace with `role` and an MCP key */
async function member(owner: User, role: Role) {
  const other = await signup();
  // P6-39: the old names are a `member` holding that project role on the owner's team project, and no project of
  // its own; any other role is the workspace role
  const projectRole = role === 'editor' || role === 'viewer' ? `project:${role}` : undefined;
  await server.ctx.repos.memberships.add(owner.tenant.id, other.user.id, projectRole ? 'member' : role);
  if (projectRole) {
    const team =
      (await server.ctx.repos.projects.oldestTeam(owner.tenant.id)) ??
      (await server.ctx.repos.projects.create(owner.tenant.id, { name: 'Team', type: 'team' }));
    await server.ctx.repos.projects.relations.add(owner.tenant.id, team.id, other.user.id, projectRole);
  }
  const key = (
    await server.ctx.auth.createApiKey(owner.tenant.id, other.user.id, MCP_KEY_LABEL, [], MCP_KEY_AUDIENCE)
  ).key;
  return { ...other, key, url: owner.url };
}

async function caller(tenantId: string, userId: string, role: Role, scopes: McpScope[]): Promise<McpCaller> {
  const [user, tenant] = await Promise.all([
    server.ctx.repos.users.get(userId),
    server.ctx.repos.tenants.get(tenantId),
  ]);
  const globalScopes = await server.ctx.access.globalScopes(tenantId, role);
  return { user: user!, tenant: tenant!, role, globalScopes, scopes, via: 'oauth', clientId: 'test-client' };
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
  // the server writes "<tool>: <message>" for a refusal; the tests read the message
  if (body.result.isError) {
    return {
      isError: true,
      text: text.startsWith(`${name}: `) ? text.slice(name.length + 2) : text,
      value: undefined as any,
    };
  }
  return { isError: false, text, value: JSON.parse(text) };
}

async function ok(user: { url: string; key: string }, name: string, args: DataObject = {}) {
  const result = await call(user, name, args);
  if (result.isError) throw new Error(`${name} failed: ${result.text}`);
  return result.value;
}

/** a valid definition: Webhook -> Set, as `create_workflow` takes it */
function definition(name = `Built ${randomUUID().slice(0, 8)}`, settings?: DataObject) {
  return {
    name,
    nodes: [
      node('Webhook', 'core.webhook', { path: `b-${randomUUID().slice(0, 8)}`, httpMethod: 'POST' }, [0, 0]),
      setNode('Set', 'greeting', 'hello'),
    ],
    connections: chain('Webhook', 'Set'),
    ...(settings ? { settings } : {}),
  };
}

async function created(user: User, workflow = definition()) {
  const result = await ok(user, 'create_workflow', { workflow });
  return result as {
    workflowId: string;
    versionId: string;
    name: string;
    availableInMCP: boolean;
    issues: any[];
  };
}

async function details(user: User, workflowId: string) {
  return (await ok(user, 'get_workflow_details', { workflowId })).workflow as {
    versionId: string;
    name: string;
    nodes: Array<{
      id: string;
      name: string;
      type: string;
      parameters: any;
      credentials?: any;
      disabled?: boolean;
    }>;
    connections: Record<string, any>;
    settings: Record<string, any>;
    tags: Array<{ id: string; name: string }>;
  };
}

async function workflowCount(user: User) {
  return (await server.ctx.repos.workflows.list(user.tenant.id, { limit: 500 })).length;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe('tool table (drift)', () => {
  it('names, scopes, roles and schemas of the build tools', () => {
    const tools = MCP_BUILDER_TOOLS;
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.scopes, tool.name).toEqual(EXPECTED[tool.name].scopes);
      expect(tool.access, tool.name).toBe(EXPECTED[tool.name].access);
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(mcpToolDescriptor(tool).inputSchema.type, tool.name).toBe('object');
      // a tool a viewer may call never writes; a write tool says it is not read only
      if (EXPECTED[tool.name].read) expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      if (tool.scopes.includes('workflow:write') && tool.scopes.length === 1) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
      }
    }
    // the table L8 serves ends with this list
    expect(mcpToolTable().slice(-tools.length)).toEqual(tools);
  });

  it('update_workflow has about 25 operation types, all different', () => {
    expect(UPDATE_OPERATION_TYPES.length).toBeGreaterThanOrEqual(25);
    expect(new Set(UPDATE_OPERATION_TYPES).size).toBe(UPDATE_OPERATION_TYPES.length);
    for (const kind of ['addNode', 'connect', 'setNodeCredential', 'setSettings', 'addTag', 'addGroup']) {
      expect(UPDATE_OPERATION_TYPES).toContain(kind);
    }
  });

  it('role matrix: a role sees the build tools whose access scope it holds (a user with no project of its own)', async () => {
    const user = await signup();
    // a user with no relation in this workspace: only the role's workspace scopes count
    const stranger = await signup();
    for (const role of ROLES) {
      const c = await caller(user.tenant.id, stranger.user.id, role, [...MCP_SCOPES]);
      const held = await server.ctx.access.globalScopes(user.tenant.id, role);
      const listed = (await listMcpTools(server.ctx, c))
        .filter((t) => MCP_BUILDER_TOOLS.includes(t))
        .map((t) => t.name)
        .sort();
      const expected = Object.entries(EXPECTED)
        .filter(([, e]) => held.has(e.access))
        .map(([name]) => name)
        .sort();
      expect(listed, role).toEqual(expected);
    }
  });

  it('scope matrix: workflow:read shows only the support tools, workflow:write all but explore', async () => {
    const user = await signup();
    const names = async (scopes: McpScope[]) =>
      (await listMcpTools(server.ctx, await caller(user.tenant.id, user.user.id, 'owner', scopes)))
        .filter((t) => MCP_BUILDER_TOOLS.includes(t))
        .map((t) => t.name)
        .sort();
    const support = Object.entries(EXPECTED)
      .filter(([, e]) => e.read)
      .map(([name]) => name)
      .sort();
    expect(await names(['workflow:read'])).toEqual(support);
    expect(await names(['workflow:write'])).toEqual(
      Object.keys(EXPECTED)
        .filter((n) => n !== 'explore_node_resources')
        .sort(),
    );
    expect(await names(['credential:read'])).toEqual(['explore_node_resources']);
    expect(await names(['tag:read', 'execution:read'])).toEqual([]);
  });

  it('none is listed or callable when MCP_BUILDER_ENABLED is false', async () => {
    const user = await signup();
    const c = await caller(user.tenant.id, user.user.id, 'owner', [...MCP_SCOPES]);
    const off = { ...server.ctx.config, mcp: { ...server.ctx.config.mcp, builderEnabled: false } };
    const listed = await listMcpTools({ ...server.ctx, config: off }, c);
    for (const tool of MCP_BUILDER_TOOLS) expect(listed).not.toContain(tool);
    expect(listed.length).toBeGreaterThan(0);
    const reply = await handleMcpRequest(
      { ...server.ctx, config: off },
      {
        caller: c,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'search_nodes', arguments: { queries: ['webhook'] } },
        }),
        headers: {},
        resource: user.url,
      },
    );
    expect((reply.body as { error?: { code: number } }).error?.code).toBe(-32602);
  });

  it('a viewer key sees the support tools only, and a write tool called by name is refused', async () => {
    const owner = await signup();
    const viewer = await member(owner, 'viewer');
    const listed = await rpcCall(owner.url, viewer.key, 'tools/list');
    const names = listed.result.tools.map((t: { name: string }) => t.name);
    // P6-39: a project viewer reads the project's credentials (n8n), so it may explore node resources too
    for (const name of [
      'search_nodes',
      'validate_workflow',
      'get_workflow_format_reference',
      'explore_node_resources',
    ]) {
      expect(names).toContain(name);
    }
    for (const name of [
      'create_workflow',
      'update_workflow',
      'archive_workflow',
      'restore_workflow_version',
    ]) {
      expect(names).not.toContain(name);
    }
    const refused = await call({ url: owner.url, key: viewer.key }, 'create_workflow', {
      workflow: definition(),
    });
    expect(refused.rpcError).toEqual({
      code: -32602,
      message: 'You do not have access to the tool create_workflow',
    });
    expect(await workflowCount(owner)).toBe(0);
    // a viewer can search and validate
    const found = await ok({ url: owner.url, key: viewer.key }, 'search_nodes', { queries: ['webhook'] });
    expect(found.results[0].results.map((r: { type: string }) => r.type)).toContain('core.webhook');
  });
});

describe('real clients', () => {
  it('2026 client: searches a node, creates a workflow, reads it back and validates it', async () => {
    const user = await signup();
    const client = new Client(
      { name: 'build-modern', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(user.url), { requestInit: { headers: bearer(user.key) } }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(Object.keys(EXPECTED)));
      const json = (r: unknown) =>
        JSON.parse(
          ((r as { content: Array<{ text?: string }> }).content ?? []).map((p) => p.text ?? '').join(''),
        );
      const search = json(
        await client.callTool({ name: 'search_nodes', arguments: { queries: ['webhook'] } }),
      );
      expect(search.results[0].results.map((r: { type: string }) => r.type)).toContain('core.webhook');
      const types = json(
        await client.callTool({
          name: 'get_node_types',
          arguments: { types: ['core.webhook', 'core.nope'] },
        }),
      );
      expect(types.nodeTypes[0].type).toBe('core.webhook');
      expect(types.unknown).toEqual(['core.nope']);

      const def = definition('Client built');
      const made = json(await client.callTool({ name: 'create_workflow', arguments: { workflow: def } }));
      expect(made.workflowId).toMatch(/^[0-9a-f-]{36}$/);
      expect(made.availableInMCP).toBe(true);
      const read = json(
        await client.callTool({ name: 'get_workflow_details', arguments: { workflowId: made.workflowId } }),
      );
      expect(read.workflow.name).toBe('Client built');
      expect(read.workflow.nodes.map((n: { name: string }) => n.name)).toEqual(['Webhook', 'Set']);
      // the server gave the webhook its own id
      const row = await server.ctx.repos.workflows.get(user.tenant.id, made.workflowId);
      const stored = (row!.nodes as Array<{ name: string; webhookId?: string }>).find(
        (n) => n.name === 'Webhook',
      );
      expect(stored?.webhookId).toMatch(/^[0-9a-f-]{36}$/);

      const valid = json(
        await client.callTool({ name: 'validate_workflow', arguments: { workflowId: made.workflowId } }),
      );
      expect(valid.valid).toBe(true);
      const row2 = await server.ctx.repos.workflows.get(user.tenant.id, made.workflowId);
      expect(row2?.createdBy).toBe(user.user.id);
    } finally {
      await client.close();
    }
  });

  it('2025 client (sdk 1.32.2): lists the build tools, updates and archives a workflow', async () => {
    const user = await signup();
    const client = new SdkClient({ name: 'build-legacy', version: '1.0.0' });
    await client.connect(
      new SdkStreamable(new URL(user.url), { requestInit: { headers: bearer(user.key) } }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(Object.keys(EXPECTED)));
      const json = (r: unknown) =>
        JSON.parse(
          ((r as { content: Array<{ text?: string }> }).content ?? []).map((p) => p.text ?? '').join(''),
        );
      const made = json(
        await client.callTool({ name: 'create_workflow', arguments: { workflow: definition() } }),
      );
      const updated = json(
        await client.callTool({
          name: 'update_workflow',
          arguments: {
            workflowId: made.workflowId,
            versionId: made.versionId,
            operations: [{ type: 'setWorkflowName', name: 'Renamed by sdk' }],
          },
        }),
      );
      expect(updated.name).toBe('Renamed by sdk');
      expect(updated.versionId).not.toBe(made.versionId);
      const archived = json(
        await client.callTool({ name: 'archive_workflow', arguments: { workflowId: made.workflowId } }),
      );
      expect(archived.archived).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('support tools', () => {
  it('search_nodes and get_node_types read the registry; an unknown name is not a lookup', async () => {
    const user = await signup();
    const search = await ok(user, 'search_nodes', { queries: ['webhook', 'set fields'] });
    expect(search.results).toHaveLength(2);
    expect(search.results[1].results.map((r: { type: string }) => r.type)).toContain('core.set');
    const types = await ok(user, 'get_node_types', { types: ['core.set'] });
    expect(types.nodeTypes[0]).toEqual(
      expect.objectContaining({ type: 'core.set', version: expect.any(Number) }),
    );
    expect(types.nodeTypes[0].properties.length).toBeGreaterThan(0);
    const unknown = await call(user, 'get_node_types', { types: ['../../etc/passwd'] });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Unknown node type');
    const empty = await call(user, 'search_nodes', { queries: [] });
    expect(empty.isError).toBe(true);
  });

  it('the format reference and the best practices are our own text', async () => {
    const user = await signup();
    const reference = await ok(user, 'get_workflow_format_reference');
    expect(reference.reference).toContain('"connections"');
    expect(reference.reference).toContain('create_workflow');
    const practices = await ok(user, 'get_workflow_best_practices');
    expect(practices.practices).toContain('search_nodes');
    // the text never names the other product
    expect(`${reference.reference}${practices.practices}`).not.toMatch(/n8n/i);
  });

  it('validate_workflow: a good definition, a bad one with issues, a saved draft, and one of another workspace', async () => {
    const user = await signup();
    const good = await ok(user, 'validate_workflow', { workflow: definition() });
    expect(good.valid).toBe(true);
    const bad = await ok(user, 'validate_workflow', { workflow: { name: 'x', nodes: [], connections: {} } });
    expect(bad.valid).toBe(false);
    expect(bad.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'workflow-has-no-nodes' })]),
    );
    const made = await created(user);
    expect((await ok(user, 'validate_workflow', { workflowId: made.workflowId })).valid).toBe(true);
    expect((await call(user, 'validate_workflow', {})).text).toContain('either');
    expect((await call(user, 'validate_workflow', { workflowId: randomUUID() })).text).toBe(
      MCP_WORKFLOW_TEXTS.notFound,
    );
    const other = await signup();
    expect((await call(other, 'validate_workflow', { workflowId: made.workflowId })).text).toBe(
      MCP_WORKFLOW_TEXTS.notFound,
    );
  });

  it('validate_node_config checks one node on its own', async () => {
    const user = await signup();
    const good = await ok(user, 'validate_node_config', {
      type: 'core.set',
      parameters: { mode: 'manual', assignments: { assignments: [] } },
    });
    expect(good.valid).toBe(true);
    expect(good.issues.every((i: { code?: string }) => i.code !== 'workflow-has-no-trigger')).toBe(true);
    const unknown = await call(user, 'validate_node_config', { type: 'core.unheard', parameters: {} });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Unknown node type');
    const version = await call(user, 'validate_node_config', { type: 'core.set', typeVersion: 99 });
    expect(version.isError).toBe(true);
  });
});

describe('create_workflow', () => {
  it('refuses a bad workflow with every issue and creates nothing', async () => {
    const user = await signup();
    const result = await call(user, 'create_workflow', {
      workflow: { name: 'Empty', nodes: [], connections: {} },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Nothing was created');
    expect(result.text).toContain('workflow-has-no-nodes');
    expect(await workflowCount(user)).toBe(0);
  });

  it('refuses an unknown node type, also a path, and nothing is loaded from it', async () => {
    const user = await signup();
    for (const type of [
      'core.doesNotExist',
      '../../../etc/passwd',
      'file:///tmp/evil.js',
      'node:fs',
      'C:\\evil\\node.js',
    ]) {
      const workflow = definition();
      workflow.nodes.push(node('Evil', type, {}, [400, 0]));
      const result = await call(user, 'create_workflow', { workflow });
      expect(result.isError, type).toBe(true);
      expect(result.text, type).toContain('Unknown node type');
    }
    expect(await workflowCount(user)).toBe(0);
  });

  it('refuses two nodes with one name', async () => {
    const user = await signup();
    const workflow = definition();
    workflow.nodes.push(setNode('Set', 'again', 'x'));
    const result = await call(user, 'create_workflow', { workflow });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Two nodes are named "Set"');
  });

  it('availableInMCP: on for the creating client with auto expose off, and a written false is kept', async () => {
    const user = await signup();
    const tenant = await server.ctx.repos.tenants.get(user.tenant.id);
    expect(
      (tenant!.settings as { mcp?: { autoExposeNewWorkflows?: boolean } }).mcp?.autoExposeNewWorkflows,
    ).not.toBe(true);
    const on = await created(user);
    expect(on.availableInMCP).toBe(true);
    const off = await created(user, definition('Hidden', { availableInMCP: false }));
    expect(off.availableInMCP).toBe(false);
    expect((await call(user, 'get_workflow_details', { workflowId: off.workflowId })).text).toBe(
      MCP_WORKFLOW_TEXTS.notAvailable,
    );
  });

  it("puts the workflow in a folder and gives it tags; another workspace's folder is not found", async () => {
    const user = await signup();
    const folder = await user.client.data<{ id: string }>(
      user.client.post('/rest/folders', { name: 'Built' }),
    );
    const tag = await user.client.data<{ id: string }>(user.client.post('/rest/tags', { name: 'mcp-built' }));
    const made = await ok(user, 'create_workflow', {
      workflow: definition(),
      folderId: folder.id,
      tagIds: [tag.id],
    });
    const row = await server.ctx.repos.workflows.get(user.tenant.id, made.workflowId);
    expect(row?.folderId).toBe(folder.id);
    expect((await details(user, made.workflowId)).tags.map((t) => t.id)).toEqual([tag.id]);
    const other = await signup();
    const foreign = await call(other, 'create_workflow', { workflow: definition(), folderId: folder.id });
    expect(foreign.isError).toBe(true);
  });

  it('writes the tool call and the created workflow to the audit log, without the arguments', async () => {
    const user = await signup();
    const made = await created(user, definition('Audit needle-9917'));
    const rows = await server.ctx.repos.audit.list(user.tenant.id, 50);
    expect(
      rows.find((r) => r.action === 'mcp.tool_called' && r.resourceId === 'create_workflow'),
    ).toBeTruthy();
    expect(
      rows.find((r) => r.action === 'workflow.created' && r.resourceId === made.workflowId),
    ).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain('needle-9917');
  });
});

describe('credentials of another workspace', () => {
  async function credentialOf(user: User, secret?: string) {
    return user.client.data<{ id: string; name: string }>(
      user.client.post('/rest/credentials', {
        name: `Cred ${randomUUID().slice(0, 6)}`,
        type: 'httpHeaderAuth',
        data: { name: 'X-Api-Key', value: secret ?? `v-${randomUUID()}` },
      }),
    );
  }

  const httpNode = (credentialId: string, parameters: DataObject = {}) =>
    node('Call', 'core.httpRequest', { url: 'http://127.0.0.1:9/never', ...parameters }, [400, 0], {
      credentials: { httpHeaderAuth: { id: credentialId, name: 'Theirs' } },
    });

  it("the workspace's own credential is accepted; another one's id is refused", async () => {
    const mine = await signup();
    const theirs = await signup();
    const own = await credentialOf(mine);
    const foreign = await credentialOf(theirs);
    const okWorkflow = definition();
    okWorkflow.nodes.push(httpNode(own.id));
    okWorkflow.connections = chain('Webhook', 'Set', 'Call');
    const made = await ok(mine, 'create_workflow', { workflow: okWorkflow });
    expect(
      (await details(mine, made.workflowId)).nodes.find((n) => n.name === 'Call')?.credentials.httpHeaderAuth
        .id,
    ).toBe(own.id);

    const bad = definition();
    bad.nodes.push(httpNode(foreign.id));
    bad.connections = chain('Webhook', 'Set', 'Call');
    const before = await workflowCount(mine);
    const refused = await call(mine, 'create_workflow', { workflow: bad });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(`Credential "${foreign.id}" was not found in this workspace`);
    expect(await workflowCount(mine)).toBe(before);
  });

  it('an expression as the authentication does not skip the check', async () => {
    const mine = await signup();
    const theirs = await signup();
    const foreign = await credentialOf(theirs);
    for (const authentication of [
      '={{ "predefinedCredentialType" }}',
      '={{ $json.auth }}',
      'genericCredentialType',
    ]) {
      const workflow = definition();
      workflow.nodes.push(httpNode(foreign.id, { authentication, genericAuthType: 'httpHeaderAuth' }));
      workflow.connections = chain('Webhook', 'Set', 'Call');
      const refused = await call(mine, 'create_workflow', { workflow });
      expect(refused.isError, authentication).toBe(true);
      expect(refused.text, authentication).toContain('was not found in this workspace');
    }
  });

  it('inline workflowJson is read as data and its credentials are checked', async () => {
    const mine = await signup();
    const theirs = await signup();
    const foreign = await credentialOf(theirs);
    const inner = JSON.stringify({
      nodes: [httpNode(foreign.id)],
      connections: {},
    });
    const workflow = definition();
    workflow.nodes.push(
      node('Sub', 'core.executeWorkflow', { source: 'parameter', workflowJson: inner }, [400, 0]),
    );
    workflow.connections = chain('Webhook', 'Set', 'Sub');
    const refused = await call(mine, 'create_workflow', { workflow });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('was not found in this workspace');
    // two levels down is checked as well
    const deeper = JSON.stringify({
      nodes: [node('Inner', 'core.executeWorkflow', { source: 'parameter', workflowJson: inner })],
      connections: {},
    });
    const workflow2 = definition();
    workflow2.nodes.push(
      node('Sub', 'core.executeWorkflow', { source: 'parameter', workflowJson: deeper }, [400, 0]),
    );
    workflow2.connections = chain('Webhook', 'Set', 'Sub');
    expect((await call(mine, 'create_workflow', { workflow: workflow2 })).text).toContain(
      'was not found in this workspace',
    );
  });

  it('assertCredentialsInTenant: first foreign ref throws, own and name-only refs pass, a bad shape is refused', async () => {
    const mine = await signup();
    const theirs = await signup();
    const own = await credentialOf(mine);
    const foreign = await credentialOf(theirs);
    const make = (credentials: unknown): WorkflowDefinition => ({
      name: 'x',
      nodes: [{ ...node('A', 'core.httpRequest', {}), credentials } as never],
      connections: {},
    });
    await expect(
      assertCredentialsInTenant(
        server.ctx,
        mine.tenant.id,
        make({ httpHeaderAuth: { id: own.id, name: 'a' } }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertCredentialsInTenant(
        server.ctx,
        mine.tenant.id,
        make({ httpHeaderAuth: { id: null, name: 'by name' } }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertCredentialsInTenant(
        server.ctx,
        mine.tenant.id,
        make({ httpHeaderAuth: { id: foreign.id, name: 'a' } }),
      ),
    ).rejects.toThrow('was not found in this workspace');
    await expect(
      assertCredentialsInTenant(
        server.ctx,
        mine.tenant.id,
        make({ httpHeaderAuth: { id: 'not-a-uuid', name: 'a' } }),
      ),
    ).rejects.toThrow('was not found in this workspace');
    await expect(
      assertCredentialsInTenant(server.ctx, mine.tenant.id, make({ httpHeaderAuth: { id: 7, name: 'a' } })),
    ).rejects.toThrow('credential reference');
    await expect(assertCredentialsInTenant(server.ctx, mine.tenant.id, make(['x']))).rejects.toThrow(
      'credential reference',
    );
  });

  it("update_workflow refuses another workspace's credential too, and setNodeCredential finds only its own", async () => {
    const mine = await signup();
    const theirs = await signup();
    const own = await credentialOf(mine);
    const foreign = await credentialOf(theirs);
    const workflow = definition();
    workflow.nodes.push(node('Call', 'core.httpRequest', { url: 'http://127.0.0.1:9/never' }, [400, 0]));
    workflow.connections = chain('Webhook', 'Set', 'Call');
    const made = await created(mine, workflow);

    const viaOperation = await call(mine, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [
        {
          type: 'setNodeCredential',
          name: 'Call',
          credentialType: 'httpHeaderAuth',
          credentialId: foreign.id,
        },
      ],
    });
    expect(viaOperation.isError).toBe(true);
    expect(viaOperation.text).toContain('was not found in this workspace');

    const viaNode = await call(mine, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [
        {
          type: 'addNode',
          node: {
            type: 'core.httpRequest',
            name: 'Other',
            credentials: { httpHeaderAuth: { id: foreign.id, name: 'x' } },
          },
        },
      ],
    });
    expect(viaNode.isError).toBe(true);
    expect(viaNode.text).toBe(`Credential "${foreign.id}" was not found in this workspace`);

    const viaSettingsInline = await call(mine, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [
        {
          type: 'setNodeParameters',
          name: 'Call',
          parameters: {
            source: 'parameter',
            workflowJson: JSON.stringify({ nodes: [httpNodeWith(foreign.id)], connections: {} }),
          },
        },
      ],
    });
    expect(viaSettingsInline.isError).toBe(true);
    expect(viaSettingsInline.text).toContain('was not found in this workspace');

    const good = await ok(mine, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [
        { type: 'setNodeCredential', name: 'Call', credentialType: 'httpHeaderAuth', credentialId: own.id },
      ],
    });
    const call2 = (await details(mine, made.workflowId)).nodes.find((n) => n.name === 'Call');
    expect(call2?.credentials.httpHeaderAuth).toEqual({ id: own.id, name: expect.any(String) });
    expect(good.versionId).not.toBe(made.versionId);
    // a credential of a wrong type for the slot
    const wrongType = await call(mine, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: good.versionId,
      operations: [
        { type: 'setNodeCredential', name: 'Call', credentialType: 'testApi', credentialId: own.id },
      ],
    });
    expect(wrongType.isError).toBe(true);
    expect(wrongType.text).toContain('is of type "httpHeaderAuth"');
  });
});

function httpNodeWith(credentialId: string) {
  return node('Call', 'core.httpRequest', { url: 'http://127.0.0.1:9/never' }, [400, 0], {
    credentials: { httpHeaderAuth: { id: credentialId, name: 'Theirs' } },
  });
}

describe('update_workflow', () => {
  it('refuses a stale version and a workflow of another workspace; saves nothing', async () => {
    const user = await signup();
    const made = await created(user);
    const first = await ok(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [{ type: 'setWorkflowName', name: 'Second' }],
    });
    const stale = await call(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [{ type: 'setWorkflowName', name: 'Third' }],
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain(`The workflow changed since version ${made.versionId}`);
    expect(stale.text).toContain(first.versionId);
    expect((await details(user, made.workflowId)).name).toBe('Second');

    // an output or input index past 31 is refused by the input schema
    for (const index of [{ outputIndex: 32 }, { inputIndex: 1000 }]) {
      for (const type of ['connect', 'disconnect']) {
        const tooFar = await call(user, 'update_workflow', {
          workflowId: made.workflowId,
          versionId: first.versionId,
          operations: [{ type, from: 'Webhook', to: 'Set', ...index }],
        });
        expect(tooFar.isError, `${type} ${JSON.stringify(index)}`).toBe(true);
      }
    }
    expect((await details(user, made.workflowId)).versionId).toBe(first.versionId);

    const other = await signup();
    const foreign = await call(other, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: first.versionId,
      operations: [{ type: 'setWorkflowName', name: 'Stolen' }],
    });
    expect(foreign.text).toBe(MCP_WORKFLOW_TEXTS.notFound);
    expect((await details(user, made.workflowId)).name).toBe('Second');
  });

  it('runs node, connection, parameter and note operations in order', async () => {
    const user = await signup();
    const made = await created(user);
    const result = await ok(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      message: 'built in steps',
      operations: [
        {
          type: 'addNode',
          node: {
            type: 'core.set',
            name: 'Second set',
            parameters: { mode: 'manual', assignments: { assignments: [] } },
          },
        },
        { type: 'connect', from: 'Set', to: 'Second set' },
        { type: 'setNodeParameters', name: 'Second set', parameters: { includeOtherFields: true } },
        { type: 'setNodePosition', name: 'Second set', position: [900, 40] },
        { type: 'setNodeNotes', name: 'Second set', notes: 'adds nothing', notesInFlow: true },
        {
          type: 'setNodeOptions',
          name: 'Second set',
          alwaysOutputData: true,
          onError: 'continueRegularOutput',
        },
        { type: 'setNodeDisabled', name: 'Second set', disabled: true },
        { type: 'renameNode', name: 'Second set', newName: 'Extra' },
      ],
    });
    expect(result.operationsApplied).toBe(8);
    expect(result.nodes.map((n: { name: string }) => n.name)).toEqual(['Webhook', 'Set', 'Extra']);
    const now = await details(user, made.workflowId);
    const extra = now.nodes.find((n) => n.name === 'Extra') as any;
    expect(extra.parameters.includeOtherFields).toBe(true);
    expect(extra.position).toEqual([900, 40]);
    expect(extra.notes).toBe('adds nothing');
    expect(extra.alwaysOutputData).toBe(true);
    expect(extra.onError).toBe('continueRegularOutput');
    expect(extra.disabled).toBe(true);
    expect(now.connections.Set.main[0][0].node).toBe('Extra');
    // the version history has the message
    const history = await ok(user, 'get_workflow_history', { workflowId: made.workflowId });
    expect(JSON.stringify(history)).toContain('built in steps');

    const second = await ok(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: result.versionId,
      operations: [
        { type: 'setNodeDisabled', name: 'Extra', disabled: false },
        { type: 'setNodeNotes', name: 'Extra', notes: null },
        {
          type: 'replaceNodeParameters',
          name: 'Extra',
          parameters: { mode: 'manual', assignments: { assignments: [] } },
        },
        { type: 'disconnect', from: 'Set', to: 'Extra' },
        { type: 'connect', from: 'Webhook', to: 'Extra' },
        { type: 'clearNodeConnections', name: 'Extra' },
        { type: 'removeNode', name: 'Extra' },
      ],
    });
    const after = await details(user, made.workflowId);
    expect(after.nodes.map((n) => n.name)).toEqual(['Webhook', 'Set']);
    expect(second.operationsApplied).toBe(7);
  });

  it('a failing operation saves none of the earlier ones and names itself', async () => {
    const user = await signup();
    const made = await created(user);
    const result = await call(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [
        { type: 'setWorkflowName', name: 'Half done' },
        { type: 'removeNode', name: 'No such node' },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'Operation 2 (removeNode) failed: There is no node named "No such node" Nothing was saved.',
    );
    const now = await details(user, made.workflowId);
    expect(now.name).not.toBe('Half done');
    expect(now.versionId).toBe(made.versionId);

    const unknownType = await call(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [{ type: 'addNode', node: { type: '../../evil' } }],
    });
    expect(unknownType.text).toContain('Unknown node type "../../evil"');
    const badOperation = await call(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [{ type: 'runCode', code: 'process.exit(1)' }],
    });
    expect(badOperation.isError).toBe(true);
    expect((await details(user, made.workflowId)).versionId).toBe(made.versionId);
  });

  it('refuses a change that makes the workflow invalid, with its issues', async () => {
    const user = await signup();
    const made = await created(user);
    const result = await call(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [
        { type: 'removeNode', name: 'Webhook' },
        { type: 'removeNode', name: 'Set' },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('The change makes the workflow invalid. Nothing was saved.');
    expect(result.text).toContain('workflow-has-no-nodes');
    expect((await details(user, made.workflowId)).nodes).toHaveLength(2);
  });

  it('settings, workflow name, pin data, tags and groups', async () => {
    const user = await signup();
    const tagA = await user.client.data<{ id: string }>(user.client.post('/rest/tags', { name: 'alpha' }));
    const tagB = await user.client.data<{ id: string }>(user.client.post('/rest/tags', { name: 'beta' }));
    const made = await created(user);
    const before = await details(user, made.workflowId);
    const setNodeRow = before.nodes[1];

    const one = await ok(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [
        {
          type: 'setSettings',
          settings: { timezone: 'Europe/Berlin', saveManualExecutions: false, executionTimeout: 30 },
        },
        { type: 'setPinData', name: 'Webhook', items: [{ json: { hello: 'pinned' } }] },
        { type: 'addTag', tag: 'alpha' },
        { type: 'addTag', tag: tagB.id },
        { type: 'addNode', node: { type: 'core.set', name: 'More' } },
        { type: 'connect', from: 'Set', to: 'More' },
        { type: 'addGroup', name: 'Intake', nodeNames: ['Set', 'More'], description: 'where it starts' },
      ],
    });
    let now = await details(user, made.workflowId);
    expect(now.settings).toEqual(
      expect.objectContaining({
        timezone: 'Europe/Berlin',
        saveManualExecutions: false,
        executionTimeout: 30,
        availableInMCP: true,
      }),
    );
    expect(now.tags.map((t) => t.name).sort()).toEqual(['alpha', 'beta']);
    let row = await server.ctx.repos.workflows.get(user.tenant.id, made.workflowId);
    expect((row!.pinData as any).Webhook[0].json.hello).toBe('pinned');
    expect((row!.nodeGroups as any[])[0]).toEqual(
      expect.objectContaining({
        name: 'Intake',
        nodeIds: [setNodeRow.id, expect.any(String)],
        description: 'where it starts',
      }),
    );

    const two = await ok(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: one.versionId,
      operations: [
        { type: 'setSettings', settings: { timezone: null, executionTimeout: 0 } },
        { type: 'clearPinData', name: 'Webhook' },
        { type: 'removeTag', tag: 'alpha' },
        { type: 'renameGroup', group: 'Intake', name: 'Start' },
        { type: 'removeNodesFromGroup', group: 'Start', nodeNames: ['Set'] },
        { type: 'addNodesToGroup', group: 'Start', nodeNames: ['Set'] },
      ],
    });
    now = await details(user, made.workflowId);
    expect(now.settings.timezone).toBeUndefined();
    expect(now.tags.map((t) => t.name)).toEqual(['beta']);
    row = await server.ctx.repos.workflows.get(user.tenant.id, made.workflowId);
    expect((row!.pinData as any).Webhook).toBeUndefined();
    expect((row!.nodeGroups as any[])[0].name).toBe('Start');

    const three = await ok(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: two.versionId,
      operations: [
        { type: 'setTags', tags: [tagA.id] },
        { type: 'removeGroup', group: 'Start' },
      ],
    });
    now = await details(user, made.workflowId);
    expect(now.tags.map((t) => t.id)).toEqual([tagA.id]);
    row = await server.ctx.repos.workflows.get(user.tenant.id, made.workflowId);
    expect(row!.nodeGroups).toEqual([]);
    expect(three.operationsApplied).toBe(2);

    // an unknown tag and a setting that is not valid are named
    const noTag = await call(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: three.versionId,
      operations: [{ type: 'addTag', tag: 'nonexistent' }],
    });
    expect(noTag.text).toContain('There is no tag "nonexistent"');
    const badSetting = await call(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: three.versionId,
      operations: [{ type: 'setSettings', settings: { saveDataErrorExecution: 'sometimes' } }],
    });
    expect(badSetting.text).toContain('The settings are not valid');
    // another workspace's tag id is not a tag here
    const other = await signup();
    const foreignTag = await other.client.data<{ id: string }>(
      other.client.post('/rest/tags', { name: 'foreign' }),
    );
    const crossTag = await call(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: three.versionId,
      operations: [{ type: 'addTag', tag: foreignTag.id }],
    });
    expect(crossTag.text).toContain('There is no tag');
  });

  it('a node is in one group only', async () => {
    const user = await signup();
    const made = await created(user);
    const result = await call(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [
        { type: 'addGroup', name: 'One', nodeNames: ['Set'] },
        { type: 'addGroup', name: 'Two', nodeNames: ['Set'] },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('A node can be in one group only');
  });

  it('a workflow that is not available in MCP or is archived is refused with the gate texts', async () => {
    const user = await signup();
    const hidden = await created(user, definition('Hidden', { availableInMCP: false }));
    const op = [{ type: 'setWorkflowName', name: 'x' }];
    expect(
      (
        await call(user, 'update_workflow', {
          workflowId: hidden.workflowId,
          versionId: hidden.versionId,
          operations: op,
        })
      ).text,
    ).toBe(MCP_WORKFLOW_TEXTS.notAvailable);
    expect((await call(user, 'archive_workflow', { workflowId: hidden.workflowId })).text).toBe(
      MCP_WORKFLOW_TEXTS.notAvailable,
    );
    const missing = await call(user, 'update_workflow', {
      workflowId: randomUUID(),
      versionId: randomUUID(),
      operations: op,
    });
    expect(missing.text).toBe(MCP_WORKFLOW_TEXTS.notFound);
  });
});

describe('archive_workflow and restore_workflow_version', () => {
  it('archives (and unpublishes), then refuses every further change with the archived text', async () => {
    const user = await signup();
    const made = await created(user);
    await user.client.data(user.client.post(`/rest/workflows/${made.workflowId}/activate`));
    expect((await server.ctx.repos.workflows.get(user.tenant.id, made.workflowId))?.active).toBe(true);
    const archived = await ok(user, 'archive_workflow', { workflowId: made.workflowId });
    expect(archived).toEqual({
      workflowId: made.workflowId,
      name: made.name,
      archived: true,
      wasPublished: true,
    });
    const row = await server.ctx.repos.workflows.get(user.tenant.id, made.workflowId);
    expect(row?.isArchived).toBe(true);
    expect(row?.active).toBe(false);
    const text = MCP_WORKFLOW_TEXTS.archived(made.workflowId);
    expect((await call(user, 'archive_workflow', { workflowId: made.workflowId })).text).toBe(text);
    expect(
      (
        await call(user, 'update_workflow', {
          workflowId: made.workflowId,
          versionId: made.versionId,
          operations: [{ type: 'setWorkflowName', name: 'n' }],
        })
      ).text,
    ).toBe(text);
    expect(
      (
        await call(user, 'restore_workflow_version', {
          workflowId: made.workflowId,
          versionId: made.versionId,
        })
      ).text,
    ).toBe(text);
    const rows = await server.ctx.repos.audit.list(user.tenant.id, 50);
    expect(
      rows.find((r) => r.action === 'workflow.archived' && r.resourceId === made.workflowId),
    ).toBeTruthy();
  });

  it("a viewer cannot archive, and another workspace's workflow is not found", async () => {
    const owner = await signup();
    const made = await created(owner);
    const viewer = await member(owner, 'viewer');
    expect((await call(viewer, 'archive_workflow', { workflowId: made.workflowId })).rpcError?.code).toBe(
      -32602,
    );
    const other = await signup();
    expect((await call(other, 'archive_workflow', { workflowId: made.workflowId })).text).toBe(
      MCP_WORKFLOW_TEXTS.notFound,
    );
    expect((await server.ctx.repos.workflows.get(owner.tenant.id, made.workflowId))?.isArchived).toBe(false);
  });

  it('restores an old version as a new draft, and a version that is not there is refused', async () => {
    const user = await signup();
    const made = await created(user);
    const renamed = await ok(user, 'update_workflow', {
      workflowId: made.workflowId,
      versionId: made.versionId,
      operations: [
        { type: 'setWorkflowName', name: 'Changed' },
        { type: 'addNode', node: { type: 'core.set', name: 'Third' } },
      ],
    });
    expect((await details(user, made.workflowId)).nodes).toHaveLength(3);
    const restored = await ok(user, 'restore_workflow_version', {
      workflowId: made.workflowId,
      versionId: made.versionId,
    });
    expect(restored.restoredFrom).toBe(made.versionId);
    expect(restored.versionId).not.toBe(renamed.versionId);
    const now = await details(user, made.workflowId);
    expect(now.nodes.map((n) => n.name)).toEqual(['Webhook', 'Set']);
    expect(now.name).toBe(made.name);
    const missing = await call(user, 'restore_workflow_version', {
      workflowId: made.workflowId,
      versionId: randomUUID(),
    });
    expect(missing.isError).toBe(true);
  });
});

describe('explore_node_resources', () => {
  it("runs a node type's listSearch method; only workflows available in MCP show", async () => {
    const user = await signup();
    const shown = await created(user, definition('Visible one'));
    await created(user, definition('Hidden one', { availableInMCP: false }));
    const found = await ok(user, 'explore_node_resources', {
      nodeType: 'core.executeWorkflow',
      kind: 'listSearch',
      method: 'searchWorkflows',
    });
    const values = found.result.results.map((r: { value: string }) => r.value);
    expect(values).toContain(shown.workflowId);
    expect(found.result.results.map((r: { name: string }) => r.name)).not.toContain('Hidden one');
    const filtered = await ok(user, 'explore_node_resources', {
      nodeType: 'core.executeWorkflow',
      kind: 'listSearch',
      method: 'searchWorkflows',
      filter: 'Visible',
    });
    expect(filtered.result.results).toHaveLength(1);
  });

  it("refuses an unknown node type, a method that is not its own and another workspace's credential", async () => {
    const user = await signup();
    const unknownType = await call(user, 'explore_node_resources', { nodeType: 'core.nope', method: 'x' });
    expect(unknownType.text).toContain('Unknown node type');
    for (const method of ['constructor', '__proto__', 'toString', 'missing']) {
      const result = await call(user, 'explore_node_resources', {
        nodeType: 'core.executeWorkflow',
        kind: 'listSearch',
        method,
      });
      expect(result.isError, method).toBe(true);
      expect(result.text, method).toContain('has no listSearch method');
    }
    const other = await signup();
    const foreign = await other.client.data<{ id: string }>(
      other.client.post('/rest/credentials', {
        name: 'F',
        type: 'httpHeaderAuth',
        data: { name: 'X', value: 'v' },
      }),
    );
    const refused = await call(user, 'explore_node_resources', {
      nodeType: 'core.executeWorkflow',
      kind: 'listSearch',
      method: 'searchWorkflows',
      credentials: { httpHeaderAuth: { id: foreign.id, name: 'F' } },
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('was not found in this workspace');
  });

  it('needs credential:read in a project (a member with none is refused) and the credential:read grant', async () => {
    const owner = await signup();
    // P6-39: a project viewer holds credential:read; a member with no project role does not
    const viewer = await member(owner, 'member');
    const refused = await call(viewer, 'explore_node_resources', {
      nodeType: 'core.executeWorkflow',
      method: 'searchWorkflows',
      kind: 'listSearch',
    });
    expect(refused.rpcError?.code).toBe(-32602);
    const scoped = await caller(owner.tenant.id, owner.user.id, 'owner', ['workflow:write']);
    expect((await listMcpTools(server.ctx, scoped)).map((t) => t.name)).not.toContain(
      'explore_node_resources',
    );
  });
});

describe('secrets', () => {
  it('a seeded credential secret appears in no output of any build tool', async () => {
    const SECRET = `s3cret-${randomUUID()}`;
    const user = await signup();
    const credential = await user.client.data<{ id: string }>(
      user.client.post('/rest/credentials', {
        name: 'Seeded',
        type: 'httpHeaderAuth',
        data: { name: 'X-Api-Key', value: SECRET },
      }),
    );
    const resolved = await server.ctx.credentials.readResolved(
      (await server.ctx.repos.credentials.get(user.tenant.id, credential.id))!,
    );
    expect(resolved.value).toBe(SECRET);
    const workflow = definition();
    workflow.nodes.push(
      node('Call', 'core.httpRequest', { url: 'http://127.0.0.1:9/never' }, [400, 0], {
        credentials: { httpHeaderAuth: { id: credential.id, name: 'Seeded' } },
      }),
    );
    workflow.connections = chain('Webhook', 'Set', 'Call');
    const made = await created(user, workflow);
    const versions = await server.ctx.workflows.listVersions(user.tenant.id, made.workflowId, 5);

    const ARGS: Record<string, DataObject> = {
      search_nodes: { queries: ['http', 'header auth'] },
      get_node_types: { types: ['core.httpRequest'] },
      get_workflow_best_practices: {},
      get_workflow_format_reference: {},
      validate_workflow: { workflowId: made.workflowId },
      validate_node_config: { type: 'core.httpRequest', parameters: { url: 'http://127.0.0.1:9/never' } },
      create_workflow: { workflow: workflow },
      update_workflow: {
        workflowId: made.workflowId,
        versionId: made.versionId,
        operations: [
          {
            type: 'setNodeCredential',
            name: 'Call',
            credentialType: 'httpHeaderAuth',
            credentialId: credential.id,
          },
        ],
      },
      archive_workflow: { workflowId: made.workflowId },
      restore_workflow_version: { workflowId: made.workflowId, versionId: versions.data[0].versionId },
      explore_node_resources: {
        nodeType: 'core.executeWorkflow',
        kind: 'listSearch',
        method: 'searchWorkflows',
      },
    };
    const listed = await rpcCall(user.url, user.key, 'tools/list');
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    const missing = MCP_BUILDER_TOOLS.map((t) => t.name).filter((name) => !(name in ARGS));
    expect(missing, 'a build tool without arguments in this test').toEqual([]);
    // run archive last: it blocks the others
    const order = Object.keys(ARGS).sort(
      (a, b) => Number(a === 'archive_workflow') - Number(b === 'archive_workflow'),
    );
    for (const name of order) {
      for (let round = 0; round < 2; round++) {
        const args =
          name === 'create_workflow' ? { workflow: { ...workflow, name: `Seeded ${round}` } } : ARGS[name];
        const res = await rpcCall(user.url, user.key, 'tools/call', { name, arguments: args });
        const text = JSON.stringify(res);
        expect(text, `${name} round ${round}`).not.toContain(SECRET);
        expect(text, `${name} round ${round}`).not.toContain('"error":{"code":-32603');
      }
    }
    // the stored credential still holds it, so the check above was against a real secret
    expect(JSON.stringify(await details(user, made.workflowId).catch(() => ({})))).not.toContain(SECRET);
  });
});
