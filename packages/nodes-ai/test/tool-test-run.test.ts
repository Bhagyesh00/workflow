/**
 * P5-76 Test a tool, on the real Agent and real tool nodes: the tool runs with the values, and the Agent does not
 * run, so no model is asked and no other tool is touched.
 */
import { type ExecutionServices, NodeTypes, WorkflowExecute } from '@workflow/core';
import { nodes as baseNodes } from '@workflow/nodes-base';
import { type DataObject, Workflow, type WorkflowNode, withToolVariants } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import {
  connect,
  FakeHttpClient,
  type Link,
  modelRequests,
  node,
  scriptModel,
  services,
  testNodes,
} from './harness';

const SECRET = 'cred-value-do-not-leak';
const types = new NodeTypes(withToolVariants([...nodes, ...baseNodes, ...testNodes]));

const agent = () => node('Agent', 'ai.agent', { promptType: 'define', text: '={{ $json.nope.deeper }}' });

function httpTool(parameters: DataObject, name = 'Call API'): WorkflowNode {
  return node(
    name,
    'core.httpRequestTool',
    { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', ...parameters },
    { credentials: { httpHeaderAuth: { id: 'c1', name: 'c1' } } },
  );
}

const CITY_TOOL = {
  method: 'POST',
  url: `=https://api.test/cities/{{ $fromAI('city', 'The city', 'string') }}`,
  sendBody: true,
  contentType: 'json',
  specifyBody: 'json',
  jsonBody: `={{ JSON.stringify({ days: $fromAI('days', 'How many', 'number'), raw: $fromAI('raw', 'Text') }) }}`,
};

function fakeHttp() {
  return new FakeHttpClient(() => ({
    body: { temperature: 21 },
    headers: { 'content-type': 'application/json' },
  }));
}

function toolServices(http: FakeHttpClient): ExecutionServices {
  return services({
    creds: { httpHeaderAuth: { name: 'X-Api-Key', value: SECRET } },
    nodeTypes: types,
    http,
  });
}

async function testTool(
  graph: WorkflowNode[],
  links: Link[],
  toolNode: string,
  query: DataObject,
  http = fakeHttp(),
) {
  const placed = graph.map((n, i) => ({ ...n, position: [i * 200, 0] as [number, number] }));
  const workflow = new Workflow(
    { id: 'wf1', name: 'test', nodes: placed, connections: connect(...links) },
    types,
  );
  const result = await new WorkflowExecute(workflow, toolServices(http)).run({
    startNode: placed[0].name,
    destinationNode: toolNode,
    agentRequest: { query, toolName: toolNode },
    triggerItems: [{ json: { from: 'trigger' } }],
  });
  return { result, http, runData: result.state.resultData.runData, error: result.state.resultData.error };
}

beforeEach(() => {
  scriptModel('Model', []);
});

describe('test a tool under the real Agent', () => {
  it('runs the tool with typed values; no root task and no model request', async () => {
    const tool = httpTool(CITY_TOOL);
    const { result, http, runData } = await testTool(
      [node('Trigger', 'test.trigger'), agent(), node('Model', 'test.fakeChatModel'), tool],
      [
        ['Trigger', 'Agent'],
        ['Model', 'Agent', 'ai_languageModel'],
        ['Call API', 'Agent', 'ai_tool'],
      ],
      'Call API',
      { city: 'Pune', days: '3', raw: '={{ 1 + 1 }}' },
    );

    expect(result.status).toBe('success');
    expect(modelRequests.get('Model')).toEqual([]);
    expect(runData.Agent).toBeUndefined();
    expect(runData.Model).toBeUndefined();
    expect(Object.keys(runData).sort()).toEqual(['Call API', 'Trigger']);

    expect(http.requests).toHaveLength(1);
    expect(http.requests[0].url).toBe('https://api.test/cities/Pune');
    // typed from the string, and the value that looks like an expression stays text
    expect(http.requests[0].body).toEqual({ days: 3, raw: '={{ 1 + 1 }}' });

    const task = runData['Call API'][0];
    expect(task.executionStatus).toBe('success');
    expect(task.source).toEqual([{ previousNode: 'Agent' }]);
    expect(task.inputOverride?.ai_tool?.[0]?.[0]?.json).toEqual({
      city: 'Pune',
      days: 3,
      raw: '={{ 1 + 1 }}',
    });
    expect(task.data?.ai_tool?.[0]?.[0]?.json).toMatchObject({ response: [{ temperature: 21 }] });
  });

  it('the credential goes out with the request and stays out of the run data', async () => {
    const { http, result } = await testTool(
      [node('Trigger', 'test.trigger'), agent(), httpTool({ url: 'https://api.test/fixed' })],
      [
        ['Trigger', 'Agent'],
        ['Call API', 'Agent', 'ai_tool'],
      ],
      'Call API',
      {},
    );
    expect(result.status).toBe('success');
    const header = Object.entries(http.requests[0].headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'x-api-key',
    );
    expect(header?.[1]).toBe(SECRET);
    expect(JSON.stringify(result.state)).not.toContain(SECRET);
  });

  it('a tool with no $fromAI works with an empty query, under an Agent with no parents', async () => {
    const { result, http, runData } = await testTool(
      [agent(), httpTool({ url: 'https://api.test/fixed' })],
      [['Call API', 'Agent', 'ai_tool']],
      'Call API',
      {},
    );
    expect(result.status).toBe('success');
    expect(http.requests[0].url).toBe('https://api.test/fixed');
    expect(Object.keys(runData)).toEqual(['Call API']);
  });

  it('a tool that builds itself in supplyData converts and runs', async () => {
    const { result, runData } = await testTool(
      [node('Trigger', 'test.trigger'), agent(), node('Sum', 'ai.toolCalculator')],
      [
        ['Trigger', 'Agent'],
        ['Sum', 'Agent', 'ai_tool'],
      ],
      'Sum',
      { input: '2 + 3' },
    );
    expect(result.status).toBe('success');
    expect(runData.Sum[0].data?.ai_tool?.[0]?.[0]?.json).toEqual({ response: '5' });
    expect(modelRequests.get('Model')).toEqual([]);
  });

  it('a tool that needs a value it did not get says so', async () => {
    const { error, runData } = await testTool(
      [node('Trigger', 'test.trigger'), agent(), node('Sum', 'ai.toolCalculator')],
      [
        ['Trigger', 'Agent'],
        ['Sum', 'Agent', 'ai_tool'],
      ],
      'Sum',
      {},
    );
    expect(error?.message).toBe('Error executing tool: Missing a value for "input"');
    expect(runData.Sum[0].executionStatus).toBe('error');
  });

  it('the other tools of the Agent are not called', async () => {
    const { http, runData } = await testTool(
      [
        node('Trigger', 'test.trigger'),
        agent(),
        httpTool({ url: 'https://api.test/mine' }, 'Mine'),
        httpTool({ url: 'https://api.test/other' }, 'Other'),
      ],
      [
        ['Trigger', 'Agent'],
        ['Mine', 'Agent', 'ai_tool'],
        ['Other', 'Agent', 'ai_tool'],
      ],
      'Mine',
      {},
    );
    expect(http.requests.map((r) => r.url)).toEqual(['https://api.test/mine']);
    expect(runData.Other).toBeUndefined();
  });

  it('an HTTP failure gives Error executing tool, on the tool', async () => {
    const http = new FakeHttpClient(() => ({ status: 500, body: {} }));
    const { result, error, runData } = await testTool(
      [node('Trigger', 'test.trigger'), agent(), httpTool({ url: 'https://api.test/fixed' })],
      [
        ['Trigger', 'Agent'],
        ['Call API', 'Agent', 'ai_tool'],
      ],
      'Call API',
      {},
      http,
    );
    expect(result.status).toBe('error');
    expect(error?.message).toMatch(/^Error executing tool: /);
    expect(error?.node).toBe('Call API');
    expect(runData['Call API'][0].executionStatus).toBe('error');
    expect(JSON.stringify(result.state)).not.toContain(SECRET);
  });
});
