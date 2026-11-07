/** P5 S3 C0c: the engine contracts chat and evaluations build on. */
import {
  type AiTool,
  CHAT_TOOL_TYPE,
  CHAT_TRIGGER_TYPE,
  type ChatChunkMeta,
  type ChatTriggerRef,
  type ConnectionType,
  DATASET_GET_ROWS,
  type DataObject,
  ExpressionEvaluator,
  type NodeType,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import {
  createWebhookContext,
  createWebhookSubNodes,
  type ExecutionServices,
  NodeTypes,
  setCustomData,
  WorkflowExecute,
} from '../src';
import { connect, node, services, testNodes } from './helpers';

const main = ['main'] as const;

function described(
  name: string,
  inputs: NodeType['description']['inputs'],
  outputs: NodeType['description']['outputs'],
  properties: NodeType['description']['properties'] = [],
): NodeType['description'] {
  return {
    name,
    displayName: name,
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name },
    inputs,
    outputs,
    properties,
  };
}

/** shaped like the Chat Trigger: a trigger with a memory input and a parameter with a default */
const chatTriggerType: NodeType = {
  description: {
    ...described(
      CHAT_TRIGGER_TYPE,
      [{ type: 'ai_memory', displayName: 'Memory', maxConnections: 1 }],
      [...main],
      [{ displayName: 'Mode', name: 'mode', type: 'string', default: 'hostedChat' }],
    ),
    group: ['trigger'],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    return [items.length ? items : [{ json: {} }]];
  },
};

/** gives back what `getChatTrigger` returns */
const chatReaderType: NodeType = {
  description: described('test.chatReader', [...main], [...main]),
  async execute(ctx) {
    return [[{ json: { trigger: ctx.getChatTrigger() as unknown as DataObject } }]];
  },
};

/** sends chunks for items 0 and 1 */
const chunkerType: NodeType = {
  description: described('test.chunker', [...main], [...main]),
  async execute(ctx) {
    ctx.sendChunk('first');
    ctx.sendChunk('second', { itemIndex: 1 });
    return [ctx.getInputData()];
  },
};

/** an Agent stand-in: calls each of its tools once */
const agentType: NodeType = {
  description: described('test.chatAgent', ['main', { type: 'ai_tool', displayName: 'Tool' }], [...main]),
  async execute(ctx) {
    const tools = (await ctx.getInputConnectionData('ai_tool', 0)) as AiTool[];
    const results: unknown[] = [];
    for (const tool of tools) results.push(await tool.invoke({}));
    return [[{ json: { results: results as DataObject[] } }]];
  },
};

const toolProperties = [
  { displayName: 'Description', name: 'toolDescription', type: 'string' as const, default: 'a tool' },
];

/** a fake Chat tool: sends its message as a chunk, reads the chat trigger */
const chatToolType: NodeType = {
  description: described(CHAT_TOOL_TYPE, [], ['ai_tool'], toolProperties),
  async execute(ctx) {
    ctx.sendChunk('from the chat tool');
    return [[{ json: { trigger: ctx.getChatTrigger()?.name ?? null } }]];
  },
};

/** any other tool that tries to send a chunk */
const httpToolType: NodeType = {
  description: described('core.httpRequestTool', [], ['ai_tool'], toolProperties),
  async execute(ctx) {
    ctx.sendChunk('from the http tool');
    return [[{ json: { ok: true } }]];
  },
};

const closed: string[] = [];

/** a memory stand-in: reads its session key from the parent's item, logs its call, closes later */
const memoryType: NodeType = {
  description: described(
    'test.memory',
    [],
    ['ai_memory'],
    [{ displayName: 'Session', name: 'sessionKey', type: 'string', default: '={{ $json.sessionId }}' }],
  ),
  async supplyData(ctx, itemIndex) {
    const sessionId = ctx.getNodeParameter('sessionKey', itemIndex) as string;
    ctx.logSubNodeRun({ action: 'load' }, { sessionId });
    return {
      response: { kind: 'memory', sessionId },
      closeFunction: async () => {
        closed.push(sessionId);
      },
    };
  },
};

/** an Evaluation Trigger stand-in: `execute` and one custom operation */
const evalTriggerType: NodeType = {
  description: { ...described('test.evalTrigger', [...main], [...main]), group: ['trigger'] },
  async execute() {
    return [[{ json: { from: 'execute' } }]];
  },
  customOperations: {
    [DATASET_GET_ROWS]: async () => [[{ json: { from: 'custom' } }]],
  },
};

const types = new NodeTypes([
  ...testNodes,
  chatTriggerType,
  chatReaderType,
  chunkerType,
  agentType,
  chatToolType,
  httpToolType,
  memoryType,
  evalTriggerType,
]);

function engine(definition: WorkflowDefinition, overrides: Partial<ExecutionServices> = {}) {
  return new WorkflowExecute(new Workflow(definition, types), services({ nodeTypes: types, ...overrides }));
}

function link(type: ConnectionType, parent: string) {
  return { [type]: [[{ node: parent, type, index: 0 }]] };
}

