import { describe, expect, it } from 'vitest';
import {
  type Connections,
  extractSubWorkflow,
  type NodeTypeDescription,
  SubWorkflowExtractionError,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../src';

const desc = (name: string, extra: Partial<NodeTypeDescription> = {}): NodeTypeDescription => ({
  description: name,
  name,
  displayName: name,
  group: ['transform'],
  version: 1,
  defaults: { name },
  inputs: ['main'],
  outputs: ['main'],
  properties: [],
  ...extra,
});

const TYPES: Record<string, NodeTypeDescription> = {
  'core.manualTrigger': desc('core.manualTrigger', { group: ['trigger'], inputs: [] }),
  'core.set': desc('core.set'),
  'core.code': desc('core.code'),
  'core.if': desc('core.if', { outputs: ['main', 'main'] }),
  'core.old': desc('core.old', { hidden: true }),
  'core.executeWorkflow': desc('core.executeWorkflow'),
  'ai.agent': desc('ai.agent', { inputs: ['main', 'ai_languageModel'] }),
  'ai.model': desc('ai.model', { inputs: [], outputs: ['ai_languageModel'] }),
};
const types = (type: string) => TYPES[type];

const n = (
  name: string,
  type = 'core.set',
  x = 0,
  parameters: WorkflowNode['parameters'] = {},
): WorkflowNode => ({
  id: `id-${name}`,
  name,
  type,
  typeVersion: 1,
  position: [x, 100],
  parameters,
});

function chain(...pairs: Array<[string, string, number?, number?]>): Connections {
  const c: Connections = {};
  for (const [from, to, out = 0, input = 0] of pairs) {
    const outputs = ((c[from] ??= {}).main ??= []);
    while (outputs.length <= out) outputs.push([]);
    outputs[out]!.push({ node: to, type: 'main', index: input });
  }
  return c;
}

/** Trigger -> A -> B -> C -> D */
function linear(params: Record<string, WorkflowNode['parameters']> = {}): WorkflowDefinition {
  return {
    name: 'Parent',
    nodes: [
      n('Trigger', 'core.manualTrigger', 0),
      n('A', 'core.set', 200, params.A),
      n('B', 'core.set', 400, params.B),
      n('C', 'core.set', 600, params.C),
      n('D', 'core.set', 800, params.D),
    ],
    connections: chain(['Trigger', 'A'], ['A', 'B'], ['B', 'C'], ['C', 'D']),
  };
}

const ids = (...names: string[]) => names.map((name) => `id-${name}`);

function problemCodes(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SubWorkflowExtractionError);
    return (error as SubWorkflowExtractionError).problems.map((p) => p.code);
  }
  throw new Error('expected the extraction to throw');
}

describe('extractSubWorkflow rules (n8n reasons)', () => {
  it('refuses a trigger, an empty selection and a disconnected one', () => {
    const def = linear();
    expect(
      problemCodes(() =>
        extractSubWorkflow({ definition: def, nodeIds: ids('Trigger', 'A'), name: 'S', types }),
      ),
    ).toContain('trigger');
    expect(
      problemCodes(() => extractSubWorkflow({ definition: def, nodeIds: [], name: 'S', types })),
    ).toEqual(['generic']);
    expect(
      problemCodes(() => extractSubWorkflow({ definition: def, nodeIds: ids('A', 'C'), name: 'S', types })),
    ).toContain('disconnected');
  });

  it('refuses more than one input or output branch and a deprecated node', () => {
    // IF with both outputs leaving the selection
    const branches: WorkflowDefinition = {
      name: 'P',
      nodes: [n('Trigger', 'core.manualTrigger'), n('If', 'core.if'), n('Yes'), n('No')],
      connections: chain(['Trigger', 'If'], ['If', 'Yes', 0], ['If', 'No', 1]),
    };
    expect(
      problemCodes(() => extractSubWorkflow({ definition: branches, nodeIds: ids('If'), name: 'S', types })),
    ).toContain('multiple_output_branches');
    // a merge-like node fed on two inputs from outside
    const inputs: WorkflowDefinition = {
      name: 'P',
      nodes: [n('Trigger', 'core.manualTrigger'), n('L'), n('R'), n('Merge')],
      connections: chain(['Trigger', 'L'], ['Trigger', 'R'], ['L', 'Merge', 0, 0], ['R', 'Merge', 0, 1]),
    };
    expect(
      problemCodes(() => extractSubWorkflow({ definition: inputs, nodeIds: ids('Merge'), name: 'S', types })),
    ).toContain('multiple_input_branches');
    const old: WorkflowDefinition = {
      ...linear(),
      nodes: linear().nodes.map((node) => (node.name === 'B' ? { ...node, type: 'core.old' } : node)),
    };
    const codes = problemCodes(() =>
      extractSubWorkflow({ definition: old, nodeIds: ids('A', 'B'), name: 'S', types }),
    );
    expect(codes).toEqual(['deprecated']);
    try {
      extractSubWorkflow({ definition: old, nodeIds: ids('A', 'B'), name: 'S', types });
    } catch (error) {
      expect((error as Error).message).toMatch(/deprecated node cannot be moved to a sub-workflow/);
    }
  });
});

