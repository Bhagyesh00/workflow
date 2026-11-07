import type {
  ConnectionType,
  DataObject,
  NodeType,
  NodeTypeDescription,
  WorkflowDefinition,
  WorkflowNode,
} from '@workflow/workflow';
import { Workflow } from '@workflow/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeTypes, registriesFromPackages, WorkflowExecute } from '../src';
import type { ToolRunHost } from '../src/engine/node-as-tool';
import { connect, node, services, testNodes } from './helpers';

// the lanes fill these stubs; here only the engine's wiring to them is under test
const mocks = vi.hoisted(() => ({
  createNodeAsTool: vi.fn(),
  createHitlGate: vi.fn(),
  toolRootOf: vi.fn(),
  runToolExecutor: vi.fn(),
}));

vi.mock('../src/engine/node-as-tool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/node-as-tool')>()),
  createNodeAsTool: mocks.createNodeAsTool,
}));
vi.mock('../src/engine/hitl-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/hitl-gate')>()),
  createHitlGate: mocks.createHitlGate,
}));
vi.mock('../src/engine/tool-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/tool-executor')>()),
  toolRootOf: mocks.toolRootOf,
  runToolExecutor: mocks.runToolExecutor,
}));
vi.mock('@workflow/workflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@workflow/workflow')>()),
  isHitlVariant: (description: NodeTypeDescription) => description.name === 'test.hitl',
  withToolVariants: (nodes: NodeType[]) =>
    nodes.flatMap((type) =>
      type.description.name === 'test.variantSource'
        ? [type, { ...type, description: { ...type.description, name: 'test.variantSourceTool' } }]
        : [type],
    ),
}));

/** what the parent node under test got from getInputConnectionData */
let supplied: unknown;

