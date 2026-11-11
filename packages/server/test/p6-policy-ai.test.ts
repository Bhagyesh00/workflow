/**
 * P6-55 (L10): the type policies in the AI tools. A model is never offered a blocked node (builder, MCP
 * and Assistant `search_nodes`, `get_node_types`, `get_node_details`), the validators (`validateDefinition`,
 * MCP `validate_workflow` and `validate_node_config`, Assistant `validate_workflow`) return a violation as
 * an error issue so the model retries, a write of a blocked type is refused (403 stays the last gate), the
 * Assistant's `execute_node` and `get_node_parameter_options` refuse before any decrypt, and a name rule on
 * a base node hides its tool variant. A check that fails blocks.
 */
import { randomUUID } from 'node:crypto';
import type { DataObject, WorkflowDefinition, WorkflowNode } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BuilderDraft } from '../src/services/ai-builder/draft';
import {
  createBuilderTools,
  nodeDetails,
  searchNodes,
  validateDefinition,
} from '../src/services/ai-builder/tools';
import { MCP_KEY_AUDIENCE, MCP_KEY_LABEL } from '../src/services/mcp/types';
import {
  policyIssues,
  restrictedNodeTypesView,
  workflowProjectId,
} from '../src/services/type-policies/tool-filter';
import { type AssistantHarness, createAssistantHarness, toolResultOf } from './fakes/assistant-harness';
import {
  chain,
  node,
  policyDeny,
  setNode,
  startMcpTestServer,
  TestClient,
  type TestServer,
  teamProjectOf,
  waitFor,
  workflowIn,
} from './helpers';

const BLOCKED = (type: string) => `Node type "${type}" is blocked by a workspace policy`;
const BLOCKED_PROJECT = (type: string) => `Node type "${type}" is blocked by a project policy`;

const definitionOf = (nodes: WorkflowNode[]): WorkflowDefinition =>
  ({ nodes, connections: {}, settings: {}, pinData: {} }) as unknown as WorkflowDefinition;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------
// the registry view, the builder and the MCP tools
// ---------------------------------------------------------------------------------------------------------