describe('extractSubWorkflow rewiring', () => {
  it('builds Start -> nodes in the new workflow and one Call node in the parent', () => {
    const r = extractSubWorkflow({
      definition: linear(),
      nodeIds: ids('B', 'C'),
      name: 'Shape',
      newWorkflowId: 'wf-9',
    });
    expect(r.executeNodeName).toBe('Call Shape');
    expect(r.subWorkflow.name).toBe('Shape');
    expect(r.subWorkflow.settings).toEqual({ executionOrder: 'v1' });
    expect(r.subWorkflow.nodes.map((x) => x.name)).toEqual(['Start', 'B', 'C']);
    const start = r.subWorkflow.nodes[0];
    expect(start.type).toBe('core.executeWorkflowTrigger');
    expect(start.parameters).toEqual({ inputSource: 'passthrough' });
    expect(start.position).toEqual([180, 100]);
    expect(r.subWorkflow.connections).toEqual(chain(['Start', 'B'], ['B', 'C']));

    expect(r.parent.nodes.map((x) => x.name)).toEqual(['Trigger', 'A', 'D', 'Call Shape']);
    const call = r.parent.nodes.find((x) => x.name === 'Call Shape')!;
    expect(call.type).toBe('core.executeWorkflow');
    expect(call.position).toEqual([500, 100]);
    expect(call.parameters).toEqual({
      source: 'database',
      workflowId: { __rl: true, mode: 'list', value: 'wf-9', cachedResultName: 'Shape' },
      mode: 'once',
      options: {},
    });
    expect(r.parent.connections).toEqual(chain(['Trigger', 'A'], ['A', 'Call Shape'], ['Call Shape', 'D']));
  });

  it('keeps output and input indexes of the outside links and rewires several sources once', () => {
    const def: WorkflowDefinition = {
      name: 'P',
      nodes: [n('Trigger', 'core.manualTrigger'), n('If', 'core.if'), n('X'), n('Y'), n('Z'), n('Out')],
      connections: chain(
        ['Trigger', 'If'],
        ['If', 'X', 0],
        ['If', 'X', 1],
        ['X', 'Y'],
        ['Y', 'Out'],
        ['Y', 'Z'],
      ),
    };
    const r = extractSubWorkflow({ definition: def, nodeIds: ids('X'), name: 'S' });
    expect(r.parent.connections.If).toEqual({
      main: [[{ node: 'Call S', type: 'main', index: 0 }], [{ node: 'Call S', type: 'main', index: 0 }]],
    });
    expect(r.parent.connections['Call S']).toEqual({ main: [[{ node: 'Y', type: 'main', index: 0 }]] });
    expect(r.parent.connections.Y).toEqual(def.connections.Y);
    expect(r.subWorkflow.connections).toEqual(chain(['Start', 'X']));
  });

  it('moves AI sub-nodes with their parent', () => {
    const def: WorkflowDefinition = {
      name: 'P',
      nodes: [
        n('Trigger', 'core.manualTrigger'),
        n('Agent', 'ai.agent', 200),
        n('Model', 'ai.model', 200),
        n('After'),
      ],
      connections: {
        ...chain(['Trigger', 'Agent'], ['Agent', 'After']),
        Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
      },
    };
    const r = extractSubWorkflow({ definition: def, nodeIds: ids('Agent'), name: 'S', types });
    expect(r.subWorkflow.nodes.map((x) => x.name)).toEqual(['Start', 'Agent', 'Model']);
    expect(r.subWorkflow.connections.Model).toEqual(def.connections.Model);
    expect(r.parent.nodes.map((x) => x.name)).toEqual(['Trigger', 'After', 'Call S']);
  });

  it('drops pinned data of the moved nodes from the parent', () => {
    const def = { ...linear(), pinData: { A: [{ json: { a: 1 } }], B: [{ json: { b: 1 } }] } };
    const r = extractSubWorkflow({ definition: def, nodeIds: ids('B'), name: 'S' });
    expect(r.parent.pinData).toEqual({ A: [{ json: { a: 1 } }] });
    expect(r.subWorkflow.pinData).toBeUndefined();
  });
});

