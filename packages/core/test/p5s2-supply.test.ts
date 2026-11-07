/**
 * P5 S2 C0: a sub-node sees the main-input parents of the root it feeds (`SupplyDataContext.getParentNodes`), also
 * through a chain of sub-nodes and in a tool test, and a node run as a tool says it may wait only when it can.
 */
import {
  type AiTool,
  type ConnectedNode,
  type Connections,
  type DataObject,
  type NodeType,
  type NodeTypeDescription,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { NodeTypes, WorkflowExecute } from '../src';
import { connect, node, services, testNodes } from './helpers';

function description(
  name: string,
  inputs: NodeTypeDescription['inputs'],
  outputs: NodeTypeDescription['outputs'],
  extra: Partial<NodeTypeDescription> = {},
): NodeTypeDescription {
  return {
    name,
    displayName: name,
    description: name,
    group: ['transform'],
    version: 1,
    defaults: { name },
    inputs,
    outputs,
    properties: [],
    ...extra,
  };
}

/** what each sub-node saw, by node name */
let seen: Record<string, ConnectedNode[]> = {};
/** the `canWait` of each tool the agent got, by tool name */
let waits: Record<string, boolean | undefined> = {};

const toolOf = (name: string): AiTool => ({
  kind: 'tool',
  name,
  description: name,
  parameters: { type: 'object', properties: {} },
  invoke: async () => 'done',
});

const WEBHOOKS: NodeTypeDescription['webhooks'] = [
  { name: 'default', httpMethod: 'GET', path: 'answer', restartWebhook: true },
];

const sendTool: NodeType = {
  description: description('s2.sendTool', [], ['ai_tool'], {
    webhooks: WEBHOOKS,
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        default: 'post',
        options: [
          { name: 'Post', value: 'post' },
          { name: 'Send and Wait', value: 'sendAndWait' },
        ],
      },
    ],
  }),
  async execute(ctx) {
    return [ctx.getInputData()];
  },
};

const types = new NodeTypes([
  ...testNodes,
  {
    description: description(
      's2.agent',
      [
        'main',
        { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 },
        { type: 'ai_tool', displayName: 'Tool' },
      ],
      ['main'],
    ),
    async execute(ctx) {
      await ctx.getInputConnectionData('ai_memory', 0);
      const tools = (await ctx.getInputConnectionData('ai_tool', 0)) as AiTool[];
      for (const tool of tools) waits[tool.name] = tool.canWait;
      return [ctx.getInputData()];
    },
  },
  {
    description: description('s2.memory', [], ['ai_memory']),
    async supplyData(ctx) {
      seen[ctx.getNode().name] = ctx.getParentNodes();
      return { response: { kind: 'memory' } };
    },
  },
  {
    // an Agent Tool: a tool with its own memory and tools
    description: description(
      's2.agentTool',
      [
        { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 },
        { type: 'ai_tool', displayName: 'Tool' },
      ],
      ['ai_tool'],
    ),
    async supplyData(ctx, itemIndex) {
      seen[ctx.getNode().name] = ctx.getParentNodes();
      await ctx.getInputConnectionData('ai_memory', itemIndex);
      await ctx.getInputConnectionData('ai_tool', itemIndex);
      return { response: toolOf(ctx.getNode().name) };
    },
  },
  {
    description: description('s2.recordTool', [], ['ai_tool']),
    async supplyData(ctx) {
      seen[ctx.getNode().name] = ctx.getParentNodes();
      return { response: toolOf(ctx.getNode().name) };
    },
  },
  sendTool,
  {
    description: description('s2.webhookTool', [], ['ai_tool'], { webhooks: WEBHOOKS }),
    async execute(ctx) {
      return [ctx.getInputData()];
    },
  },
  {
    description: description('s2.plainTool', [], ['ai_tool']),
    async execute(ctx) {
      return [ctx.getInputData()];
    },
  },
]);

const link = (to: string, type: 'ai_memory' | 'ai_tool') => ({ [type]: [[{ node: to, type, index: 0 }]] });

const run = (nodes: WorkflowNode[], connections: Connections, startNode = 'Start') =>
  new WorkflowExecute(
    new Workflow({ name: 'supply', nodes, connections }, types),
    services({ nodeTypes: types }),
  ).run({ startNode });

/** Start -> Prepare -> Agent, the main chain a root sits on */
const mainChain = (): WorkflowNode[] => [
  node('Start', 'test.trigger'),
  node('Prepare', 'test.set', [100, 0]),
  node('Agent', 's2.agent', [200, 0]),
];
const PARENTS: ConnectedNode[] = [
  { name: 'Prepare', type: 'test.set' },
  { name: 'Start', type: 'test.trigger' },
];

beforeEach(() => {
  seen = {};
  waits = {};
});

