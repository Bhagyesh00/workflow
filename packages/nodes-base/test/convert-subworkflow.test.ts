/**
 * P3-05 acceptance: converting nodes to a sub-workflow keeps the workflow's result. The parent runs
 * before and after extractSubWorkflow through the real engine; the Call node runs the new workflow
 * through the same engine.
 */
import type { SubWorkflowRequest } from '@workflow/core';
import { WorkflowExecute } from '@workflow/core';
import {
  type Connections,
  type DataObject,
  extractSubWorkflow,
  type Item,
  Workflow,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { connect, node, nodeTypes, runNode, runWorkflow, testServices } from './harness';

const items = (...rows: DataObject[]): Item[] => rows.map((json) => ({ json }));

describe('Execute Workflow inputs (workflowInputs)', () => {
  const calls: SubWorkflowRequest[] = [];
  const executeSubWorkflow = async (request: SubWorkflowRequest) => {
    calls.push(request);
    return { executionId: 'sub', data: [request.items] };
  };

  it('adds the mapped values to each item it sends', async () => {
    calls.length = 0;
    await runNode(
      'core.executeWorkflow',
      {
        workflowId: { __rl: true, mode: 'id', value: 'wf-1' },
        workflowInputs: {
          values: [
            { name: 'doubled', value: '={{ $json.a * 2 }}' },
            { name: 'list', value: '={{ [$json.a] }}' },
            { name: '', value: 'ignored' },
          ],
        },
      },
      items({ a: 1 }, { a: 2 }),
      { services: { executeSubWorkflow } },
    );
    expect(calls[0].items.map((i) => i.json)).toEqual([
      { a: 1, doubled: 2, list: [1] },
      { a: 2, doubled: 4, list: [2] },
    ]);
  });

  it('maps per item in "each" mode and sends the items unchanged without inputs', async () => {
    calls.length = 0;
    await runNode(
      'core.executeWorkflow',
      {
        workflowId: { __rl: true, mode: 'id', value: 'wf-1' },
        mode: 'each',
        workflowInputs: { values: [{ name: 'b', value: '={{ $json.a + 10 }}' }] },
      },
      items({ a: 1 }, { a: 2 }),
      { services: { executeSubWorkflow } },
    );
    expect(calls.map((c) => c.items.map((i) => i.json))).toEqual([[{ a: 1, b: 11 }], [{ a: 2, b: 12 }]]);
    calls.length = 0;
    await runNode(
      'core.executeWorkflow',
      { workflowId: { __rl: true, mode: 'id', value: 'wf-1' } },
      items({ a: 1 }),
      { services: { executeSubWorkflow } },
    );
    expect(calls[0].items).toEqual([{ json: { a: 1 } }]);
  });
});

// Manual -> Set A -> Code -> Set B -> Set C; Set A, Code and Set B become the sub-workflow
function parentWorkflow(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    node('Manual', 'core.manualTrigger', {}, [0, 0]),
    node(
      'Set A',
      'core.set',
      {
        mode: 'manual',
        includeOtherFields: false,
        assignments: {
          assignments: [
            { id: '1', name: 'double', value: '={{ $json.v * 2 }}', type: 'number' },
            { id: '2', name: 'label', value: "={{ $('Manual').item.json.name }}", type: 'string' },
            { id: '3', name: 'firstName', value: "={{ $('Manual').first().json.name }}", type: 'string' },
          ],
        },
      },
      [200, 0],
    ),
    node(
      'Code',
      'core.code',
      {
        mode: 'runOnceForAllItems',
        jsCode:
          "return $input.all().map((i, index) => ({ json: { ...i.json, total: i.json.double + $('Manual').all().length }, pairedItem: { item: index } })).filter((i) => i.json.double > 2);",
      },
      [400, 0],
    ),
    node(
      'Set B',
      'core.set',
      {
        mode: 'manual',
        includeOtherFields: true,
        assignments: {
          assignments: [{ id: '4', name: 'tag', value: '={{ $json.total + 1 }}', type: 'number' }],
        },
      },
      [600, 0],
    ),
    node(
      'Set C',
      'core.set',
      {
        mode: 'manual',
        includeOtherFields: false,
        assignments: {
          assignments: [
            { id: '5', name: 'tag', value: '={{ $json.tag }}' },
            { id: '6', name: 'fromA', value: "={{ $('Set A').item.json.label }}" },
            { id: '7', name: 'fromB', value: "={{ $('Set B').item.json.total }}" },
            { id: '8', name: 'firstOfB', value: "={{ $('Set B').first().json.firstName }}" },
          ],
        },
      },
      [800, 0],
    ),
  ];
  const connections: Connections = connect(
    ['Manual', 'Set A'],
    ['Set A', 'Code'],
    ['Code', 'Set B'],
    ['Set B', 'Set C'],
  );
  return { name: 'Parent', nodes, connections };
}

