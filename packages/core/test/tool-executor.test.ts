/** P5-76 Test a tool: the root of a tool, and one call of the tool in the root's place. */
import {
  type AiTool,
  type DataObject,
  type NodeType,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { NodeTypes, toolRootOf, WorkflowExecute } from '../src';
import { connect, node, services, testNodes } from './helpers';

const calls = { agent: 0, parent: 0, supplied: 0, sibling: 0, closed: 0, invokes: [] as DataObject[] };

/** runs when it is treated as a node; a tool test must never get here */
const agentNode: NodeType = {
  description: {
    name: 'test.rootAgent',
    displayName: 'Agent',
    description: 'Root',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Agent' },
    inputs: ['main', { type: 'ai_tool', displayName: 'Tool' }],
    outputs: ['main'],
    properties: [],
  },
  async execute(ctx) {
    calls.agent++;
    return [ctx.getInputData()];
  },
};

/** shaped like the AI Agent Tool stub: a tool with tools of its own */
const agentToolNode: NodeType = {
  description: {
    ...agentNode.description,
    name: 'test.agentTool',
    displayName: 'Agent Tool',
    defaults: { name: 'Agent Tool' },
    inputs: [{ type: 'ai_tool', displayName: 'Tool' }],
    outputs: ['ai_tool'],
  },
  async execute() {
    calls.agent++;
    return [[{ json: { from: 'agent tool' } }]];
  },
};

const parentNode: NodeType = {
  description: {
    ...agentNode.description,
    name: 'test.parent',
    displayName: 'Parent',
    defaults: { name: 'Parent' },
    inputs: ['main'],
  },
  async execute(ctx) {
    calls.parent++;
    return [ctx.getInputData().map((item) => ({ json: { ...item.json, parent: ctx.getNode().name } }))];
  },
};

/** a tool variant: reads its parameters with `$fromAI` and gives them back */
const echoToolNode: NodeType = {
  description: {
    name: 'test.echoTool',
    displayName: 'Echo Tool',
    description: 'Gives back what it reads',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Echo Tool' },
    inputs: [],
    outputs: ['ai_tool'],
    properties: [
      { displayName: 'Description', name: 'toolDescription', type: 'string', default: '' },
      { displayName: 'Count', name: 'count', type: 'string', default: '' },
      { displayName: 'On', name: 'on', type: 'string', default: '' },
      { displayName: 'Data', name: 'data', type: 'string', default: '' },
      { displayName: 'Text', name: 'text', type: 'string', default: '' },
    ],
  },
  async execute(ctx) {
    const read = (name: string) => ctx.getNodeParameter(name, 0, '') as DataObject[string];
    return [
      [
        {
          json: {
            count: read('count'),
            on: read('on'),
            data: read('data'),
            text: read('text'),
            input: ctx.getInputData()[0].json,
          },
        },
      ],
    ];
  },
};

const failingToolNode: NodeType = {
  description: { ...echoToolNode.description, name: 'test.failingTool', defaults: { name: 'Failing Tool' } },
  async execute() {
    throw new Error('the tool broke');
  },
};

const waitingToolNode: NodeType = {
  description: { ...echoToolNode.description, name: 'test.waitingTool', defaults: { name: 'Waiting Tool' } },
  async execute(ctx) {
    await ctx.putExecutionToWait(new Date(Date.now() + 60_000));
    return [ctx.getInputData()];
  },
};

/** a sub-node that builds its own tool in supplyData, with a name that is not the node's */
const suppliedTool = (tool: AiTool): NodeType => ({
  description: {
    ...echoToolNode.description,
    name: 'test.nativeTool',
    defaults: { name: 'Native' },
    properties: [],
  },
  async supplyData(ctx) {
    calls.supplied++;
    const logged: AiTool = {
      ...tool,
      async invoke(args, options) {
        calls.invokes.push(args);
        const result = await tool.invoke(args, options);
        ctx.logSubNodeRun({ input: args }, { response: result as DataObject[string] });
        return result;
      },
    };
    return {
      response: logged,
      closeFunction: async () => {
        calls.closed++;
      },
    };
  },
});

const nativeTool = suppliedTool({
  kind: 'tool',
  name: 'own_name',
  description: 'Native',
  parameters: {
    type: 'object',
    properties: {
      amount: { type: 'number' },
      whole: { type: 'integer' },
      flag: { type: 'boolean' },
      options: { type: 'object', properties: { depth: { type: 'number' } } },
      list: { type: 'array', items: { type: 'number' } },
      name: { type: 'string' },
    },
    required: ['amount'],
  },
  async invoke(args) {
    return { echoed: args };
  },
});

/** logs nothing itself, so the executor records the call */
const silentTool: NodeType = {
  description: { ...echoToolNode.description, name: 'test.silentTool', properties: [] },
  async supplyData() {
    return {
      response: {
        kind: 'tool',
        name: 'silent',
        description: 'Silent',
        parameters: { type: 'object', properties: {} },
        async invoke() {
          return 'quiet result';
        },
      } satisfies AiTool,
    };
  },
};

const siblingTool: NodeType = {
  description: { ...echoToolNode.description, name: 'test.siblingTool', properties: [] },
  async supplyData() {
    calls.sibling++;
    throw new Error('a sibling must not be supplied');
  },
};

const toolkitNode: NodeType = {
  description: { ...echoToolNode.description, name: 'test.toolkit', properties: [] },
  async supplyData() {
    const tool = (name: string): AiTool => ({
      kind: 'tool',
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      async invoke() {
        return `called ${name}`;
      },
    });
    return { response: [tool('first'), tool('second')] };
  },
};

const notAToolSubNode: NodeType = {
  description: {
    ...echoToolNode.description,
    name: 'test.memoryish',
    outputs: ['ai_memory'],
    properties: [],
  },
  async supplyData() {
    return { response: { kind: 'memory' } };
  },
};

const hitlNode: NodeType = {
  description: {
    ...echoToolNode.description,
    name: 'test.reviewHitlTool',
    inputs: [{ type: 'ai_tool', displayName: 'Tool' }],
    properties: [],
  },
  async execute() {
    throw new Error('a review node must not run in a tool test');
  },
};

const types = new NodeTypes([
  ...testNodes,
  agentNode,
  agentToolNode,
  parentNode,
  echoToolNode,
  failingToolNode,
  waitingToolNode,
  nativeTool,
  silentTool,
  siblingTool,
  toolkitNode,
  notAToolSubNode,
  hitlNode,
]);

const toolLink = (to: string) => ({ ai_tool: [[{ node: to, type: 'ai_tool' as const, index: 0 }]] });

function workflowOf(nodes: WorkflowNode[], connections: WorkflowDefinition['connections'] = {}) {
  return new Workflow({ name: 'tool test', nodes, connections }, types);
}

async function testTool(
  nodes: WorkflowNode[],
  connections: WorkflowDefinition['connections'],
  toolNode: string,
  query: DataObject,
) {
  const result = await new WorkflowExecute(
    workflowOf(nodes, connections),
    services({ nodeTypes: types }),
  ).run({
    destinationNode: toolNode,
    agentRequest: { query, toolName: toolNode },
    triggerItems: [{ json: { from: 'trigger' } }],
  });
  return { result, runData: result.state.resultData.runData, error: result.state.resultData.error };
}

const params = {
  count: "={{ $fromAI('count', 'How many', 'number') }}",
  on: "={{ $fromAI('on', 'Switch', 'boolean') }}",
  data: "={{ $fromAI('data', 'Payload', 'json') }}",
  text: "={{ $fromAI('text', 'Words') }}",
};
const echoOf = (name = 'Tool', parameters: DataObject = params) =>
  node(name, 'test.echoTool', [200, 200], { parameters: parameters as WorkflowNode['parameters'] });

const graph = (tool: WorkflowNode = echoOf()) => ({
  nodes: [
    node('Start', 'test.trigger'),
    node('Parent', 'test.parent', [100, 0]),
    node('Agent', 'test.rootAgent', [200, 0]),
    tool,
  ],
  connections: {
    ...connect(['Start', 'Parent'], ['Parent', 'Agent']),
    [tool.name]: toolLink('Agent'),
  },
});

function responseOf(task: { data?: { ai_tool?: Array<Array<{ json: unknown }> | null> | null } }) {
  const json = task.data?.ai_tool?.[0]?.[0]?.json as { response: DataObject[] };
  return json.response[0];
}

beforeEach(() => {
  Object.assign(calls, { agent: 0, parent: 0, supplied: 0, sibling: 0, closed: 0, invokes: [] });
});

describe('toolRootOf', () => {
  it('walks to the Agent a tool hangs from', () => {
    const { nodes, connections } = graph();
    expect(toolRootOf(workflowOf(nodes, connections), 'Tool').name).toBe('Agent');
  });

  it('takes an Agent with no parents as the root', () => {
    const workflow = workflowOf([node('Agent', 'test.rootAgent'), node('Tool', 'test.echoTool')], {
      Tool: toolLink('Agent'),
    });
    expect(toolRootOf(workflow, 'Tool').name).toBe('Agent');
  });

  it('a tool under an AI Agent Tool under an Agent resolves to the Agent', () => {
    const workflow = workflowOf(
      [node('Agent', 'test.rootAgent'), node('Sub', 'test.agentTool'), node('Tool', 'test.echoTool')],
      { Tool: toolLink('Sub'), Sub: toolLink('Agent') },
    );
    expect(toolRootOf(workflow, 'Tool').name).toBe('Agent');
    expect(toolRootOf(workflow, 'Sub').name).toBe('Agent');
  });

  it('a tool behind a sub-node nothing calls has that sub-node as its root; a lone tool is its own', () => {
    const workflow = workflowOf(
      [node('Sub', 'test.agentTool'), node('Tool', 'test.echoTool'), node('Lone', 'test.echoTool')],
      { Tool: toolLink('Sub') },
    );
    expect(toolRootOf(workflow, 'Tool').name).toBe('Sub');
    expect(toolRootOf(workflow, 'Lone').name).toBe('Lone');
  });

  it('a node that is not a sub-node is its own root, and a cycle of sub-nodes ends', () => {
    const workflow = workflowOf(
      [node('Parent', 'test.parent'), node('A', 'test.agentTool'), node('B', 'test.agentTool')],
      { A: toolLink('B'), B: toolLink('A') },
    );
    expect(toolRootOf(workflow, 'Parent').name).toBe('Parent');
    expect(['A', 'B']).toContain(toolRootOf(workflow, 'A').name);
  });

  it('prefers a real root over a sub-node with no caller', () => {
    const workflow = workflowOf(
      [node('Agent', 'test.rootAgent'), node('Sub', 'test.agentTool'), node('Tool', 'test.echoTool')],
      {
        Tool: {
          ai_tool: [
            [
              { node: 'Sub', type: 'ai_tool', index: 0 },
              { node: 'Agent', type: 'ai_tool', index: 0 },
            ],
          ],
        },
      },
    );
    expect(toolRootOf(workflow, 'Tool').name).toBe('Agent');
  });

  it('throws for an unknown node', () => {
    expect(() => toolRootOf(workflowOf([]), 'Gone')).toThrow('Destination node "Gone" does not exist');
  });
});

describe('runToolExecutor', () => {
  it('runs the tool with typed values; the root does not run and its parents run once', async () => {
    const { nodes, connections } = graph();
    const { result, runData } = await testTool(nodes, connections, 'Tool', {
      count: '5',
      on: 'TRUE',
      data: '{"a":1}',
      text: 'plain',
    });
    expect(result.status).toBe('success');
    expect(calls.agent).toBe(0);
    expect(calls.parent).toBe(1);
    expect(Object.keys(runData).sort()).toEqual(['Parent', 'Start', 'Tool']);
    expect(runData.Tool).toHaveLength(1);
    const task = runData.Tool[0];
    expect(task.executionStatus).toBe('success');
    expect(task.source).toEqual([{ previousNode: 'Agent' }]);
    expect(task.inputOverride?.ai_tool?.[0]?.[0]?.json).toEqual({
      count: 5,
      on: true,
      data: { a: 1 },
      text: 'plain',
    });
    const response = responseOf(task);
    expect(response).toMatchObject({ count: 5, on: true, data: { a: 1 }, text: 'plain' });
    // the tool gets the parent's item, as it would from the Agent
    expect(response.input).toMatchObject({ from: 'trigger', parent: 'Parent', count: 5 });
    expect(result.state.resultData.lastNodeExecuted).toBe('Tool');
    expect(result.state.startData.destinationNode).toBe('Agent');
  });

  it('values are data: an expression in a value stays text', async () => {
    const { nodes, connections } = graph();
    const { runData } = await testTool(nodes, connections, 'Tool', {
      count: 1,
      on: false,
      data: { nested: '={{ 1 + 1 }}' },
      text: '={{ (() => { throw new Error("evaluated") })() }}',
    });
    const response = responseOf(runData.Tool[0]);
    expect(response.text).toBe('={{ (() => { throw new Error("evaluated") })() }}');
    expect(response.data).toEqual({ nested: '={{ 1 + 1 }}' });
  });

  it('a JSON value with __proto__ sets no prototype', async () => {
    const { nodes, connections } = graph(node('Tool', 'test.nativeTool'));
    await testTool(nodes, connections, 'Tool', {
      amount: 1,
      options: '{"__proto__":{"polluted":true},"depth":"2"}',
    });
    const options = calls.invokes[0].options as DataObject;
    expect(Object.getPrototypeOf(options)).toBe(Object.prototype);
    expect((options as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(options.depth).toBe(2);
  });

  it('converts by the schema of a tool that supplies itself, whatever its name', async () => {
    const { nodes, connections } = graph(node('Tool', 'test.nativeTool'));
    const { result, runData } = await testTool(nodes, connections, 'Tool', {
      amount: ' 1.5 ',
      whole: '3',
      flag: 'false',
      options: '{"depth":"2"}',
      list: '["1",2]',
      name: '12',
      other: 'kept',
    });
    expect(result.status).toBe('success');
    expect(calls.invokes).toEqual([
      {
        amount: 1.5,
        whole: 3,
        flag: false,
        options: { depth: 2 },
        list: [1, 2],
        name: '12',
        other: 'kept',
      },
    ]);
    expect(runData.Tool).toHaveLength(1);
    expect(calls.closed).toBe(1);
  });

  it.each([
    [{ amount: 'abc' }, '"amount" must be a number'],
    [{ amount: '' }, '"amount" must be a number'],
    [{ amount: 1, whole: '1.5' }, '"whole" must be a whole number'],
    [{ amount: 1, flag: 'yes' }, '"flag" must be true or false'],
    [{ amount: 1, options: '[1]' }, '"options" must be a JSON object'],
    [{ amount: 1, options: 'nope' }, '"options" must be a JSON object'],
    [{ amount: 1, list: '{}' }, '"list" must be a JSON array'],
    [{}, 'Missing a value for "amount"'],
  ])('refuses %j', async (query, message) => {
    const { nodes, connections } = graph(node('Tool', 'test.nativeTool'));
    const { result, error, runData } = await testTool(nodes, connections, 'Tool', query);
    expect(result.status).toBe('error');
    expect(error?.message).toBe(`Error executing tool: ${message}`);
    expect(calls.invokes).toEqual([]);
    expect(runData.Tool[0].executionStatus).toBe('error');
    expect(calls.closed).toBe(1);
  });

  it('a tool with no $fromAI works with an empty query', async () => {
    const { nodes, connections } = graph(echoOf('Tool', { text: 'fixed' }));
    const { result, runData } = await testTool(nodes, connections, 'Tool', {});
    expect(result.status).toBe('success');
    expect(responseOf(runData.Tool[0]).text).toBe('fixed');
  });

  it('a tool under an Agent with no parents runs with one empty item', async () => {
    const result = await new WorkflowExecute(
      workflowOf([node('Agent', 'test.rootAgent'), echoOf('Tool', { text: 'fixed' })], {
        Tool: toolLink('Agent'),
      }),
      services({ nodeTypes: types }),
    ).run({ startNode: 'Agent', destinationNode: 'Tool', agentRequest: { query: {}, toolName: 'Tool' } });
    expect(result.status).toBe('success');
    expect(calls.agent).toBe(0);
    expect(Object.keys(result.state.resultData.runData)).toEqual(['Tool']);
  });

  it('a tool under an AI Agent Tool runs with the Agent as root; neither of them runs', async () => {
    const nodes = [
      node('Start', 'test.trigger'),
      node('Agent', 'test.rootAgent', [200, 0]),
      node('Sub', 'test.agentTool', [200, 200]),
      echoOf('Tool', { text: 'fixed' }),
    ];
    const { result, runData } = await testTool(
      nodes,
      { ...connect(['Start', 'Agent']), Tool: toolLink('Sub'), Sub: toolLink('Agent') },
      'Tool',
      {},
    );
    expect(result.status).toBe('success');
    expect(calls.agent).toBe(0);
    expect(Object.keys(runData).sort()).toEqual(['Start', 'Tool']);
  });

  it('a lone tool runs on its own', async () => {
    const result = await new WorkflowExecute(
      workflowOf([echoOf('Tool', { text: 'fixed' })]),
      services({ nodeTypes: types }),
    ).run({ startNode: 'Tool', destinationNode: 'Tool', agentRequest: { query: {}, toolName: 'Tool' } });
    expect(result.status).toBe('success');
    expect(result.state.resultData.runData.Tool).toHaveLength(1);
  });

  it('does not supply the sibling tools of the tool under test', async () => {
    const { nodes, connections } = graph();
    const { result } = await testTool(
      [...nodes, node('Sibling', 'test.siblingTool')],
      { ...connections, Sibling: toolLink('Agent') },
      'Tool',
      { count: 1, on: true, data: { a: 1 }, text: 'x' },
    );
    expect(result.status).toBe('success');
    expect(calls.sibling).toBe(0);
  });

  it('calls the tool once when the root has two parents that both run', async () => {
    const nodes = [
      node('Start', 'test.trigger'),
      node('A', 'test.parent', [100, 0]),
      node('B', 'test.parent', [100, 100]),
      node('Agent', 'test.rootAgent', [200, 0]),
      node('Tool', 'test.nativeTool', [200, 200]),
    ];
    const { result, runData } = await testTool(
      nodes,
      {
        Start: {
          main: [
            [
              { node: 'A', type: 'main', index: 0 },
              { node: 'B', type: 'main', index: 0 },
            ],
          ],
        },
        ...connect(['A', 'Agent'], ['B', 'Agent']),
        Tool: toolLink('Agent'),
      },
      'Tool',
      { amount: 1 },
    );
    expect(result.status).toBe('success');
    expect(calls.parent).toBe(2);
    expect(calls.invokes).toHaveLength(1);
    expect(runData.Tool).toHaveLength(1);
  });

  it('records the call of a tool that logs nothing itself', async () => {
    const { nodes, connections } = graph(node('Tool', 'test.silentTool'));
    const { runData } = await testTool(nodes, connections, 'Tool', {});
    expect(runData.Tool).toHaveLength(1);
    expect(runData.Tool[0].data?.ai_tool?.[0]?.[0]?.json).toEqual({ response: 'quiet result' });
  });

  it('picks by name from a node that supplies several tools', async () => {
    const { nodes, connections } = graph(node('Tool', 'test.toolkit'));
    const result = await new WorkflowExecute(
      workflowOf(nodes, connections),
      services({ nodeTypes: types }),
    ).run({ destinationNode: 'Tool', agentRequest: { query: {}, toolName: 'second' } });
    expect(result.state.resultData.runData.Tool[0].data?.ai_tool?.[0]?.[0]?.json).toEqual({
      response: 'called second',
    });
    const missing = await testTool(nodes, connections, 'Tool', {});
    expect(missing.error?.message).toBe('No tool inputs found');
  });

  it.each([
    ['a disabled tool', node('Tool', 'test.echoTool', [0, 0], { disabled: true })],
    ['a sub-node that is no tool', node('Tool', 'test.memoryish')],
  ])('%s gives No tool inputs found, on the node', async (_name, tool) => {
    const nodes = [node('Start', 'test.trigger'), node('Agent', 'test.rootAgent', [200, 0]), tool];
    const { result, error, runData } = await testTool(
      nodes,
      { ...connect(['Start', 'Agent']), Tool: toolLink('Agent') },
      'Tool',
      {},
    );
    expect(result.status).toBe('error');
    expect(error?.message).toBe('No tool inputs found');
    expect(error?.node).toBe('Tool');
    expect(runData.Tool?.[0]?.executionStatus).toBe('error');
    expect(calls.agent).toBe(0);
  });

  it('a node that is no tool, on the main path, gives No tool inputs found and does not run', async () => {
    const { result, error } = await testTool(
      [node('Start', 'test.trigger'), node('Tool', 'test.parent', [200, 0])],
      connect(['Start', 'Tool']),
      'Tool',
      {},
    );
    expect(result.status).toBe('error');
    expect(error?.message).toBe('No tool inputs found');
    expect(calls.parent).toBe(0);
  });

  it('a failing tool gives Error executing tool, with one run on the tool', async () => {
    const { nodes, connections } = graph(node('Tool', 'test.failingTool'));
    const { result, error, runData } = await testTool(nodes, connections, 'Tool', {});
    expect(result.status).toBe('error');
    expect(error?.message).toBe('Error executing tool: the tool broke');
    expect(error?.node).toBe('Tool');
    expect(runData.Tool).toHaveLength(1);
    expect(runData.Tool[0].executionStatus).toBe('error');
    expect(result.state.resultData.lastNodeExecuted).toBe('Tool');
  });

  it('a bad $fromAI call gives Error executing tool', async () => {
    const { nodes, connections } = graph(echoOf('Tool', { text: "={{ $fromAI('bad key!') }}" }));
    const { error, runData } = await testTool(nodes, connections, 'Tool', {});
    expect(error?.message).toMatch(/^Error executing tool: /);
    expect(runData.Tool[0].executionStatus).toBe('error');
  });

  it('a tool that would wait fails the test: the run has no way back to the tool', async () => {
    const { nodes, connections } = graph(node('Tool', 'test.waitingTool'));
    const { result, error, runData } = await testTool(nodes, connections, 'Tool', {});
    expect(result.status).toBe('error');
    expect(error?.message).toBe('Error executing tool: A tool test cannot wait for a reply');
    expect(result.state.waitTill).toBeUndefined();
    expect(runData.Tool[0].executionStatus).toBe('error');
    expect(calls.agent).toBe(0);
  });

  it('refuses a Human review node: it only waits for a person', async () => {
    const nodes = [
      node('Start', 'test.trigger'),
      node('Agent', 'test.rootAgent', [200, 0]),
      node('Review', 'test.reviewHitlTool', [200, 200]),
      echoOf('Guarded', { text: 'fixed' }),
    ];
    const connections = {
      ...connect(['Start', 'Agent']),
      Review: toolLink('Agent'),
      Guarded: toolLink('Review'),
    };
    const { error } = await testTool(nodes, connections, 'Review', {});
    expect(error?.message).toBe(
      'Error executing tool: A Human review node waits for a person. Test the tool it guards instead',
    );
    // the guarded tool itself can be tested, as a person runs it by hand
    const guarded = await testTool(nodes, connections, 'Guarded', {});
    expect(guarded.result.status).toBe('success');
    expect(guarded.runData.Review).toBeUndefined();
  });

  it('calls the hook of the tool before its run and never for the root', async () => {
    const seen: string[] = [];
    const { nodes, connections } = graph();
    await new WorkflowExecute(
      workflowOf(nodes, connections),
      services({
        nodeTypes: types,
        hooks: {
          nodeExecuteBefore: async (name) => {
            seen.push(`before ${name}`);
          },
          nodeExecuteAfter: async (name) => {
            seen.push(`after ${name}`);
          },
        },
      }),
    ).run({
      destinationNode: 'Tool',
      agentRequest: { query: { count: 1, on: true, data: { a: 1 }, text: 'x' }, toolName: 'Tool' },
    });
    expect(seen).toEqual([
      'before Start',
      'after Start',
      'before Parent',
      'after Parent',
      'before Tool',
      'after Tool',
    ]);
  });

  it('a canceled test ends as canceled', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow: NodeType = {
      description: { ...echoToolNode.description, name: 'test.slowTool', properties: [] },
      async supplyData() {
        return {
          response: {
            kind: 'tool',
            name: 'slow',
            description: 'Slow',
            parameters: { type: 'object', properties: {} },
            invoke: (_args, options) =>
              new Promise((_resolve, reject) => {
                started();
                options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
              }),
          } satisfies AiTool,
        };
      },
    };
    const withSlow = new NodeTypes([...testNodes, agentNode, slow]);
    const engine = new WorkflowExecute(
      new Workflow(
        {
          name: 'slow',
          nodes: [node('Agent', 'test.rootAgent'), node('Tool', 'test.slowTool')],
          connections: { Tool: toolLink('Agent') },
        },
        withSlow,
      ),
      services({ nodeTypes: withSlow }),
    );
    const finished = engine.run({
      startNode: 'Agent',
      destinationNode: 'Tool',
      agentRequest: { query: {}, toolName: 'Tool' },
    });
    await running;
    engine.cancel('stop');
    expect((await finished).status).toBe('canceled');
  });
});
