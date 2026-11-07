/**
 * Phase 5 S1 C0g2 contracts: the demo's tool nodes, Agent version 2 ports, resource mapper loader and
 * a tool test on the run route. The lanes fill the editor's stubs; nothing here asserts a stub.
 */
import { waitFor } from '@testing-library/react';
import type { Connections, ConnectionType, NodeTypeDescription, WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodeTypesApi, workflowsApi } from '../src/api/endpoints';
import type { PushEvent, RunWorkflowBody } from '../src/api/types';
import { demoNodeTypes, demoResourceMapping } from '../src/demo/fixtures';
import { buildCatalog } from '../src/lib/node-catalog';
import { canConnect, deriveNodePorts } from '../src/lib/ports';
import { backend, signedIn } from './backend';

interface Graph {
  nodes: WorkflowNode[];
  connections: Connections;
}

const describeOf = (name: string): NodeTypeDescription => demoNodeTypes.find((d) => d.name === name)!;

const nodeOf = (
  name: string,
  type: string,
  parameters: Record<string, unknown> = {},
  typeVersion = 1,
): WorkflowNode => ({
  id: name,
  name,
  type,
  typeVersion,
  position: [0, 0],
  parameters,
});

const propertyOf = (description: NodeTypeDescription, name: string) =>
  description.properties.find((p) => p.name === name);

describe('core.httpRequestTool', () => {
  const tool = describeOf('core.httpRequestTool');
  const http = describeOf('core.httpRequest');

  it('is a sub-node with the HTTP Request parameters and credentials', () => {
    const ports = deriveNodePorts(nodeOf('Tool', tool.name), tool);
    expect(ports.inputs).toEqual([]);
    expect(ports.outputs.map((p) => p.id)).toEqual(['out:ai_tool:0']);
    expect(ports.isSubNode).toBe(true);
    expect(tool.credentials).toEqual(http.credentials);
    expect(tool.usableAsTool).toBeUndefined();
    expect(tool.properties.slice(1)).toEqual(http.properties);
  });

  it('asks for a description first', () => {
    expect(tool.properties[0]).toMatchObject({
      name: 'toolDescription',
      displayName: 'Description',
      required: true,
      default: http.description,
    });
  });

  it('stays out of the nodes offered after a main output, and fits the ai_tool picker', () => {
    const entry = buildCatalog(demoNodeTypes).find((e) => e.description.name === tool.name);
    expect(entry?.inputTypes).toEqual([]);
    expect(entry?.outputTypes).toEqual(['ai_tool']);
  });
});

describe('app.slackHitlTool', () => {
  const hitl = describeOf('app.slackHitlTool');
  const nodes = [
    nodeOf('Review', hitl.name),
    nodeOf('Review 2', hitl.name),
    nodeOf('Agent', 'ai.agent'),
    nodeOf('Request', 'core.httpRequestTool'),
  ];
  const portsOf = (name: string) => {
    const node = nodes.find((n) => n.name === name);
    return node ? deriveNodePorts(node, describeOf(node.type)) : undefined;
  };
  const connects = (source: string, target: string) =>
    canConnect({ source, sourceHandle: 'out:ai_tool:0', target, targetHandle: 'in:ai_tool:0' }, {}, portsOf);

  it('has the Human review ports', () => {
    const ports = portsOf('Review');
    expect(ports?.inputs.map((p) => [p.id, p.label, p.required])).toEqual([['in:ai_tool:0', 'Tool', true]]);
    expect(ports?.outputs.map((p) => [p.id, p.label])).toEqual([['out:ai_tool:0', 'Human review']]);
    expect(hitl.subtitle).toBe('Send and wait');
    expect(hitl.description).toBe('Request human approval for tools');
    expect(hitl.webhooks?.map((w) => w.httpMethod)).toEqual(['GET', 'POST']);
  });

  it('gates a tool and connects only to an agent', () => {
    expect(connects('Request', 'Review')).toBe(true);
    expect(connects('Review', 'Agent')).toBe(true);
    expect(connects('Review', 'Review 2')).toBe(false);
  });

  it('fixes resource, operation and response type, and asks about the tool by default', () => {
    expect(propertyOf(hitl, 'resource')).toMatchObject({ type: 'hidden', default: 'message' });
    expect(propertyOf(hitl, 'operation')).toMatchObject({ type: 'hidden', default: 'sendAndWait' });
    expect(propertyOf(hitl, 'responseType')).toMatchObject({ type: 'hidden', default: 'approval' });
    expect(propertyOf(hitl, 'message')?.default).toBe(
      '=The agent wants to run this tool: {{ $tool.name }}\n\nInput:\n{{ $tool.parameters }}',
    );
  });
});