function webhookDeps(
  definition: WorkflowDefinition,
  nodeName: string,
  overrides: Partial<ExecutionServices> = {},
) {
  const workflow = new Workflow(definition, types);
  return {
    workflow,
    node: workflow.nodes[nodeName] as WorkflowNode,
    services: services({ nodeTypes: types, ...overrides }),
    evaluator: new ExpressionEvaluator({ timeoutMs: 1000, maxSteps: 1_000_000 }),
    signal: new AbortController().signal,
  };
}

const request = { method: 'POST', headers: {}, query: {}, params: {}, body: { sessionId: 's-1' } } as never;

describe('customData', () => {
  it('seeds the state from RunOptions', async () => {
    const result = await engine({ name: 'w', nodes: [node('Start', 'test.trigger')], connections: {} }).run({
      customData: { source: 'webhook' },
    });
    expect(result.state.resultData.customData).toEqual({ source: 'webhook' });
  });

  it('stores a 300 character value as 255', async () => {
    const result = await engine({ name: 'w', nodes: [node('Start', 'test.trigger')], connections: {} }).run({
      customData: { long: 'x'.repeat(300) },
    });
    expect(result.state.resultData.customData?.long).toHaveLength(255);
  });

  it('drops an eleventh key without failing the run', async () => {
    const customData = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, String(i)]));
    const result = await engine({ name: 'w', nodes: [node('Start', 'test.trigger')], connections: {} }).run({
      customData,
    });
    expect(result.status).toBe('success');
    expect(result.state.resultData.error).toBeUndefined();
    expect(Object.keys(result.state.resultData.customData ?? {})).toHaveLength(10);
    expect(result.state.resultData.customData?.k10).toBeUndefined();
  });

  it('exports setCustomData with its caps', () => {
    const state = new WorkflowExecute(
      new Workflow({ name: 'w', nodes: [], connections: {} }, types),
      services(),
    ).state;
    for (let i = 0; i < 10; i++) setCustomData(state, `k${i}`, 'v');
    expect(() => setCustomData(state, 'k10', 'v')).toThrow('limited to 10 keys');
  });
});

describe('getChatTrigger', () => {
  const chatGraph = (disabled = false): WorkflowDefinition => ({
    name: 'chat',
    nodes: [
      node('When chat message received', CHAT_TRIGGER_TYPE, [0, 0], { disabled }),
      node('Reader', 'test.chatReader', [200, 0]),
      node('Agent', 'test.chatAgent', [400, 0]),
      node('Chat', CHAT_TOOL_TYPE, [400, 200]),
    ],
    connections: {
      ...connect(['When chat message received', 'Reader'], ['Reader', 'Agent']),
      ...{ Chat: link('ai_tool', 'Agent') },
    },
  });

  it('is found from a main child, with resolved parameters', async () => {
    const result = await engine(chatGraph()).run({ startNode: 'When chat message received' });
    const trigger = result.state.resultData.runData.Reader[0].data?.main?.[0]?.[0]?.json
      .trigger as unknown as ChatTriggerRef;
    expect(trigger).toEqual({
      name: 'When chat message received',
      type: CHAT_TRIGGER_TYPE,
      parameters: { mode: 'hostedChat' },
    });
  });

  it('is found from a tool under an Agent', async () => {
    const result = await engine(chatGraph()).run({ startNode: 'When chat message received' });
    const agentOut = result.state.resultData.runData.Agent[0].data?.main?.[0]?.[0]?.json as DataObject;
    expect(JSON.stringify(agentOut.results)).toContain('When chat message received');
  });

  it('is found from a webhook context', () => {
    const deps = webhookDeps(chatGraph(), 'When chat message received');
    const ctx = createWebhookContext(deps, request, 'default');
    expect(ctx.getChatTrigger()?.name).toBe('When chat message received');
  });

  it('is null when the trigger is disabled', async () => {
    const deps = webhookDeps(chatGraph(true), 'Reader');
    expect(createWebhookContext(deps, request, 'default').getChatTrigger()).toBeNull();
    const result = await engine(chatGraph(true)).run({ startNode: 'Reader' });
    expect(result.state.resultData.runData.Reader[0].data?.main?.[0]?.[0]?.json.trigger).toBeNull();
  });
});

describe('forceOperation', () => {
  const graph: WorkflowDefinition = {
    name: 'eval',
    nodes: [node('Eval', 'test.evalTrigger'), node('Again', 'test.evalTrigger', [200, 0])],
    connections: connect(['Eval', 'Again']),
  };

  it('runs the custom operation on the start node only', async () => {
    const result = await engine(graph).run({ startNode: 'Eval', forceOperation: DATASET_GET_ROWS });
    const { runData } = result.state.resultData;
    expect(runData.Eval[0].data?.main?.[0]?.[0]?.json).toEqual({ from: 'custom' });
    expect(runData.Again[0].data?.main?.[0]?.[0]?.json).toEqual({ from: 'execute' });
  });

  it('fails the node when the type has no such operation', async () => {
    const result = await engine(graph).run({ startNode: 'Eval', forceOperation: 'nope' });
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.message).toBe(
      'Node type "test.evalTrigger" has no operation "nope"',
    );
  });

  it('runs execute without it', async () => {
    const result = await engine(graph).run({ startNode: 'Eval' });
    expect(result.state.resultData.runData.Eval[0].data?.main?.[0]?.[0]?.json).toEqual({ from: 'execute' });
  });
});