describe('SupplyDataContext.getParentNodes', () => {
  it('a sub-node of a root sees the main parents of the root, nearest first, down to the trigger', async () => {
    const result = await run([...mainChain(), node('Memory', 's2.memory', [200, 200])], {
      ...connect(['Start', 'Prepare'], ['Prepare', 'Agent']),
      Memory: link('Agent', 'ai_memory'),
    });
    expect(result.status).toBe('success');
    expect(seen.Memory).toEqual(PARENTS);
  });

  it('a sub-node of a sub-node sees the parents of the root, not of the node it hangs from', async () => {
    const result = await run(
      [
        ...mainChain(),
        node('Sub', 's2.agentTool', [200, 200]),
        node('Memory', 's2.memory', [200, 400]),
        node('Inner', 's2.recordTool', [300, 400]),
      ],
      {
        ...connect(['Start', 'Prepare'], ['Prepare', 'Agent']),
        Sub: link('Agent', 'ai_tool'),
        Memory: link('Sub', 'ai_memory'),
        Inner: link('Sub', 'ai_tool'),
      },
    );
    expect(result.status).toBe('success');
    expect(seen.Sub).toEqual(PARENTS);
    expect(seen.Memory).toEqual(PARENTS);
    expect(seen.Inner).toEqual(PARENTS);
  });

  it('a root with no parents gives []', async () => {
    const result = await run(
      [node('Agent', 's2.agent'), node('Memory', 's2.memory', [0, 200])],
      { Memory: link('Agent', 'ai_memory') },
      'Agent',
    );
    expect(result.status).toBe('success');
    expect(seen.Memory).toEqual([]);
  });

  it('a node off the main chain of the root is not a parent', async () => {
    const result = await run(
      [...mainChain(), node('Memory', 's2.memory', [200, 200]), node('Elsewhere', 'test.trigger', [0, 400])],
      { ...connect(['Start', 'Prepare'], ['Prepare', 'Agent']), Memory: link('Agent', 'ai_memory') },
    );
    expect(result.status).toBe('success');
    expect(seen.Memory?.map(({ name }) => name)).not.toContain('Elsewhere');
  });

  describe('a tool under test through runToolExecutor', () => {
    const testTool = (
      nodes: WorkflowNode[],
      connections: Connections,
      toolName: string,
      startNode?: string,
    ) =>
      new WorkflowExecute(
        new Workflow({ name: 'tool test', nodes, connections }, types),
        services({ nodeTypes: types }),
      ).run({
        startNode,
        destinationNode: toolName,
        agentRequest: { query: {}, toolName },
        triggerItems: [{ json: { from: 'trigger' } }],
      });

    it('sees the parents of its root', async () => {
      const result = await testTool(
        [...mainChain(), node('Tool', 's2.recordTool', [200, 200])],
        { ...connect(['Start', 'Prepare'], ['Prepare', 'Agent']), Tool: link('Agent', 'ai_tool') },
        'Tool',
      );
      expect(result.status).toBe('success');
      expect(seen.Tool).toEqual(PARENTS);
    });

    it('under an Agent Tool, sees the parents of the Agent', async () => {
      const result = await testTool(
        [...mainChain(), node('Sub', 's2.agentTool', [200, 200]), node('Tool', 's2.recordTool', [200, 400])],
        {
          ...connect(['Start', 'Prepare'], ['Prepare', 'Agent']),
          Sub: link('Agent', 'ai_tool'),
          Tool: link('Sub', 'ai_tool'),
        },
        'Tool',
      );
      expect(result.status).toBe('success');
      expect(seen.Tool).toEqual(PARENTS);
    });

    it('with no root, a lone tool gives []', async () => {
      const result = await testTool([node('Tool', 's2.recordTool')], {}, 'Tool', 'Tool');
      expect(result.status).toBe('success');
      expect(seen.Tool).toEqual([]);
    });
  });
});

describe('AiTool.canWait of a node run as a tool', () => {
  const toolUnderAgent = (type: string, parameters: DataObject = {}) =>
    run(
      [
        node('Start', 'test.trigger'),
        node('Agent', 's2.agent', [200, 0]),
        node('Tool', type, [200, 200], { parameters: parameters as WorkflowNode['parameters'] }),
      ],
      { ...connect(['Start', 'Agent']), Tool: link('Agent', 'ai_tool') },
    );

  it.each([
    ['a send-and-wait capable node on its default, non-wait operation', {}, false],
    ['a send-and-wait capable node on another operation', { operation: 'post' }, false],
    ['a send-and-wait capable node on sendAndWait', { operation: 'sendAndWait' }, true],
    ['an expression that resolves to another operation', { operation: '={{ "post" }}' }, false],
    ['an expression that resolves to sendAndWait', { operation: '={{ "sendAndWait" }}' }, true],
    [
      'a $fromAI operation, not known until the model calls',
      { operation: "={{ $fromAI('operation') }}" },
      true,
    ],
  ])('%s', async (_, parameters, expected) => {
    const result = await toolUnderAgent('s2.sendTool', parameters);
    expect(result.status).toBe('success');
    expect(waits.Tool).toBe(expected);
  });

  it('a node with webhooks and no choice of operation may wait', async () => {
    await toolUnderAgent('s2.webhookTool');
    expect(waits.Tool).toBe(true);
  });

  it('a node with no webhooks never waits', async () => {
    await toolUnderAgent('s2.plainTool');
    expect(waits.Tool).toBe(false);
  });
});

describe('the sub-agent guard uses the same rule', () => {
  const underSubAgent = (parameters: DataObject) =>
    run(
      [
        node('Start', 'test.trigger'),
        node('Agent', 's2.agent', [200, 0]),
        node('Sub', 's2.agentTool', [200, 200]),
        node('Send', 's2.sendTool', [200, 400], { parameters: parameters as WorkflowNode['parameters'] }),
      ],
      { ...connect(['Start', 'Agent']), Sub: link('Agent', 'ai_tool'), Send: link('Sub', 'ai_tool') },
    );

  it('refuses a waiting operation with its text', async () => {
    const result = await underSubAgent({ operation: 'sendAndWait' });
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.message).toBe(
      'Nodes that wait for an answer cannot be used inside a sub-agent. Move "Send" to the top-level workflow.',
    );
  });

  it('lets a non-wait operation through', async () => {
    const result = await underSubAgent({ operation: 'post' });
    expect(result.status).toBe('success');
  });
});