describe('ai.agent ports', () => {
  const agent = describeOf('ai.agent');
  const inputs = (parameters: Record<string, unknown>, typeVersion: number) =>
    deriveNodePorts(nodeOf('Agent', 'ai.agent', parameters, typeVersion), agent).inputs.map((p) => [
      p.id,
      p.label,
    ]);
  const base = [
    ['in:main:0', undefined],
    ['in:ai_languageModel:0', 'Chat Model'],
    ['in:ai_memory:0', 'Memory'],
    ['in:ai_tool:0', 'Tool'],
  ];

  it('has both versions, and shows the two options on version 2 only', () => {
    expect(agent.version).toEqual([1, 2]);
    for (const name of ['hasOutputParser', 'needsFallback']) {
      expect(propertyOf(agent, name)).toMatchObject({
        type: 'boolean',
        default: false,
        displayOptions: { show: { '@version': [2] } },
      });
    }
  });

  it('version 1 keeps its four ports, whatever the parameters hold', () => {
    expect(inputs({}, 1)).toEqual(base);
    expect(inputs({ hasOutputParser: true, needsFallback: true }, 1)).toEqual(base);
  });

  it('version 2 starts with the same four', () => {
    expect(inputs({}, 2)).toEqual(base);
  });

  it('version 2 adds the output parser port when the option is on', () => {
    expect(inputs({ hasOutputParser: true }, 2)).toEqual([
      ...base,
      ['in:ai_outputParser:0', 'Output Parser'],
    ]);
  });

  it('version 2 adds a second model slot right after the first', () => {
    expect(inputs({ needsFallback: true }, 2)).toEqual([
      base[0],
      base[1],
      ['in:ai_languageModel:1', 'Fallback Model'],
      base[2],
      base[3],
    ]);
  });

  it('the catalogue sees every port an option can open', () => {
    const entry = buildCatalog(demoNodeTypes).find((e) => e.description.name === 'ai.agent');
    expect(entry?.inputTypes).toEqual(
      expect.arrayContaining(['main', 'ai_languageModel', 'ai_memory', 'ai_tool', 'ai_outputParser']),
    );
  });
});

describe('demo.resourceMapper', () => {
  const mapper = describeOf('demo.resourceMapper');
  const load = (parameters: Record<string, unknown>, method = 'getMappingFields') => {
    const body = {
      nodeType: mapper.name,
      method,
      kind: 'resourceMapping' as const,
      node: nodeOf('Mapper', mapper.name, parameters),
    };
    return nodeTypesApi.resourceMapping(body);
  };

  it('has a resource mapper parameter whose method exists', () => {
    const columns = propertyOf(mapper, 'columns');
    expect(columns?.type).toBe('resourceMapper');
    const options = columns?.typeOptions?.resourceMapper;
    expect(options).toMatchObject({ mode: 'upsert', multiKeyMatch: true, supportAutoMap: true });
    expect(demoResourceMapping[options?.resourceMapperMethod ?? '']).toBeTypeOf('function');
    expect(columns?.typeOptions?.loadOptionsDependsOn).toEqual(['table']);
    expect(columns?.default).toMatchObject({ mappingMode: 'defineBelow', value: null, matchingColumns: [] });
  });

  it('kind resourceMapping loads fields that follow the table', async () => {
    signedIn();
    const contacts = await load({ table: 'contacts' });
    expect(contacts.fields.map((f) => f.id)).toEqual(['email', 'name', 'age', 'active', 'notes']);
    expect(contacts.fields[0]).toMatchObject({ required: true, defaultMatch: true, canBeUsedToMatch: true });
    expect(contacts.fields[4].display).toBe(false);
    const deals = await load({ table: 'deals' });
    expect(deals.fields.map((f) => f.id)).toEqual(['id', 'title', 'stage', 'closesAt']);
    expect(deals.fields[2].options?.map((o) => o.value)).toEqual(['lead', 'won']);
  });

  it('an empty table gives no fields and a notice', async () => {
    signedIn();
    expect(await load({ table: 'empty' })).toEqual({
      fields: [],
      emptyFieldsNotice: 'This table has no columns yet',
    });
  });

  it('refuses an unknown method, a viewer and a signed-out caller', async () => {
    await expect(load({})).rejects.toMatchObject({ status: 401 });
    signedIn();
    await expect(load({}, 'nope')).rejects.toMatchObject({ status: 400, code: 'unknown_method' });
    backend().memberships[0].role = 'viewer';
    await expect(load({})).rejects.toMatchObject({ status: 403 });
  });
});