/** runs a stored workflow as the server does: its trigger gets the items, the last node's output returns */
function subWorkflowRunner(store: Record<string, WorkflowDefinition>) {
  const calls: SubWorkflowRequest[] = [];
  const executeSubWorkflow = async (request: SubWorkflowRequest) => {
    calls.push(request);
    const id = request.source.source === 'database' ? (request.source.workflowId ?? '') : '';
    const definition = store[id];
    if (!definition) throw new Error(`no workflow ${id}`);
    const engine = new WorkflowExecute(
      new Workflow(definition, nodeTypes),
      testServices({}, { executeSubWorkflow }),
    );
    const result = await engine.run({ triggerItems: JSON.parse(JSON.stringify(request.items)) });
    if (result.status !== 'success')
      throw new Error(result.state.resultData.error?.message ?? 'sub-workflow failed');
    return { executionId: `sub-${calls.length}`, data: result.lastNodeOutput ?? null };
  };
  return { calls, executeSubWorkflow };
}

async function beforeAndAfter(trigger: Item[]) {
  const parent = parentWorkflow();
  const before = await runWorkflow(parent.nodes, parent.connections, trigger);
  const ids = parent.nodes.filter((n) => ['Set A', 'Code', 'Set B'].includes(n.name)).map((n) => n.id);
  const extracted = extractSubWorkflow({
    definition: parent,
    nodeIds: ids,
    name: 'Shape',
    newWorkflowId: 'sub-wf',
    types: (type) => nodeTypes.get(type)?.description,
  });
  const runner = subWorkflowRunner({
    'sub-wf': { ...extracted.subWorkflow },
  });
  const after = await runWorkflow(extracted.parent.nodes, extracted.parent.connections, trigger, {
    services: { executeSubWorkflow: runner.executeSubWorkflow },
  });
  return { before, after, extracted, runner };
}

describe('convert to sub-workflow keeps the result (engine)', () => {
  it('many items, outside reads inside and inside reads downstream give the same final items', async () => {
    const trigger = items({ v: 1, name: 'one' }, { v: 2, name: 'two' }, { v: 3, name: 'three' });
    const { before, after, extracted, runner } = await beforeAndAfter(trigger);
    expect(before.status).toBe('success');
    expect(after.status).toBe('success');
    expect(before.json('Set C')).toEqual([
      { tag: 8, fromA: 'two', fromB: 7, firstOfB: 'one' },
      { tag: 10, fromA: 'three', fromB: 9, firstOfB: 'one' },
    ]);
    expect(after.json('Set C')).toEqual(before.json('Set C'));
    // one call with all items; the typed Start inputs travel with them
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].items).toHaveLength(3);
    expect(extracted.subWorkflow.nodes.map((n) => n.name)).toEqual([
      'Start',
      'Set A',
      'Code',
      'Set B',
      'Return',
    ]);
    expect(Object.keys(after.runData)).toEqual(['Manual', 'Call Shape', 'Set C']);
  });

  it('a selection that outputs no items stops the parent the same way', async () => {
    const trigger = items({ v: 1, name: 'one' });
    const { before, after } = await beforeAndAfter(trigger);
    expect(before.status).toBe('success');
    expect(after.status).toBe('success');
    expect(before.runData['Set C']).toBeUndefined();
    expect(after.runData['Set C']).toBeUndefined();
    expect(after.json('Call Shape')).toEqual([]);
  });

  it('passes items through unchanged when nothing reads outside nodes', async () => {
    const def: WorkflowDefinition = {
      name: 'P',
      nodes: [
        node('Manual', 'core.manualTrigger'),
        node('Inner', 'core.set', {
          mode: 'manual',
          includeOtherFields: true,
          assignments: { assignments: [{ id: '1', name: 'x', value: '={{ $json.v + 1 }}', type: 'number' }] },
        }),
        node('After', 'core.set', {
          mode: 'manual',
          includeOtherFields: true,
          assignments: { assignments: [] },
        }),
      ],
      connections: connect(['Manual', 'Inner'], ['Inner', 'After']),
    };
    const trigger = items({ v: 1, keep: 'a' }, { v: 5, keep: 'b' });
    const before = await runWorkflow(def.nodes, def.connections, trigger);
    const r = extractSubWorkflow({ definition: def, nodeIds: ['Inner'], name: 'S', newWorkflowId: 'w' });
    expect(r.subWorkflow.nodes[0].parameters).toEqual({ inputSource: 'passthrough' });
    const runner = subWorkflowRunner({ w: { ...r.subWorkflow } });
    const after = await runWorkflow(r.parent.nodes, r.parent.connections, trigger, {
      services: { executeSubWorkflow: runner.executeSubWorkflow },
    });
    expect(after.json('After')).toEqual(before.json('After'));
    expect(after.json('After')).toEqual([
      { v: 1, keep: 'a', x: 2 },
      { v: 5, keep: 'b', x: 6 },
    ]);
  });
});
