import type {
  NodeInputConfig,
  NodeOutputConfig,
  NodeTypeDescription,
  WorkflowNode,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { buildFlowElements } from '../src/components/canvas/flow-elements';
import { demoNodeTypes } from '../src/demo/fixtures';
import { canConnect, deriveNodePorts, handleId, parseHandleId } from '../src/lib/ports';

const types = new Map(demoNodeTypes.map((d) => [d.name, d]));
const get = (name: string) => types.get(name)!;

const node = (
  name: string,
  type: string,
  parameters: Record<string, unknown> = {},
  extra: Partial<WorkflowNode> = {},
): WorkflowNode => ({
  id: `id-${name}`,
  name,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters,
  ...extra,
});

describe('port derivation', () => {
  it('reads static main ports and output names', () => {
    const ports = deriveNodePorts(node('If', 'core.if'), get('core.if'));
    expect(ports.inputs.map((p) => p.id)).toEqual(['in:main:0']);
    expect(ports.outputs.map((p) => [p.id, p.label])).toEqual([
      ['out:main:0', 'true'],
      ['out:main:1', 'false'],
    ]);
    expect(ports.isTrigger).toBe(false);
  });

  it('treats triggers as having no inputs', () => {
    const ports = deriveNodePorts(node('T', 'core.manualTrigger'), get('core.manualTrigger'));
    expect(ports.inputs).toEqual([]);
    expect(ports.isTrigger).toBe(true);
  });

  it('evaluates expression outputs against the node parameters', () => {
    const switchNode = node('Switch', 'core.switch', {
      rules: { values: [{ outputKey: 'eu' }, { outputKey: '' }, { outputKey: 'us' }] },
    });
    const ports = deriveNodePorts(switchNode, get('core.switch'));
    expect(ports.outputs.map((p) => p.label)).toEqual(['eu', 'Output 2', 'us']);
    expect(ports.outputs.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it('uses parameter defaults for expression ports and falls back to one main port on errors', () => {
    expect(
      deriveNodePorts(node('Switch', 'core.switch'), get('core.switch')).outputs.map((p) => p.label),
    ).toEqual(['first']);
    const broken: NodeTypeDescription = { ...get('core.switch'), outputs: '={{ $parameter.nope.deeper }}' };
    expect(deriveNodePorts(node('S', 'core.switch'), broken).outputs.map((p) => p.id)).toEqual([
      'out:main:0',
    ]);
  });

  it('labels AI inputs of root nodes and keeps per-type indexes', () => {
    const ports = deriveNodePorts(node('Agent', 'ai.agent'), get('ai.agent'));
    expect(ports.inputs.map((p) => [p.id, p.label, p.required ?? false, p.maxConnections])).toEqual([
      ['in:main:0', undefined, false, undefined],
      ['in:ai_languageModel:0', 'Chat Model', true, 1],
      ['in:ai_memory:0', 'Memory', false, 1],
      ['in:ai_tool:0', 'Tool', false, undefined],
    ]);
    expect(ports.isSubNode).toBe(false);
  });

  it('recognises sub-nodes by their AI-only outputs', () => {
    const ports = deriveNodePorts(node('Model', 'ai.lmChatDemo'), get('ai.lmChatDemo'));
    expect(ports.isSubNode).toBe(true);
    expect(ports.outputs.map((p) => p.id)).toEqual(['out:ai_languageModel:0']);
  });

  it('adds an error output for continueErrorOutput', () => {
    const ports = deriveNodePorts(
      node('If', 'core.if', {}, { onError: 'continueErrorOutput' }),
      get('core.if'),
    );
    expect(ports.outputs.map((p) => [p.id, p.label, p.category])).toEqual([
      ['out:main:0', 'true', undefined],
      ['out:main:1', 'false', undefined],
      ['out:main:2', 'Error', 'error'],
    ]);
  });

  it('round-trips handle ids', () => {
    expect(parseHandleId(handleId('out', 'ai_tool', 2))).toEqual({
      direction: 'out',
      type: 'ai_tool',
      index: 2,
    });
    expect(parseHandleId('out:bogus:0')).toBeNull();
    expect(parseHandleId(null)).toBeNull();
  });
});

describe('connection rules', () => {
  const nodes = [
    node('Agent', 'ai.agent'),
    node('Model', 'ai.lmChatDemo'),
    node('Model2', 'ai.lmChatDemo'),
    node('Set', 'core.set'),
    node('Tool', 'ai.toolCalculator'),
  ];
  const portsOf = (name: string) => {
    const n = nodes.find((x) => x.name === name);
    return n ? deriveNodePorts(n, get(n.type)) : undefined;
  };

  it('only connects outputs to inputs of the same type', () => {
    expect(
      canConnect(
        {
          source: 'Model',
          sourceHandle: 'out:ai_languageModel:0',
          target: 'Agent',
          targetHandle: 'in:ai_languageModel:0',
        },
        {},
        portsOf,
      ),
    ).toBe(true);
    expect(
      canConnect(
        {
          source: 'Model',
          sourceHandle: 'out:ai_languageModel:0',
          target: 'Agent',
          targetHandle: 'in:ai_tool:0',
        },
        {},
        portsOf,
      ),
    ).toBe(false);
    expect(
      canConnect(
        { source: 'Set', sourceHandle: 'out:main:0', target: 'Agent', targetHandle: 'in:main:0' },
        {},
        portsOf,
      ),
    ).toBe(true);
    expect(
      canConnect(
        { source: 'Set', sourceHandle: 'out:main:0', target: 'Set', targetHandle: 'in:main:0' },
        {},
        portsOf,
      ),
    ).toBe(false);
    expect(
      canConnect(
        { source: 'Set', sourceHandle: 'in:main:0', target: 'Agent', targetHandle: 'in:main:0' },
        {},
        portsOf,
      ),
    ).toBe(false);
  });

  it('respects maxConnections and refuses duplicates', () => {
    const connections = {
      Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel' as const, index: 0 }]] },
    };
    expect(
      canConnect(
        {
          source: 'Model2',
          sourceHandle: 'out:ai_languageModel:0',
          target: 'Agent',
          targetHandle: 'in:ai_languageModel:0',
        },
        connections,
        portsOf,
      ),
    ).toBe(false);
    const tools = { Tool: { ai_tool: [[{ node: 'Agent', type: 'ai_tool' as const, index: 0 }]] } };
    expect(
      canConnect(
        { source: 'Tool', sourceHandle: 'out:ai_tool:0', target: 'Agent', targetHandle: 'in:ai_tool:0' },
        tools,
        portsOf,
      ),
    ).toBe(false);
  });
});

describe('connection filters', () => {
  const described = (
    name: string,
    inputs: NodeInputConfig[],
    outputs: NodeOutputConfig[],
  ): NodeTypeDescription => ({ ...get('core.set'), name, inputs, outputs });
  const filtered = new Map(
    [
      described('test.chatModel', [], [{ type: 'ai_languageModel' }]),
      described('test.completionModel', [], [{ type: 'ai_languageModel' }]),
      described('test.hitlTool', [], [{ type: 'ai_tool', filter: { nodes: ['test.agent'] } }]),
      described('test.plainTool', [], [{ type: 'ai_tool', filter: { nodes: [] } }]),
      described(
        'test.agent',
        [
          { type: 'ai_languageModel', filter: { excludedNodes: ['test.completionModel'] } },
          { type: 'ai_languageModel', filter: { nodes: ['test.chatModel'] } },
          { type: 'ai_languageModel' },
          { type: 'ai_languageModel', filter: { nodes: [], excludedNodes: [] } },
          { type: 'ai_tool' },
        ],
        [],
      ),
      described('test.other', [{ type: 'ai_tool' }], []),
    ].map((d) => [d.name, d]),
  );
  const portsOf = (name: string) => {
    const description = filtered.get(name);
    return description ? deriveNodePorts(node(name, name), description) : undefined;
  };
  const model = (source: string, slot: number) =>
    canConnect(
      {
        source,
        sourceHandle: 'out:ai_languageModel:0',
        target: 'test.agent',
        targetHandle: `in:ai_languageModel:${slot}`,
      },
      {},
      portsOf,
    );
  const tool = (source: string, target: string) =>
    canConnect({ source, sourceHandle: 'out:ai_tool:0', target, targetHandle: 'in:ai_tool:0' }, {}, portsOf);

  it('refuses a source type in the input filter excludedNodes', () => {
    expect(model('test.chatModel', 0)).toBe(true);
    expect(model('test.completionModel', 0)).toBe(false);
  });

  it('refuses a source type not in the input filter nodes', () => {
    expect(model('test.chatModel', 1)).toBe(true);
    expect(model('test.completionModel', 1)).toBe(false);
  });

  it('refuses a target type not in the output filter nodes', () => {
    expect(tool('test.hitlTool', 'test.agent')).toBe(true);
    expect(tool('test.hitlTool', 'test.other')).toBe(false);
  });

  it('checks only the port being connected, and empty or missing lists restrict nothing', () => {
    expect(model('test.completionModel', 2)).toBe(true);
    expect(model('test.completionModel', 3)).toBe(true);
    expect(tool('test.plainTool', 'test.other')).toBe(true);
  });

  it('refuses a real allow-list when the other side has no known type', () => {
    const untyped = (name: string) => {
      const ports = portsOf(name);
      return ports && { ...ports, nodeType: undefined };
    };
    expect(
      canConnect(
        {
          source: 'test.hitlTool',
          sourceHandle: 'out:ai_tool:0',
          target: 'test.agent',
          targetHandle: 'in:ai_tool:0',
        },
        {},
        untyped,
      ),
    ).toBe(false);
  });

  it('keeps the filter on the port and the type on the node ports, also for an unknown type', () => {
    const agent = portsOf('test.agent')!;
    expect(agent.nodeType).toBe('test.agent');
    expect(agent.inputs[0].filter).toEqual({ excludedNodes: ['test.completionModel'] });
    expect(portsOf('test.hitlTool')!.outputs[0].filter).toEqual({ nodes: ['test.agent'] });
    expect(deriveNodePorts(node('X', 'gone.node'), undefined).nodeType).toBe('gone.node');
  });
});

describe('flow elements', () => {
  it('labels cables with item counts after a run and marks pinned and failed nodes', () => {
    const a = node('A', 'core.manualTrigger');
    const b = node('B', 'core.set');
    const { nodes, edges } = buildFlowElements({
      nodes: [a, b],
      connections: { A: { main: [[{ node: 'B', type: 'main', index: 0 }]] } },
      pinData: { B: [{ json: {} }] },
      nodeGroups: [],
      stickyNotes: [{ id: 's', content: 'hi', position: [0, 0], width: 200, height: 100 }],
      descriptions: { get: (t) => types.get(t) },
      runData: {
        A: [
          {
            startTime: 0,
            executionTime: 1,
            executionStatus: 'success',
            data: { main: [[{ json: {} }, { json: {} }]] },
            source: [],
          },
        ],
      },
      runningNodes: [],
      selectedNodes: ['B'],
      selectedStickies: [],
      readOnly: false,
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].data?.count).toBe(2);
    expect(edges[0].sourceHandle).toBe('out:main:0');
    const flowB = nodes.find((n) => n.id === 'id-B')!;
    expect(flowB.selected).toBe(true);
    expect(flowB.type === 'workflowNode' && flowB.data.pinned).toBe(true);
    const flowA = nodes.find((n) => n.id === 'id-A')!;
    expect(flowA.type === 'workflowNode' && flowA.data.status).toBe('success');
    expect(nodes.some((n) => n.type === 'sticky')).toBe(true);
  });
});
