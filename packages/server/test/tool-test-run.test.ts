/**
 * P5-76 Test a tool: POST /workflows/:id/run with `agentRequest`. The tool runs with typed values, the Agent it
 * hangs from does not run, and its parents run once. Retry and resume never fall back to running the Agent.
 */
import { nodesAiPackage } from '@workflow/nodes-ai';
import type { DataObject, NodeGroup, NodePackage } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestServer,
  createWorkflow,
  memberAs,
  node,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
  waitForExecution,
} from './helpers';

const calls = { parent: 0, model: 0, tool: 0 };
let toolFails = false;
let parentFails = false;

const base = {
  group: ['transform'] as NodeGroup[],
  version: 1,
  defaults: { name: 'Test' },
  properties: [],
};

const toolPackage: NodePackage = {
  name: 'tool-test-run',
  credentials: [],
  nodes: [
    {
      description: {
        ...base,
        name: 'tt.parent',
        displayName: 'Counting parent',
        description: '',
        inputs: ['main'],
        outputs: ['main'],
      },
      async execute(ctx) {
        calls.parent++;
        if (parentFails) throw new Error('the parent broke');
        return [ctx.getInputData().map((item) => ({ json: { ...item.json, fromParent: true } }))];
      },
    },
    {
      description: {
        ...base,
        name: 'tt.model',
        displayName: 'Counting model',
        description: '',
        inputs: [],
        outputs: ['ai_languageModel'],
      },
      async supplyData() {
        calls.model++;
        throw new Error('a tool test must not reach the model');
      },
    },
    {
      description: {
        ...base,
        name: 'tt.echo',
        displayName: 'Echo',
        description: 'Gives back what it reads',
        inputs: ['main'],
        outputs: ['main'],
        usableAsTool: true,
        properties: [
          { displayName: 'Count', name: 'count', type: 'string', default: '' },
          { displayName: 'On', name: 'on', type: 'string', default: '' },
          { displayName: 'Text', name: 'text', type: 'string', default: '' },
          { displayName: 'Payload', name: 'payload', type: 'string', default: '' },
        ],
      },
      async execute(ctx) {
        calls.tool++;
        if (toolFails) throw new Error('the tool broke');
        const read = (name: string) => ctx.getNodeParameter(name, 0, '') as DataObject[string];
        return [
          [
            {
              json: {
                count: read('count'),
                on: read('on'),
                text: read('text'),
                payload: read('payload'),
                fromParent: ctx.getInputData()[0].json.fromParent as boolean,
              },
            },
          ],
        ];
      },
    },
  ],
};

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({}, { nodePackages: [nodesAiPackage, toolPackage] });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  Object.assign(calls, { parent: 0, model: 0, tool: 0 });
  toolFails = false;
  parentFails = false;
});

const link = (to: string, type: string) => ({ [type]: [[{ node: to, type, index: 0 }]] });

const TOOL_PARAMETERS = {
  count: "={{ $fromAI('count', 'How many', 'number') }}",
  on: "={{ $fromAI('on', 'Switch', 'boolean') }}",
  text: "={{ $fromAI('text', 'Words') }}",
  payload: "={{ $fromAI('payload', 'Data', 'json') }}",
};

const graph = () => ({
  nodes: [
    node('Start', 'core.manualTrigger'),
    node('Parent', 'tt.parent', {}, [100, 0]),
    node('Agent', 'ai.agent', {}, [200, 0]),
    node('Model', 'tt.model', {}, [200, 200]),
    node('Tool', 'tt.echoTool', TOOL_PARAMETERS, [300, 200]),
  ],
  connections: {
    Start: link('Parent', 'main'),
    Parent: link('Agent', 'main'),
    Model: link('Agent', 'ai_languageModel'),
    Tool: link('Agent', 'ai_tool'),
  },
});

const query = { count: '7', on: 'true', text: '={{ 1 + 1 }}', payload: '{"a":[1]}' };
const agentRequest = { query, toolName: 'Tool' };

async function runOf(client: TestClient, id: string, body: DataObject) {
  return client.data<{ executionId: string }>(client.post(`/rest/workflows/${id}/run`, body));
}

async function finished(tenantId: string, executionId: string, statuses?: string[]) {
  await waitForExecution(server.ctx, tenantId, executionId, statuses);
  const data = await server.ctx.repos.executions.getData(tenantId, executionId);
  return data as any;
}