describe('POST /workflows/:id/run with agentRequest', () => {
  const link = (node: string, type: ConnectionType): Connections[string] => ({
    [type]: [[{ node, type, index: 0 }]],
  });
  const graph: Graph = {
    nodes: [
      nodeOf('Start', 'core.manualTrigger'),
      nodeOf('Agent', 'ai.agent', { text: '={{ $json.nope.deeper }}' }),
      nodeOf('Model', 'ai.lmChatDemo'),
      nodeOf('Request', 'core.httpRequestTool'),
      nodeOf('After', 'core.noOp'),
    ],
    connections: {
      Start: link('Agent', 'main'),
      Agent: link('After', 'main'),
      Model: link('Agent', 'ai_languageModel'),
      Request: link('Agent', 'ai_tool'),
    },
  };
  const request = { query: { url: 'https://example.com', text: '={{ 1 + 1 }}' }, toolName: 'Request' };

  beforeEach(() => {
    signedIn();
  });

  /** runs and returns the finished execution, with the node names its push events named */
  async function run(input: Graph, body: RunWorkflowBody) {
    const wf = backend().seedWorkflow({ name: 'Tool test', ...input });
    const events: PushEvent[] = [];
    const close = backend().subscribe((event) => events.push(event));
    const { executionId } = await workflowsApi.run(wf.id, body);
    await waitFor(() =>
      expect(backend().executions.find((e) => e.id === executionId)?.status).not.toBe('running'),
    );
    close();
    const execution = backend().executions.find((e) => e.id === executionId)!;
    const named = events.flatMap((e) =>
      e.type === 'nodeExecuteBefore' || e.type === 'nodeExecuteAfter' ? [e.data.nodeName] : [],
    );
    return { execution, events, named };
  }

  it('marks the tool run, leaves the root out and stops there', async () => {
    const { execution, named, events } = await run(graph, {
      destinationNode: 'Request',
      agentRequest: request,
    });
    expect(execution.status).toBe('success');
    const { runData, lastNodeExecuted } = execution.state.resultData;
    expect(Object.keys(runData).sort()).toEqual(['Request', 'Start']);
    expect(lastNodeExecuted).toBe('Request');
    expect(execution.state.startData?.destinationNode).toBe('Agent');
    expect(runData.Request).toHaveLength(1);
    expect(runData.Request[0]).toMatchObject({
      executionStatus: 'success',
      source: [{ previousNode: 'Agent' }],
    });
    expect(named).not.toContain('Agent');
    expect(named).toContain('Request');
    expect(events.filter((e) => e.type === 'executionFinished')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('executionFinished');
  });

  it('keeps the query as data', async () => {
    const { execution } = await run(graph, { destinationNode: 'Request', agentRequest: request });
    const task = execution.state.resultData.runData.Request[0];
    expect(task.inputOverride?.ai_tool?.[0]?.[0]?.json).toEqual(request.query);
  });

  it('tests a tool behind a Human review node, under the agent', async () => {
    const { execution } = await run(
      {
        nodes: [...graph.nodes, nodeOf('Review', 'app.slackHitlTool')],
        connections: {
          ...graph.connections,
          Request: link('Review', 'ai_tool'),
          Review: link('Agent', 'ai_tool'),
        },
      },
      { destinationNode: 'Request', agentRequest: request },
    );
    expect(Object.keys(execution.state.resultData.runData).sort()).toEqual(['Request', 'Start']);
    expect(execution.state.startData?.destinationNode).toBe('Agent');
  });

  it('an Agent with no trigger connected is a root too', async () => {
    const { execution } = await run(
      {
        nodes: [nodeOf('Agent', 'ai.agent'), nodeOf('Request', 'core.httpRequestTool')],
        connections: { Request: link('Agent', 'ai_tool') },
      },
      { destinationNode: 'Request', agentRequest: { query: {}, toolName: 'Request' } },
    );
    expect(execution.status).toBe('success');
    expect(Object.keys(execution.state.resultData.runData)).toEqual(['Request']);
  });

  it('fails clearly with no destination or an unknown one', async () => {
    const none = await run(graph, { agentRequest: request });
    expect(none.execution.status).toBe('error');
    expect(none.execution.errorMessage).toBe('A tool test needs a destination node');
    const unknown = await run(graph, { destinationNode: 'Gone', agentRequest: request });
    expect(unknown.execution.status).toBe('error');
    expect(unknown.execution.errorMessage).toBe('Destination node "Gone" does not exist');
  });

  it('a run without agentRequest still runs the root as a node', async () => {
    const graphWithValidPrompt = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.name === 'Agent' ? nodeOf('Agent', 'ai.agent', { text: 'hello' }) : n,
      ),
    };
    const { execution } = await run(graphWithValidPrompt, {});
    expect(execution.status).toBe('success');
    expect(Object.keys(execution.state.resultData.runData)).toEqual(
      expect.arrayContaining(['Start', 'Agent', 'Model', 'Request', 'After']),
    );
    expect(execution.state.resultData.runData.Agent).toHaveLength(1);
  });
});