function description(
  name: string,
  inputs: NodeTypeDescription['inputs'],
  outputs: NodeTypeDescription['outputs'],
  properties: NodeTypeDescription['properties'] = [],
): NodeTypeDescription {
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

function parentType(
  name: string,
  inputs: NodeTypeDescription['inputs'],
  properties: NodeTypeDescription['properties'] = [],
  connectionType: ConnectionType = 'ai_languageModel',
): NodeType {
  return {
    description: description(name, inputs, ['main'], properties),
    async execute(ctx) {
      supplied = await ctx.getInputConnectionData(connectionType, 0);
      return [ctx.getInputData()];
    },
  };
}

const valueProperty: NodeTypeDescription['properties'] = [
  { displayName: 'Value', name: 'value', type: 'string', default: '' },
];

const valueType: NodeType = {
  description: description('test.value', [], ['ai_languageModel'], valueProperty),
  async supplyData(ctx, itemIndex) {
    return { response: ctx.getNodeParameter('value', itemIndex) };
  },
};

const toolParameterType: NodeType = {
  description: description('test.toolParameter', [], ['ai_tool'], valueProperty),
  async supplyData(ctx, itemIndex) {
    return { response: ctx.getToolParameter('value', itemIndex, { x: 'from the model' }) };
  },
};

const toolType: NodeType = {
  description: description('test.toolish', [], ['ai_tool']),
  async execute() {
    return [[]];
  },
};

const hitlType: NodeType = {
  description: description('test.hitl', [], ['ai_tool']),
  async execute() {
    return [[]];
  },
};

const twoSlots = parentType('test.twoSlots', [
  'main',
  { type: 'ai_languageModel', maxConnections: 1, required: true },
  { type: 'ai_languageModel', maxConnections: 1 },
]);
const twoOpenSlots = parentType('test.twoOpenSlots', ['main', 'ai_languageModel', 'ai_languageModel']);
const oneSlot = parentType('test.oneSlot', ['main', { type: 'ai_languageModel', maxConnections: 1 }]);
const oneRequiredSlot = parentType('test.oneRequiredSlot', [
  'main',
  { type: 'ai_languageModel', maxConnections: 1, required: true },
]);
const oneOpenSlot = parentType('test.oneOpenSlot', ['main', 'ai_languageModel']);
const countedSlots = parentType(
  'test.countedSlots',
  "={{ Array.from({ length: $parameter.numberInputs }, (_, i) => ({ type: 'ai_languageModel', displayName: 'Model ' + (i + 1), maxConnections: 1 })) }}",
  [{ displayName: 'Inputs', name: 'numberInputs', type: 'number', default: 3 }],
);
const toolParent = parentType('test.toolParent', ['main', 'ai_tool'], [], 'ai_tool');

/** Guardrails' shape: an expression `outputs` reading a parameter that has a default */
const guardType: NodeType = {
  description: description(
    'test.guard',
    ['main'],
    "={{ $parameter.operation === 'classify' ? ['main', 'main'] : ['main'] }}",
    [{ displayName: 'Operation', name: 'operation', type: 'string', default: 'classify' }],
  ),
  async execute(ctx) {
    if (ctx.getInputData()[0]?.json.boom) throw new Error('boom');
    return [[{ json: { pass: 1 } }], [{ json: { fail: 1 } }]];
  },
};

const extraTypes = [
  valueType,
  toolParameterType,
  toolType,
  hitlType,
  twoSlots,
  twoOpenSlots,
  oneSlot,
  oneRequiredSlot,
  oneOpenSlot,
  countedSlots,
  toolParent,
  guardType,
];

function engine(definition: WorkflowDefinition, overrides: Parameters<typeof services>[0] = {}) {
  const types = new NodeTypes([...testNodes, ...extraTypes]);
  return new WorkflowExecute(new Workflow(definition, types), services({ nodeTypes: types, ...overrides }));
}

function modelLink(parent: string, index: number) {
  return { ai_languageModel: [[{ node: parent, type: 'ai_languageModel' as ConnectionType, index }]] };
}

function toolLink(parent: string) {
  return { ai_tool: [[{ node: parent, type: 'ai_tool' as ConnectionType, index: 0 }]] };
}

interface Model {
  name: string;
  value: string;
  slot: number;
  disabled?: boolean;
}

function slotWorkflow(type: string, models: Model[], parameters: DataObject = {}): WorkflowDefinition {
  return {
    name: 'slots',
    nodes: [
      node('Trigger', 'test.trigger'),
      node('Parent', type, [200, 0], { parameters }),
      ...models.map((model, i) =>
        node(model.name, 'test.value', [200, 200 + i * 100], {
          parameters: { value: model.value },
          disabled: model.disabled ?? false,
        }),
      ),
    ],
    connections: {
      ...connect(['Trigger', 'Parent']),
      ...Object.fromEntries(models.map((model) => [model.name, modelLink('Parent', model.slot)])),
    },
  };
}

function toolWorkflow(subName: string, subType: string, parameters: DataObject = {}): WorkflowDefinition {
  return {
    name: 'tools',
    nodes: [
      node('Trigger', 'test.trigger'),
      node('Parent', 'test.toolParent', [200, 0]),
      node(subName, subType, [200, 200], { parameters }),
    ],
    connections: {
      ...connect(['Trigger', 'Parent']),
      [subName]: toolLink('Parent'),
    },
  };
}

const run = (definition: WorkflowDefinition) => engine(definition).run({ triggerItems: [{ json: {} }] });

beforeEach(() => {
  supplied = 'not called';
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe('sub-nodes by slot', () => {
  it('two ports of one type give an array by slot', async () => {
    const result = await run(
      slotWorkflow('test.twoSlots', [
        { name: 'A', value: 'a', slot: 0 },
        { name: 'B', value: 'b', slot: 1 },
      ]),
    );
    expect(result.status).toBe('success');
    expect(supplied).toEqual(['a', 'b']);
  });

  it('a connected slot 2 with an empty slot 1 keeps its index', async () => {
    const result = await run(slotWorkflow('test.twoSlots', [{ name: 'B', value: 'b', slot: 1 }]));
    expect(result.status).toBe('success');
    const slots = supplied as unknown[];
    expect(slots).toHaveLength(2);
    expect(slots[0]).toBeUndefined();
    expect(slots[1]).toBe('b');
  });

  it('checks no required port per slot: the parent decides', async () => {
    const result = await run(slotWorkflow('test.twoSlots', []));
    expect(result.status).toBe('success');
    expect(supplied).toEqual([undefined, undefined]);
  });

  it('a slot holding only a disabled node is empty', async () => {
    await run(
      slotWorkflow('test.twoSlots', [
        { name: 'A', value: 'a', slot: 0, disabled: true },
        { name: 'B', value: 'b', slot: 1 },
      ]),
    );
    expect(supplied).toEqual([undefined, 'b']);
  });

  it('a slot follows its port: without maxConnections 1 it holds all its sub-nodes', async () => {
    await run(
      slotWorkflow('test.twoOpenSlots', [
        { name: 'A', value: 'a', slot: 0 },
        { name: 'B', value: 'b', slot: 0 },
      ]),
    );
    expect(supplied).toEqual([['a', 'b'], undefined]);
  });

  it('one port returns as today', async () => {
    await run(slotWorkflow('test.oneSlot', [{ name: 'A', value: 'a', slot: 0 }]));
    expect(supplied).toBe('a');
    await run(slotWorkflow('test.oneSlot', []));
    expect(supplied).toBeUndefined();
    await run(
      slotWorkflow('test.oneOpenSlot', [
        { name: 'A', value: 'a', slot: 0 },
        { name: 'B', value: 'b', slot: 1 },
      ]),
    );
    expect(supplied).toEqual(['a', 'b']);
    await run(slotWorkflow('test.oneOpenSlot', []));
    expect(supplied).toEqual([]);
  });

  it('one required port still fails when nothing is connected', async () => {
    const result = await run(slotWorkflow('test.oneRequiredSlot', []));
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.message).toContain('A sub-node must be connected');
  });

  it('an unset numberInputs uses the default', async () => {
    await run(slotWorkflow('test.countedSlots', [{ name: 'C', value: 'c', slot: 2 }]));
    expect(supplied).toEqual([undefined, undefined, 'c']);
  });

  it('a set numberInputs wins, and a connection past the last port is left out', async () => {
    await run(
      slotWorkflow(
        'test.countedSlots',
        [
          { name: 'B', value: 'b', slot: 1 },
          { name: 'C', value: 'c', slot: 2 },
        ],
        { numberInputs: 2 },
      ),
    );
    expect(supplied).toEqual([undefined, 'b']);
  });
});

describe('output count', () => {
  const guardWorkflow = (parameters: DataObject = {}): WorkflowDefinition => ({
    name: 'guard',
    nodes: [
      node('Trigger', 'test.trigger'),
      node('Guard', 'test.guard', [200, 0], { parameters, onError: 'continueErrorOutput' }),
    ],
    connections: connect(['Trigger', 'Guard']),
  });

  it('an unset parameter with a default gives the right count: Fail stays a regular output', async () => {
    const result = await run(guardWorkflow());
    const main = result.state.resultData.runData.Guard[0].data?.main;
    expect(main).toHaveLength(3);
    expect(main?.[0]?.[0].json).toEqual({ pass: 1 });
    expect(main?.[1]?.[0].json).toEqual({ fail: 1 });
    expect(main?.[2]).toEqual([]);
  });

  it('a failing node routes to the error output after all regular outputs', async () => {
    const result = await engine(guardWorkflow()).run({ triggerItems: [{ json: { boom: true } }] });
    const main = result.state.resultData.runData.Guard[0].data?.main;
    expect(main).toHaveLength(3);
    expect(main?.[0]).toEqual([]);
    expect(main?.[1]).toEqual([]);
    expect(main?.[2]).toHaveLength(1);
    expect(main?.[2]?.[0].error?.message).toBe('boom');
  });

  it('a set parameter still decides the count', async () => {
    const result = await run(guardWorkflow({ operation: 'other' }));
    expect(result.state.resultData.runData.Guard[0].data?.main).toHaveLength(2);
  });
});

describe('a sub-node without supplyData', () => {
  it('runs an execute node with an ai_tool output through createNodeAsTool', async () => {
    let contextNode: string | undefined;
    mocks.createNodeAsTool.mockImplementation(
      (host: ToolRunHost, tool: WorkflowNode, _type: NodeType, parent: WorkflowNode) => {
        contextNode = host.contextDeps(
          tool,
          { node: tool.name, data: {}, source: null },
          0,
          new AbortController().signal,
        ).node.name;
        host.logSubNodeRun(tool, parent, 'ai_tool', { a: 1 }, { b: 2 });
        return { name: 'the tool' };
      },
    );
    const result = await run(toolWorkflow('Tool', 'test.toolish'));
    expect(result.status).toBe('success');
    expect(supplied).toEqual([{ name: 'the tool' }]);
    expect(contextNode).toBe('Tool');

    const [host, tool, type, parent, parentExec, itemIndex, signal] = mocks.createNodeAsTool.mock.calls[0];
    expect(host.state).toBe(result.state);
    expect(tool.name).toBe('Tool');
    expect(type.description.name).toBe('test.toolish');
    expect(parent.name).toBe('Parent');
    expect(parentExec.node).toBe('Parent');
    expect(itemIndex).toBe(0);
    expect(signal).toBeInstanceOf(AbortSignal);

    // the logged run reads as today's logSubNodeRun: one task on the sub-node, under its connection type
    const task = result.state.resultData.runData.Tool[0];
    expect(task.executionStatus).toBe('success');
    expect(task.inputOverride).toEqual({ ai_tool: [[{ json: { a: 1 } }]] });
    expect(task.data).toEqual({ ai_tool: [[{ json: { b: 2 } }]] });
    expect(task.source).toEqual([{ previousNode: 'Parent' }]);
  });

  it('runs a HITL variant through createHitlGate, whose tools join the list', async () => {
    mocks.createHitlGate.mockResolvedValue([{ name: 'gated 1' }, { name: 'gated 2' }]);
    const result = await run(toolWorkflow('Review', 'test.hitl'));
    expect(result.status).toBe('success');
    expect(supplied).toEqual([{ name: 'gated 1' }, { name: 'gated 2' }]);
    expect(mocks.createNodeAsTool).not.toHaveBeenCalled();
    const [, hitl, type, parent, parentExec, itemIndex, signal, closeFunctions] =
      mocks.createHitlGate.mock.calls[0];
    expect(hitl.name).toBe('Review');
    expect(type.description.name).toBe('test.hitl');
    expect(parent.name).toBe('Parent');
    expect(parentExec.node).toBe('Parent');
    expect(itemIndex).toBe(0);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(closeFunctions).toEqual([]);
  });

  it('refuses any other node', async () => {
    const result = await run(toolWorkflow('Plain', 'test.set'));
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.message).toContain(
      'Node "Plain" cannot be used as a ai_tool sub-node',
    );
    expect(mocks.createNodeAsTool).not.toHaveBeenCalled();
    expect(mocks.createHitlGate).not.toHaveBeenCalled();
  });

  it('a supply context reads a parameter with $fromAI bound to the arguments', async () => {
    const result = await run(toolWorkflow('Tool', 'test.toolParameter', { value: "={{ $fromAI('x') }}" }));
    expect(result.status).toBe('success');
    expect(supplied).toEqual(['from the model']);
  });
});

describe('agentRequest', () => {
  const definition: WorkflowDefinition = {
    name: 'tool test',
    nodes: [
      node('Trigger', 'test.trigger'),
      node('Agent', 'test.agent', [200, 0]),
      node('Tool', 'test.toolish', [200, 200]),
    ],
    connections: {
      ...connect(['Trigger', 'Agent']),
      Tool: toolLink('Agent'),
    },
  };
  const agentRequest = { query: { a: 1 }, toolName: 'Tool' };

  function rootIsAgent() {
    mocks.toolRootOf.mockImplementation((workflow: Workflow) => workflow.nodes.Agent);
  }

  it('makes the root the destination, runs the tool, writes no task for the root', async () => {
    rootIsAgent();
    const close = vi.fn(async () => {});
    mocks.runToolExecutor.mockImplementation(
      async (
        host: ToolRunHost,
        request: { query: DataObject },
        _rootExec: unknown,
        _signal: AbortSignal,
        closeFunctions: Array<() => Promise<void>>,
      ) => {
        host.logSubNodeRun(host.workflow.nodes.Tool, host.workflow.nodes.Agent, 'ai_tool', request.query, {
          ok: true,
        });
        closeFunctions.push(close);
      },
    );
    const before: string[] = [];
    const result = await engine(definition, {
      hooks: {
        nodeExecuteBefore: async (name) => {
          before.push(name);
        },
      },
    }).run({ destinationNode: 'Tool', agentRequest, triggerItems: [{ json: { from: 'trigger' } }] });

    expect(result.status).toBe('success');
    expect(mocks.toolRootOf.mock.calls[0][1]).toBe('Tool');
    const [, request, rootExec, signal] = mocks.runToolExecutor.mock.calls[0];
    expect(request).toEqual({ ...agentRequest, rootNode: 'Agent', toolNode: 'Tool' });
    expect(rootExec.node).toBe('Agent');
    expect(rootExec.data.main[0][0].json).toEqual({ from: 'trigger' });
    expect(signal).toBeInstanceOf(AbortSignal);

    const { runData, lastNodeExecuted } = result.state.resultData;
    expect(runData).not.toHaveProperty('Agent');
    expect(runData.Tool).toHaveLength(1);
    expect(lastNodeExecuted).toBe('Tool');
    expect(result.state.startData.destinationNode).toBe('Agent');
    expect(before).toEqual(['Trigger']);
    expect(close).toHaveBeenCalledOnce();
  });

  it('works when the root itself is the start', async () => {
    rootIsAgent();
    const result = await engine(definition).run({
      startNode: 'Agent',
      destinationNode: 'Tool',
      agentRequest,
    });
    expect(result.status).toBe('success');
    expect(mocks.runToolExecutor).toHaveBeenCalledOnce();
    expect(result.state.resultData.runData).not.toHaveProperty('Agent');
    expect(result.state.resultData.runData).not.toHaveProperty('Trigger');
  });

  it('runs before the partial branch: a run with earlier run data stops at the root too', async () => {
    rootIsAgent();
    const first = await engine(definition).run({
      destinationNode: 'Tool',
      agentRequest,
      triggerItems: [{ json: {} }],
    });
    mocks.runToolExecutor.mockClear();
    const result = await engine(definition).run({
      destinationNode: 'Tool',
      agentRequest,
      runData: first.state.resultData.runData,
    });
    expect(result.status).toBe('success');
    expect(mocks.runToolExecutor).toHaveBeenCalledOnce();
    expect(result.state.startData.destinationNode).toBe('Agent');
    expect(result.state.resultData.runData).not.toHaveProperty('Agent');
    expect(result.state.resultData.runData.Trigger).toHaveLength(1);
  });

  it('a failing tool fails the run and still names the tool, with no task for the root', async () => {
    rootIsAgent();
    mocks.runToolExecutor.mockRejectedValue(new Error('Error executing tool: broken'));
    const result = await engine(definition).run({
      destinationNode: 'Tool',
      agentRequest,
      triggerItems: [{ json: {} }],
    });
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.message).toBe('Error executing tool: broken');
    expect(result.state.resultData.lastNodeExecuted).toBe('Tool');
    expect(result.state.resultData.runData).not.toHaveProperty('Agent');
  });

  it('needs a destination that exists', async () => {
    await expect(engine(definition).run({ agentRequest })).rejects.toThrow('destination node');
    await expect(engine(definition).run({ destinationNode: 'Nope', agentRequest })).rejects.toThrow(
      'does not exist',
    );
    expect(mocks.toolRootOf).not.toHaveBeenCalled();
  });

  it('a run without agentRequest runs the root as a node', async () => {
    const modelled: WorkflowDefinition = {
      name: 'plain',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Agent', 'test.agent', [200, 0]),
        node('Model', 'test.model', [200, 200], { parameters: { reply: 'ok' } }),
      ],
      connections: {
        ...connect(['Trigger', 'Agent']),
        Model: modelLink('Agent', 0),
      },
    };
    const result = await run(modelled);
    expect(result.status).toBe('success');
    expect(mocks.runToolExecutor).not.toHaveBeenCalled();
    expect(result.state.resultData.runData.Agent[0].data?.main?.[0]?.[0].json).toEqual({ output: 'ok' });
  });
});

describe('registriesFromPackages', () => {
  it('registers what withToolVariants returns', () => {
    const source: NodeType = {
      description: description('test.variantSource', ['main'], ['main']),
      async execute() {
        return [[]];
      },
    };
    const { nodeTypes } = registriesFromPackages([{ name: 'pkg', nodes: [source], credentials: [] }]);
    expect(nodeTypes.get('test.variantSource')).toBeDefined();
    expect(nodeTypes.get('test.variantSourceTool')?.description.name).toBe('test.variantSourceTool');
  });
});