describe('POST /workflows/:id/run with agentRequest', () => {
  it('runs the tool with typed values; the root does not run and its parents run once', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, graph());
    const { executionId } = await runOf(client, wf.id, { destinationNode: 'Tool', agentRequest });
    const data = await finished(tenant.id, executionId);

    const row = await server.ctx.repos.executions.get(tenant.id, executionId);
    expect(row?.status).toBe('success');
    const { runData, lastNodeExecuted } = data.state.resultData;
    expect(Object.keys(runData).sort()).toEqual(['Parent', 'Start', 'Tool']);
    expect(lastNodeExecuted).toBe('Tool');
    expect(calls).toEqual({ parent: 1, model: 0, tool: 1 });
    expect(runData.Tool).toHaveLength(1);
    expect(runData.Tool[0].inputOverride.ai_tool[0][0].json).toEqual({
      count: 7,
      on: true,
      text: '={{ 1 + 1 }}',
      payload: { a: [1] },
    });
    expect(runData.Tool[0].data.ai_tool[0][0].json.response[0]).toEqual({
      count: 7,
      on: true,
      text: '={{ 1 + 1 }}',
      payload: { a: [1] },
      fromParent: true,
    });
    expect(data.runOptions.agentRequest).toEqual(agentRequest);
  });

  it('tests the unsaved copy the editor sends', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Start', 'core.manualTrigger')] });
    const { executionId } = await runOf(client, wf.id, {
      workflowData: { name: 'Draft', settings: {}, ...graph() },
      destinationNode: 'Tool',
      agentRequest,
    });
    await finished(tenant.id, executionId);
    expect(calls).toEqual({ parent: 1, model: 0, tool: 1 });
  });

  it('starts at the root when it has no parents', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Elsewhere', 'core.manualTrigger', {}, [0, 500]),
        node('Other', 'tt.parent', {}, [100, 500]),
        node('Agent', 'ai.agent', {}, [200, 0]),
        node('Model', 'tt.model', {}, [200, 200]),
        node('Tool', 'tt.echoTool', { text: 'fixed' }, [300, 200]),
      ],
      connections: {
        Elsewhere: link('Other', 'main'),
        Model: link('Agent', 'ai_languageModel'),
        Tool: link('Agent', 'ai_tool'),
      },
    });
    const { executionId } = await runOf(client, wf.id, {
      destinationNode: 'Tool',
      agentRequest: { query: {}, toolName: 'Tool' },
    });
    const data = await finished(tenant.id, executionId);
    expect(Object.keys(data.state.resultData.runData)).toEqual(['Tool']);
    expect(calls).toEqual({ parent: 0, model: 0, tool: 1 });
    expect(data.state.resultData.runData.Tool[0].data.ai_tool[0][0].json.response[0].text).toBe('fixed');
  });

  it('a second test keeps the output of the parents', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, graph());
    const first = await runOf(client, wf.id, { destinationNode: 'Tool', agentRequest });
    const firstData = await finished(tenant.id, first.executionId);

    const second = await runOf(client, wf.id, {
      destinationNode: 'Tool',
      agentRequest,
      runData: firstData.state.resultData.runData,
      dirtyNodeNames: [],
    });
    const secondData = await finished(tenant.id, second.executionId);
    expect(calls).toEqual({ parent: 1, model: 0, tool: 2 });
    expect(secondData.state.resultData.runData.Tool.at(-1).executionStatus).toBe('success');
    expect(secondData.state.resultData.runData.Tool.at(-1).data.ai_tool[0][0].json.response[0]).toMatchObject(
      {
        fromParent: true,
      },
    );
  });

  it('a test after a full run does not run the root again', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, graph());
    const { executionId } = await runOf(client, wf.id, { destinationNode: 'Tool', agentRequest });
    const data = await finished(tenant.id, executionId);
    const runData = {
      ...data.state.resultData.runData,
      Agent: [
        { startTime: 1, executionTime: 1, executionStatus: 'success', data: { main: [[{ json: {} }]] } },
      ],
    };
    const again = await runOf(client, wf.id, {
      destinationNode: 'Tool',
      agentRequest,
      runData,
      dirtyNodeNames: [],
    });
    await finished(tenant.id, again.executionId);
    expect(calls).toEqual({ parent: 1, model: 0, tool: 2 });
  });

  it('a failing tool ends the run with the error, and one error task on the tool', async () => {
    toolFails = true;
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, graph());
    const { executionId } = await runOf(client, wf.id, { destinationNode: 'Tool', agentRequest });
    const data = await finished(tenant.id, executionId);
    const row = await server.ctx.repos.executions.get(tenant.id, executionId);
    expect(row?.status).toBe('error');
    expect(data.state.resultData.error.message).toBe('Error executing tool: the tool broke');
    expect(data.state.resultData.runData.Tool[0].executionStatus).toBe('error');
    expect(calls.model).toBe(0);
  });

  it('no destination fails the run with its reason; an unknown one is a 400', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, graph());
    const { executionId } = await runOf(client, wf.id, { agentRequest });
    const data = await finished(tenant.id, executionId);
    expect(data.state.resultData.error.message).toBe('A tool test needs a destination node');
    expect(calls).toEqual({ parent: 0, model: 0, tool: 0 });
    const unknown = await client.post(`/rest/workflows/${wf.id}/run`, {
      destinationNode: 'Gone',
      agentRequest,
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('takes at most 100 values and needs a query and a tool name', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, graph());
    const values = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`key${i}`, i]));
    const url = `/rest/workflows/${wf.id}/run`;
    const tooMany = await client.post(url, {
      destinationNode: 'Tool',
      agentRequest: { query: values(101), toolName: 'Tool' },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(
      (await client.post(url, { destinationNode: 'Tool', agentRequest: { query: {} } })).statusCode,
    ).toBe(400);
    expect(
      (await client.post(url, { destinationNode: 'Tool', agentRequest: { toolName: 'x' } })).statusCode,
    ).toBe(400);
    const allowed = await client.data<{ executionId: string }>(
      client.post(url, {
        destinationNode: 'Tool',
        agentRequest: { query: { ...values(96), ...query }, toolName: 'Tool' },
      }),
    );
    await finished(tenant.id, allowed.executionId);
    expect(calls.model).toBe(0);
  });

  it('a viewer gets 403, another tenant 404, an editor runs it', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, graph());
    const url = `/rest/workflows/${wf.id}/run`;
    const body = { destinationNode: 'Tool', agentRequest };

    const invited = async (role: 'viewer' | 'editor') => (await memberAs(owner, role)).client;
    expect((await (await invited('viewer')).post(url, body)).statusCode).toBe(403);
    const other = await signup(server.app);
    expect((await other.client.post(url, body)).statusCode).toBe(404);
    expect(calls).toEqual({ parent: 0, model: 0, tool: 0 });

    const editor = await invited('editor');
    const { executionId } = await editor.data<{ executionId: string }>(editor.post(url, body));
    await finished(owner.tenant.id, executionId);
    expect(calls.tool).toBe(1);
  });
});