describe('pinned start node', () => {
  it('still counts as executed for $(x).isExecuted', async () => {
    const result = await engine({
      name: 'pin',
      nodes: [
        node('Start', 'test.trigger'),
        node('Set', 'test.set', [200, 0], {
          parameters: { field: 'ran', value: "={{ $('Start').isExecuted }}" },
        }),
      ],
      connections: connect(['Start', 'Set']),
    }).run({ pinData: { Start: [{ json: { pinned: true } }] } });
    const json = result.state.resultData.runData.Set[0].data?.main?.[0]?.[0]?.json;
    expect(json).toMatchObject({ pinned: true, ran: true });
  });
});

describe('webhook context sub-nodes', () => {
  const graph: WorkflowDefinition = {
    name: 'chat memory',
    nodes: [node('Chat Trigger', CHAT_TRIGGER_TYPE), node('Memory', 'test.memory', [0, 200])],
    connections: { Memory: link('ai_memory', 'Chat Trigger') },
  };

  it('supplies a sub-node that reads $json.sessionId from the item, and close() runs its close function', async () => {
    closed.length = 0;
    const order: string[] = [];
    const deps = webhookDeps(graph, 'Chat Trigger', {
      hooks: {
        nodeExecuteAfter: async (name) => {
          order.push(`hook:${name}`);
        },
      },
    });
    const subNodes = createWebhookSubNodes(deps, { json: { sessionId: 's-1' } });
    const ctx = createWebhookContext(deps, request, 'default', subNodes.callbacks);
    const memory = await ctx.getInputConnectionData('ai_memory', 0);
    expect(memory).toEqual({ kind: 'memory', sessionId: 's-1' });
    expect(closed).toEqual([]);
    await subNodes.close();
    order.push(...closed.map((s) => `close:${s}`));
    expect(order).toEqual(['hook:Memory', 'close:s-1']);
    await subNodes.close();
    expect(closed).toEqual(['s-1']);
  });

  it('refuses sub-nodes without callbacks', async () => {
    const ctx = createWebhookContext(webhookDeps(graph, 'Chat Trigger'), request, 'default');
    await expect(ctx.getInputConnectionData('ai_memory', 0)).rejects.toThrow(
      'Sub-nodes are not available here',
    );
  });

  it('reads disablePublicChatTrigger', () => {
    const off = createWebhookContext(webhookDeps(graph, 'Chat Trigger'), request, 'default');
    const on = createWebhookContext(
      webhookDeps(graph, 'Chat Trigger', { disablePublicChatTrigger: true }),
      request,
      'default',
    );
    expect(off.isPublicChatDisabled()).toBe(false);
    expect(on.isPublicChatDisabled()).toBe(true);
  });
});

describe('chunk meta', () => {
  it('holds the node, the run and the item', async () => {
    const chunks: Array<[unknown, ChatChunkMeta | undefined]> = [];
    await engine(
      {
        name: 'chunks',
        nodes: [node('Start', 'test.trigger'), node('Chunker', 'test.chunker', [200, 0])],
        connections: connect(['Start', 'Chunker']),
      },
      { hooks: { sendChunk: (chunk, meta) => chunks.push([chunk, meta]) } },
    ).run();
    expect(chunks).toEqual([
      ['first', { nodeId: 'Chunker', nodeName: 'Chunker', runIndex: 0, itemIndex: 0 }],
      ['second', { nodeId: 'Chunker', nodeName: 'Chunker', runIndex: 0, itemIndex: 1 }],
    ]);
  });

  it('under an Agent, a Chat tool sends with its own node and an HTTP Request tool sends none', async () => {
    const chunks: Array<[unknown, ChatChunkMeta | undefined]> = [];
    const result = await engine(
      {
        name: 'tools',
        nodes: [
          node('Start', 'test.trigger'),
          node('Agent', 'test.chatAgent', [200, 0]),
          node('Chat', CHAT_TOOL_TYPE, [200, 200], { id: 'chat-id' }),
          node('HTTP Request', 'core.httpRequestTool', [400, 200]),
        ],
        connections: {
          ...connect(['Start', 'Agent']),
          Chat: link('ai_tool', 'Agent'),
          'HTTP Request': link('ai_tool', 'Agent'),
        },
      },
      { hooks: { sendChunk: (chunk, meta) => chunks.push([chunk, meta]) } },
    ).run();
    expect(result.status).toBe('success');
    expect(chunks).toEqual([
      ['from the chat tool', { nodeId: 'chat-id', nodeName: 'Chat', runIndex: 0, itemIndex: 0 }],
    ]);
  });
});