describe('extractSubWorkflow names', () => {
  it('makes Start, Return and the Call node names unique', () => {
    const def = linear({ D: { v: "={{ $('Start').item.json.x }}" } });
    def.nodes = def.nodes.map((node) => (node.name === 'B' ? { ...node, name: 'Start' } : node));
    def.nodes.push(n('Call S', 'core.set', 1000));
    def.connections = chain(['Trigger', 'A'], ['A', 'Start'], ['Start', 'C'], ['C', 'D'], ['D', 'Call S']);
    const r = extractSubWorkflow({ definition: def, nodeIds: ids('B', 'C'), name: 'S' });
    expect(r.subWorkflow.nodes.map((x) => x.name)).toEqual(['Start_1', 'Start', 'C', 'Return']);
    expect(r.executeNodeName).toBe('Call S_1');
  });
});

describe('extractSubWorkflow expressions', () => {
  it('maps reads of outside nodes to typed Start inputs and the Call node inputs', () => {
    const def = linear({
      B: {
        mode: 'manual',
        a: "={{ $('A').item.json.price.net }}",
        b: '={{ $("A").first().json.total }} and {{ $(\'A\').all().length }}',
        c: '={{ $node["Trigger"].json.id }}',
        d: "={{ $('A').item.json.price.net.toFixed(2) }}",
        e: '={{ $json.price }}',
        list: ["={{ $items('A')[0].json.x }}"],
      },
      C: { inner: "={{ $('B').item.json.a }}", plain: "$('A').item.json.notAnExpression" },
    });
    const r = extractSubWorkflow({ definition: def, nodeIds: ids('B', 'C'), name: 'S' });
    const start = r.subWorkflow.nodes[0];
    expect(start.parameters).toEqual({
      inputSource: 'workflowInputs',
      workflowInputs: {
        values: [
          { name: 'price_net', type: 'any' },
          { name: 'total_firstItem', type: 'any' },
          { name: 'A_allItems', type: 'any' },
          { name: 'id', type: 'any' },
          { name: 'price', type: 'any' },
        ],
      },
    });
    const call = r.parent.nodes.find((x) => x.name === 'Call S')!;
    expect(call.parameters.workflowInputs).toEqual({
      values: [
        { name: 'price_net', value: "={{ $('A').item.json.price.net }}" },
        { name: 'total_firstItem', value: '={{ $("A").first().json.total }}' },
        { name: 'A_allItems', value: "={{ $('A').all() }}" },
        { name: 'id', value: '={{ $node["Trigger"].json.id }}' },
        { name: 'price', value: '={{ $json.price }}' },
      ],
    });
    const b = r.subWorkflow.nodes.find((x) => x.name === 'B')!;
    expect(b.parameters).toEqual({
      mode: 'manual',
      a: "={{ $('Start').item.json.price_net }}",
      b: "={{ $('Start').first().json.total_firstItem }} and {{ $('Start').first().json.A_allItems.length }}",
      c: "={{ $('Start').item.json.id }}",
      d: "={{ $('Start').item.json.price_net.toFixed(2) }}",
      e: '={{ $json.price }}',
      list: ["={{ $('Start').first().json.A_allItems[0].json.x }}"],
    });
    const c = r.subWorkflow.nodes.find((x) => x.name === 'C')!;
    expect(c.parameters).toEqual(def.nodes.find((x) => x.name === 'C')!.parameters);
  });

  it('renames colliding inputs and rewrites $json of the first node only with typed inputs', () => {
    const typed = linear({
      B: { x: '={{ $json.v }}', y: "={{ $('A').item.json.v }}", z: '={{ $json }}' },
      C: { w: '={{ $json.v }}' },
    });
    const r = extractSubWorkflow({ definition: typed, nodeIds: ids('B', 'C'), name: 'S' });
    const values = (
      r.parent.nodes.find((x) => x.name === 'Call S')!.parameters.workflowInputs as {
        values: unknown[];
      }
    ).values;
    expect(values).toEqual([
      { name: 'v', value: "={{ $('A').item.json.v }}" },
      { name: 'input_v', value: '={{ $json.v }}' },
      { name: 'input', value: '={{ $json }}' },
    ]);
    const b = r.subWorkflow.nodes.find((x) => x.name === 'B')!;
    expect(b.parameters).toEqual({
      x: '={{ $json.input_v }}',
      y: "={{ $('Start').item.json.v }}",
      z: '={{ $json.input }}',
    });
    expect(r.subWorkflow.nodes.find((x) => x.name === 'C')!.parameters).toEqual({ w: '={{ $json.v }}' });

    // no outside reads: passthrough, $json stays as written
    const plain = linear({ B: { x: '={{ $json.v }}' } });
    const p = extractSubWorkflow({ definition: plain, nodeIds: ids('B'), name: 'S' });
    expect(p.subWorkflow.nodes[0].parameters).toEqual({ inputSource: 'passthrough' });
    expect(p.subWorkflow.nodes[1].parameters).toEqual({ x: '={{ $json.v }}' });
  });

  it('rewrites outside reads in Code', () => {
    const def = linear({
      B: { mode: 'runOnceForAllItems', jsCode: "return [{ json: { n: $('A').first().json.n } }];" },
    });
    def.nodes = def.nodes.map((node) => (node.name === 'B' ? { ...node, type: 'core.code' } : node));
    const r = extractSubWorkflow({ definition: def, nodeIds: ids('B'), name: 'S' });
    expect(r.subWorkflow.nodes[1].parameters.jsCode).toBe(
      "return [{ json: { n: $('Start').first().json.n_firstItem } }];",
    );
  });

  it('adds a Return node for downstream reads of inner nodes and reads the last node through the Call node', () => {
    const def = linear({
      D: {
        fromB: "={{ $('B').item.json.amount }}",
        fromBParams: "={{ $('B').params.mode }}",
        fromC: "={{ $('C').item.json.total }} {{ $('C').first().json.n }} {{ $node[\"C\"].json.k }}",
      },
    });
    const r = extractSubWorkflow({ definition: def, nodeIds: ids('B', 'C'), name: 'S' });
    expect(r.subWorkflow.nodes.map((x) => x.name)).toEqual(['Start', 'B', 'C', 'Return']);
    const ret = r.subWorkflow.nodes[3];
    expect(ret.type).toBe('core.set');
    expect(ret.position).toEqual([820, 100]);
    expect(ret.parameters).toEqual({
      mode: 'manual',
      assignments: {
        assignments: [
          { id: expect.any(String), name: 'B_amount', value: "={{ $('B').item.json.amount }}" },
          { id: expect.any(String), name: 'B_params', value: "={{ $('B').params }}" },
        ],
      },
      includeOtherFields: true,
      options: {},
    });
    expect(r.subWorkflow.connections.C).toEqual({ main: [[{ node: 'Return', type: 'main', index: 0 }]] });
    const d = r.parent.nodes.find((x) => x.name === 'D')!;
    expect(d.parameters).toEqual({
      fromB: "={{ $('Call S').item.json.B_amount }}",
      fromBParams: "={{ $('Call S').first().json.B_params.mode }}",
      fromC:
        "={{ $('Call S').item.json.total }} {{ $('Call S').first().json.n }} {{ $node[\"Call S\"].json.k }}",
    });
  });
});