describe('the registry view, the builder tools and the MCP tools', () => {
  let server: TestServer & { url: string; port: number };
  let signups = 0;

  beforeAll(async () => {
    server = await startMcpTestServer({ MCP_ACCESS_ENABLED: 'true', MCP_SERVER_RATE_LIMIT: '100000' });
  }, 120_000);
  afterAll(async () => {
    await server?.close();
  });

  /** a new workspace with its team project and an MCP key, from its own IP (signup allows 20 an hour) */
  async function newOwner() {
    signups++;
    // the MCP test server's origin is its own URL; every workspace signs up from its own address
    const client = new TestClient(server.app, server.url, `10.91.${signups >> 8}.${signups & 255}`);
    const id = randomUUID().slice(0, 8);
    const res = await client.post('/rest/auth/signup', {
      email: `policy-ai-${id}@example.com`,
      password: 'Passw0rd!',
      name: `Policy ${id}`,
      workspaceName: `Policy ${id}`,
    });
    if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
    const data = res.json().data as { user: { id: string }; tenant: { id: string; slug: string } };
    const owner = { client, ...data };
    client.defaultProjectId = (
      await client.data<{ id: string }>(client.post('/rest/projects', { name: `Policy ${id}` }))
    ).id;
    const key = (
      await server.ctx.auth.createApiKey(owner.tenant.id, owner.user.id, MCP_KEY_LABEL, [], MCP_KEY_AUDIENCE)
    ).key;
    return {
      ...owner,
      key,
      projectId: await teamProjectOf(server, owner.tenant.id),
      mcpUrl: `${server.url}/mcp-server/${owner.tenant.slug}/http`,
    };
  }
  type Owner = Awaited<ReturnType<typeof newOwner>>;

  let rpcId = 0;
  async function call(owner: Owner, name: string, args: DataObject = {}) {
    const res = await fetch(owner.mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.key}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as { result?: any; error?: { message: string } };
    if (body.error) return { isError: true, text: body.error.message, value: undefined as any };
    const text = (body.result.content ?? []).map((p: { text?: string }) => p.text ?? '').join('');
    if (body.result.isError) {
      return {
        isError: true,
        text: text.startsWith(`${name}: `) ? text.slice(name.length + 2) : text,
        value: undefined as any,
      };
    }
    return { isError: false, text, value: JSON.parse(text) };
  }

  const registry = () => server.ctx.registries.nodeTypes;
  const names = (rows: Array<{ type: string }>) => rows.map((row) => row.type);

  it('the view hides a blocked type from list and get; the others stay; nothing blocked: the same registry', async () => {
    const { tenant } = await newOwner();
    const deps = server.ctx.serviceDeps;
    expect(await restrictedNodeTypesView(deps, tenant.id, null, registry())).toBe(registry());
    await policyDeny(server, tenant.id, 'node', 'core.set');
    const view = await restrictedNodeTypesView(deps, tenant.id, null, registry());
    expect(view.get('core.set')).toBeUndefined();
    expect(view.get('core.noOp')).toBeDefined();
    expect(view.list().some((type) => type.description.name === 'core.set')).toBe(false);
    expect(view.list().length).toBe(registry().list().length - 1);
    // the shared registry is untouched, and another workspace sees everything
    expect(registry().get('core.set')).toBeDefined();
    const other = await newOwner();
    const otherView = await restrictedNodeTypesView(deps, other.tenant.id, null, registry());
    expect(otherView.get('core.set')).toBeDefined();
    // searchNodes and nodeDetails on the view
    const hits = searchNodes(view, ['Edit Fields set', 'No Operation']);
    expect(names(hits[0].results)).not.toContain('core.set');
    expect(names(hits[1].results)).toContain('core.noOp');
    expect(nodeDetails(view, 'core.set')).toBeUndefined();
    expect(nodeDetails(view, 'core.noOp')).toBeDefined();
  });

  it('a project rule hides the type in that project only; the workspace scope (no project) keeps it', async () => {
    const { tenant, projectId } = await newOwner();
    const deps = server.ctx.serviceDeps;
    await policyDeny(server, tenant.id, 'node', 'core.code', projectId);
    const inProject = await restrictedNodeTypesView(deps, tenant.id, projectId, registry());
    expect(inProject.get('core.code')).toBeUndefined();
    const inWorkspace = await restrictedNodeTypesView(deps, tenant.id, null, registry());
    expect(inWorkspace.get('core.code')).toBeDefined();
    const issues = await policyIssues(deps, tenant.id, projectId, { nodes: [node('Code', 'core.code')] });
    expect(issues).toEqual([
      expect.objectContaining({
        kind: 'node-type-unavailable',
        type: 'core.code',
        scope: 'project',
        nodeName: 'Code',
      }),
    ]);
    expect(await policyIssues(deps, tenant.id, null, { nodes: [node('Code', 'core.code')] })).toEqual([]);
  });

  it('a name rule on a base node hides its tool variant', async () => {
    const { tenant } = await newOwner();
    const variant = registry()
      .list()
      .map((type) => type.description.name)
      .find((name) => name.endsWith('Tool') && registry().get(name.slice(0, -'Tool'.length)));
    expect(variant).toBeDefined();
    const base = (variant as string).slice(0, -'Tool'.length);
    await policyDeny(server, tenant.id, 'node', base);
    const view = await restrictedNodeTypesView(server.ctx.serviceDeps, tenant.id, null, registry());
    expect(view.get(base)).toBeUndefined();
    expect(view.get(variant as string)).toBeUndefined();
  });

  it('policyIssues: a stored type is not judged again, an added one is; no stored judges all and the credential types', async () => {
    const { tenant } = await newOwner();
    const deps = server.ctx.serviceDeps;
    await policyDeny(server, tenant.id, 'node', 'core.set');
    await policyDeny(server, tenant.id, 'credential', 'httpHeaderAuth');
    const nodes = [
      node('Set', 'core.set'),
      node('Again', 'core.set'),
      node('Call', 'core.httpRequest', {}, [0, 0], {
        credentials: { httpHeaderAuth: { id: 'x', name: 'x' } },
      }),
    ];
    const whole = await policyIssues(deps, tenant.id, null, { nodes });
    expect(whole.map((v) => [v.kind, v.type, v.nodeName])).toEqual([
      ['node-type-unavailable', 'core.set', 'Set'],
      ['credential-type-unavailable', 'httpHeaderAuth', 'Call'],
    ]);
    const kept = await policyIssues(deps, tenant.id, null, { nodes }, { nodes: [node('Old', 'core.set')] });
    expect(kept).toEqual([]);
    const added = await policyIssues(deps, tenant.id, null, { nodes }, { nodes: [node('Old', 'core.noOp')] });
    expect(added.map((v) => v.type)).toEqual(['core.set']);
  });

  it('a check that fails blocks: the view and the issues throw policy_check_failed', async () => {
    const { tenant } = await newOwner();
    const deps = server.ctx.serviceDeps;
    vi.spyOn(server.ctx.policySnapshots, 'forTenant').mockRejectedValue(new Error('store down'));
    await expect(restrictedNodeTypesView(deps, tenant.id, null, registry())).rejects.toMatchObject({
      code: 'policy_check_failed',
      statusCode: 503,
    });
    await expect(
      policyIssues(deps, tenant.id, null, { nodes: [node('Set', 'core.set')] }),
    ).rejects.toMatchObject({ code: 'policy_check_failed' });
    // a validator turns it into an error issue: the draft is not valid
    const validation = await validateDefinition(
      server.ctx,
      tenant.id,
      definitionOf([node('Set', 'core.set')]),
    );
    expect(validation.valid).toBe(false);
    expect(validation.issues.find((i) => i.code === 'policy-check-failed')).toBeDefined();
  });

  it('builder: search_nodes and get_node_details never offer a blocked node; validate_workflow reports it', async () => {
    const { tenant } = await newOwner();
    const tenantRow = (await server.ctx.repos.tenants.get(tenant.id))!;
    const draft = new BuilderDraft(definitionOf([setNode('Set', 'a', 1)]), registry());
    const tools = createBuilderTools(draft, { ctx: server.ctx, tenant: tenantRow, emit: () => {} });
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    type Hits = Array<{ results: Array<{ type: string }> }>;

    const before = (await tool('search_nodes').invoke({ queries: ['Edit Fields set'] })) as Hits;
    expect(names(before[0].results)).toContain('core.set');

    await policyDeny(server, tenant.id, 'node', 'core.set');
    const after = (await tool('search_nodes').invoke({
      queries: ['Edit Fields set', 'No Operation'],
    })) as Hits;
    expect(names(after[0].results)).not.toContain('core.set');
    expect(names(after[1].results)).toContain('core.noOp');
    await expect(tool('get_node_details').invoke({ type: 'core.set' })).rejects.toThrow(
      'Unknown node type "core.set"',
    );
    await expect(tool('get_node_details').invoke({ type: 'core.noOp' })).resolves.toMatchObject({
      type: 'core.noOp',
    });

    const verdict = String(await tool('validate_workflow').invoke({}));
    expect(verdict).toContain('The draft has errors');
    // the issues travel as JSON inside the wrapper: the quotes are escaped
    expect(verdict).toContain(JSON.stringify(BLOCKED('core.set')).slice(1, -1));
    expect(verdict).toContain('policy-blocked');
  });

  it('validateDefinition: a blocked type is an error issue; with a workflow id only the added types and its project count', async () => {
    const { tenant, projectId } = await newOwner();
    const old = await workflowIn(server, tenant.id, projectId, { nodes: [setNode('Old', 'a', 1)] });
    await policyDeny(server, tenant.id, 'node', 'core.set');
    await policyDeny(server, tenant.id, 'node', 'core.code', projectId);

    const fresh = await validateDefinition(server.ctx, tenant.id, definitionOf([setNode('Set', 'a', 1)]));
    expect(fresh.valid).toBe(false);
    expect(fresh.issues.find((i) => i.code === 'policy-blocked')).toMatchObject({
      severity: 'error',
      node: 'Set',
      message: BLOCKED('core.set'),
    });
    // the stored workflow has core.set: a rename is no added type; a new core.code (blocked in its project) is
    const kept = await validateDefinition(
      server.ctx,
      tenant.id,
      definitionOf([setNode('Renamed', 'a', 1)]),
      old.id,
    );
    expect(kept.issues.some((i) => i.code === 'policy-blocked')).toBe(false);
    const added = await validateDefinition(
      server.ctx,
      tenant.id,
      definitionOf([setNode('Renamed', 'a', 1), node('Code', 'core.code')]),
      old.id,
    );
    expect(added.issues.find((i) => i.code === 'policy-blocked')).toMatchObject({
      node: 'Code',
      message: BLOCKED_PROJECT('core.code'),
    });
    expect(await workflowProjectId(server.ctx.serviceDeps, tenant.id, old.id)).toBe(projectId);
    expect(await workflowProjectId(server.ctx.serviceDeps, tenant.id, undefined)).toBeNull();
  });

  it('MCP: search_nodes, get_node_types, validate_node_config and validate_workflow; create and update are refused', async () => {
    const owner = await newOwner();
    const built = await call(owner, 'create_workflow', {
      workflow: {
        name: `Plain ${randomUUID().slice(0, 8)}`,
        nodes: [
          node('Webhook', 'core.webhook', { path: `p-${randomUUID().slice(0, 8)}`, httpMethod: 'POST' }),
        ],
        connections: {},
      },
    });
    expect(built.isError, built.text).toBe(false);
    const open = await call(owner, 'search_nodes', { queries: ['Edit Fields set'] });
    expect(names(open.value.results[0].results)).toContain('core.set');

    await policyDeny(server, owner.tenant.id, 'node', 'core.set');
    const found = await call(owner, 'search_nodes', { queries: ['Edit Fields set', 'No Operation'] });
    expect(names(found.value.results[0].results)).not.toContain('core.set');
    expect(names(found.value.results[1].results)).toContain('core.noOp');

    const types = await call(owner, 'get_node_types', { types: ['core.set', 'core.noOp'] });
    expect(types.value.nodeTypes.map((t: { type: string }) => t.type)).toEqual(['core.noOp']);
    expect(types.value.unknown).toEqual(['core.set']);
    const onlyBlocked = await call(owner, 'get_node_types', { types: ['core.set'] });
    expect(onlyBlocked.isError).toBe(true);
    expect(onlyBlocked.text).toContain('Unknown node type "core.set"');

    const config = await call(owner, 'validate_node_config', {
      type: 'core.set',
      parameters: { mode: 'manual', assignments: { assignments: [] } },
    });
    expect(config.value.valid).toBe(false);
    expect(config.value.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'policy-blocked', message: BLOCKED('core.set') }),
      ]),
    );
    const clean = await call(owner, 'validate_node_config', { type: 'core.noOp' });
    expect(clean.value.issues.some((i: { code?: string }) => i.code === 'policy-blocked')).toBe(false);

    const withSet = { nodes: [node('Set', 'core.set')], connections: {} };
    const checked = await call(owner, 'validate_workflow', { workflow: withSet });
    expect(checked.value.valid).toBe(false);
    expect(checked.value.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'policy-blocked', node: 'Set' })]),
    );

    const count = async () => (await server.ctx.repos.workflows.list(owner.tenant.id, { limit: 500 })).length;
    const before = await count();
    const create = await call(owner, 'create_workflow', { workflow: { name: 'Blocked', ...withSet } });
    expect(create.isError).toBe(true);
    expect(create.text).toContain(BLOCKED('core.set'));
    expect(await count()).toBe(before);

    const update = await call(owner, 'update_workflow', {
      workflowId: built.value.workflowId,
      versionId: built.value.versionId,
      operations: [{ type: 'addNode', node: { type: 'core.set', name: 'Set', parameters: {} } }],
    });
    expect(update.isError).toBe(true);
    expect(update.text).toContain(BLOCKED('core.set'));
    // a different type is fine
    const fine = await call(owner, 'update_workflow', {
      workflowId: built.value.workflowId,
      versionId: built.value.versionId,
      operations: [{ type: 'addNode', node: { type: 'core.noOp', name: 'Nothing', parameters: {} } }],
    });
    expect(fine.isError, fine.text).toBe(false);
  });

  it('REST: a write of a blocked type is refused with 403 whatever the tool said', async () => {
    const { client, tenant, projectId } = await newOwner();
    await policyDeny(server, tenant.id, 'node', 'core.set');
    const res = await client.post('/rest/workflows', {
      name: 'Blocked',
      projectId,
      nodes: [setNode('Set', 'a', 1)],
      connections: chain('Set'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(BLOCKED('core.set'));
  });
});

// ---------------------------------------------------------------------------------------------------------
// the Assistant
// ---------------------------------------------------------------------------------------------------------

describe('the Assistant tools', () => {
  let h: AssistantHarness;
  let projectId: string;

  beforeAll(async () => {
    h = await createAssistantHarness();
    projectId = await teamProjectOf(h.server, h.tenantId);
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  const executions = async () => (await h.ctx.repos.executions.list(h.tenantId, { limit: 500 })).length;

  it('search_nodes and get_node_types never offer a blocked node', async () => {
    const before = await h.callTool(h.editor, 'search_nodes', { query: 'Edit Fields' });
    expect(before.result).toContain('core.set');
    await policyDeny(h.server, h.tenantId, 'node', 'core.set');
    const search = await h.callTool(h.editor, 'search_nodes', { queries: ['Edit Fields', 'No Operation'] });
    expect(search.result).not.toContain('"core.set"');
    expect(search.result).toContain('core.noOp');
    const types = await h.callTool(h.editor, 'get_node_types', { nodeTypes: ['core.set', 'core.noOp'] });
    expect(types.result).toContain('Unknown node type \\"core.set\\"');
    expect(types.result).toContain('"type":"core.noOp"');
  });

  it("validate_workflow returns the violation for a stored workflow's blocked type", async () => {
    const stored = await workflowIn(h.server, h.tenantId, projectId, {
      nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'a', 1)],
      connections: chain('Start', 'Set'),
    });
    const { result } = await h.callTool(h.editor, 'validate_workflow', { workflowId: stored.id });
    expect(result).toContain(JSON.stringify(BLOCKED('core.set')).slice(1, -1));
    expect(result).toContain('"valid":false');
  });

  it('execute_node refuses before a decrypt and starts no run', async () => {
    const build = vi.spyOn(h.ctx.executions, 'buildServices');
    const before = await executions();
    // the chat's own model call builds services in `internal` mode; a node run would not
    const nodeRuns = () => build.mock.calls.filter(([options]) => options.mode !== 'internal');
    const first = await h.callTool(h.editor, 'execute_node', {
      type: 'core.set',
      version: 1,
      config: {
        parameters: {
          mode: 'manual',
          assignments: { assignments: [{ id: 'a1', name: 'greeting', value: 'hi', type: 'string' }] },
        },
      },
      input: [{ json: { from: 'input' } }],
    });
    let text = first.result;
    if (text === undefined) {
      // a card first: approve it; the refusal comes with the answer
      const card = first.status.pending[0];
      const requests = h.fake.requests.length;
      const answer = await h.confirm(h.editor, card.requestId, { kind: 'approval', approved: true });
      expect(answer.statusCode).toBe(200);
      await waitFor(async () => h.fake.requests.length > requests, {
        timeout: 30_000,
        message: 'the resumed turn',
      });
      await h.waitForStatus(h.editor, first.threadId, 'idle', 30_000);
      for (let i = h.fake.requests.length - 1; i >= 0 && text === undefined; i--) {
        text = toolResultOf([h.fake.requests[i]], card.toolCallId);
      }
    }
    expect(text).toContain(BLOCKED('core.set'));
    expect(nodeRuns()).toHaveLength(0);
    expect(await executions()).toBe(before);
  });

  it('get_node_parameter_options refuses a blocked node before a decrypt', async () => {
    const home = (await h.ctx.repos.projects.getPersonal(h.tenantId, h.editor.userId))!.id;
    const credential = await h.owner.client.data<{ id: string }>(
      h.owner.client.post('/rest/credentials', {
        projectId: home,
        name: `Options ${randomUUID().slice(0, 8)}`,
        type: 'openAiApi',
        data: { apiKey: 'sk-options-key-0000000000000000', baseUrl: 'http://127.0.0.1:9/v1' },
      }),
    );
    await policyDeny(h.server, h.tenantId, 'node', 'ai.lmChatOpenAi', home);
    const build = vi.spyOn(h.ctx.executions, 'buildServices');
    const { result } = await h.callTool(h.editor, 'get_node_parameter_options', {
      nodeType: 'ai.lmChatOpenAi',
      version: 1,
      parameterPath: 'model',
      credentialId: credential.id,
    });
    expect(result).toContain(BLOCKED_PROJECT('ai.lmChatOpenAi'));
    // the credential was never loaded for a node
    expect(
      build.mock.calls.filter(([options]) => options.allowCredentials?.includes(credential.id)),
    ).toHaveLength(0);
    expect(result).not.toContain('sk-options-key');
  });
});