describe('a tool test never falls back to running the root', () => {
  it('retrying a failed tool test tests the tool again', async () => {
    toolFails = true;
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, graph());
    const { executionId } = await runOf(client, wf.id, { destinationNode: 'Tool', agentRequest });
    await finished(tenant.id, executionId);

    toolFails = false;
    const retried = await client.data<{ executionId: string }>(
      client.post(`/rest/executions/${executionId}/retry`, {}),
    );
    const data = await finished(tenant.id, retried.executionId);
    expect(calls.model).toBe(0);
    expect(calls.tool).toBe(2);
    expect(data.state.resultData.runData.Agent).toBeUndefined();
    expect((await server.ctx.repos.executions.get(tenant.id, retried.executionId))?.status).toBe('success');
  });

  it('retrying a test whose parent failed runs the parent and the tool, not the root', async () => {
    parentFails = true;
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, graph());
    const { executionId } = await runOf(client, wf.id, { destinationNode: 'Tool', agentRequest });
    const failed = await finished(tenant.id, executionId);
    expect(failed.state.executionData.failedExecuteData?.node).toBe('Parent');
    expect(calls.tool).toBe(0);

    parentFails = false;
    const retried = await client.data<{ executionId: string }>(
      client.post(`/rest/executions/${executionId}/retry`, {}),
    );
    const data = await finished(tenant.id, retried.executionId);
    expect(calls).toEqual({ parent: 2, model: 0, tool: 1 });
    expect(data.state.resultData.runData.Agent).toBeUndefined();
    expect(data.state.resultData.runData.Tool).toHaveLength(1);
  });

  it('a parent that waits fails the test on resume instead of running the root', async () => {
    const { client, tenant } = await signup(server.app);
    const { nodes, connections } = graph();
    const wf = await createWorkflow(client, {
      nodes: [...nodes, node('Wait', 'core.wait', { resume: 'webhook', httpMethod: 'POST' }, [50, 0])],
      connections: {
        ...connections,
        Start: link('Wait', 'main'),
        Wait: link('Parent', 'main'),
      },
    });
    const { executionId } = await runOf(client, wf.id, { destinationNode: 'Tool', agentRequest });
    await waitForExecution(server.ctx, tenant.id, executionId, ['waiting']);
    const res = await server.app.inject({
      method: 'POST',
      url: new URL(server.ctx.executions.resumeUrl(executionId)).pathname,
      payload: {},
    });
    expect(res.statusCode).toBeLessThan(500);
    const data = await finished(tenant.id, executionId);
    expect(data.state.resultData.error.message).toBe(
      'A tool test cannot continue after a wait. Pin the output of the node that waits, then test the tool again',
    );
    expect(calls).toEqual({ parent: 0, model: 0, tool: 0 });
    expect(data.state.resultData.runData.Agent).toBeUndefined();
  });
});