describe('extractSubWorkflow groups', () => {
  it('drops a group moved whole and puts the Call node into a group that keeps members', () => {
    const whole = { ...linear(), nodeGroups: [{ id: 'g', name: 'Group', nodeIds: ids('B', 'C') }] };
    expect(
      extractSubWorkflow({ definition: whole, nodeIds: ids('B', 'C'), name: 'S', types }).parent.nodeGroups,
    ).toEqual([]);
    const part = { ...linear(), nodeGroups: [{ id: 'g', name: 'Group', nodeIds: ids('A', 'B', 'C') }] };
    const r = extractSubWorkflow({ definition: part, nodeIds: ids('B', 'C'), name: 'S', types });
    const callId = r.parent.nodes.find((x) => x.name === 'Call S')!.id;
    expect(r.parent.nodeGroups).toEqual([{ id: 'g', name: 'Group', nodeIds: ['id-A', callId] }]);
  });

  it('does not group the Call node when the moved nodes span groups, and dissolves a group left invalid', () => {
    const spans = {
      ...linear(),
      nodeGroups: [
        { id: 'g1', name: 'One', nodeIds: ids('A', 'B') },
        { id: 'g2', name: 'Two', nodeIds: ids('C', 'D') },
      ],
    };
    const r = extractSubWorkflow({ definition: spans, nodeIds: ids('B', 'C'), name: 'S', types });
    expect(r.parent.nodeGroups).toEqual([
      { id: 'g1', name: 'One', nodeIds: ids('A') },
      { id: 'g2', name: 'Two', nodeIds: ids('D') },
    ]);
    // a group whose members end up in two pieces after the swap is dissolved
    const def = linear();
    def.nodes.push(n('Loose', 'core.set', 400));
    const broken = { ...def, nodeGroups: [{ id: 'g', name: 'Group', nodeIds: ids('B', 'Loose') }] };
    const out = extractSubWorkflow({ definition: broken, nodeIds: ids('B'), name: 'S', types });
    expect(out.parent.nodeGroups).toEqual([]);
    // without a groups field nothing is added
    expect(
      extractSubWorkflow({ definition: linear(), nodeIds: ids('B'), name: 'S' }).parent.nodeGroups,
    ).toBeUndefined();
  });
});
