/**
 * P3-03 tidy up (L1): tidyUp(flow, target?) lays out the whole canvas or a selection through
 * lib/auto-layout as one undo step, never touches connections, reads node and card sizes from the
 * canvas, then fits the view (whole canvas) or the selection's new bounds. Shift+Alt+T in the
 * editor, then one undo.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  Connections,
  ConnectionType,
  NodeTypeDescription,
  StickyNote,
  WorkflowNode,
} from '@workflow/workflow';
import type { ReactFlowInstance } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { groupFlowId } from '../src/components/canvas/flow-elements';
import { tidyUp } from '../src/features/editor/tidy-up';
import { layoutWorkflow } from '../src/lib/auto-layout';
import { COLLAPSED_GROUP_HEIGHT, COLLAPSED_GROUP_WIDTH } from '../src/lib/group-layout-push';
import { setGroupsExpanded } from '../src/lib/group-view';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const desc = (name: string, over: Partial<NodeTypeDescription> = {}): NodeTypeDescription =>
  ({
    name,
    displayName: name,
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name },
    inputs: ['main'],
    outputs: ['main'],
    properties: [],
    ...over,
  }) as NodeTypeDescription;

const TYPES: Record<string, NodeTypeDescription> = {
  'core.manualTrigger': desc('core.manualTrigger', { group: ['trigger'], inputs: [] }),
  'core.set': desc('core.set'),
  'ai.agent': desc('ai.agent', {
    inputs: ['main', { type: 'ai_languageModel' }, { type: 'ai_memory' }, { type: 'ai_tool' }],
  }),
  'ai.model': desc('ai.model', { inputs: [], outputs: ['ai_languageModel'] }),
  'ai.memory': desc('ai.memory', { inputs: [], outputs: ['ai_memory'] }),
};

const node = (name: string, x: number, y: number, type = 'core.set'): WorkflowNode => ({
  id: `id-${name}`,
  name,
  type,
  typeVersion: 1,
  position: [x, y],
  parameters: {},
});

const to = (n: string, type: ConnectionType = 'main') => ({ node: n, type, index: 0 });

/** a ReactFlowInstance stand-in: measured sizes by flow id, spied fit calls */
function fakeFlow(measured: Record<string, { width: number; height: number }> = {}) {
  const flow = {
    getNode: vi.fn((id: string) =>
      measured[id] ? { id, position: { x: 0, y: 0 }, data: {}, measured: measured[id] } : undefined,
    ),
    fitView: vi.fn(async () => true),
    fitBounds: vi.fn(async () => true),
  };
  return flow as typeof flow & ReactFlowInstance;
}

function load(nodes: WorkflowNode[], connections: Connections, extra: Record<string, unknown> = {}) {
  const store = useWorkflowStore.getState();
  store.load({ id: 'wf-tidy', name: 'Tidy', nodes, connections, ...extra });
  store.setNodeTypeLookup((type) => TYPES[type]);
}

const positions = () =>
  Object.fromEntries(useWorkflowStore.getState().nodes.map((n) => [n.name, n.position]));

describe('tidyUp', () => {
  const nodes = () => [
    node('Start', 400, 500, 'core.manualTrigger'),
    node('A', 0, 0),
    node('B', 900, 40),
    node('C', 120, 800),
  ];
  const connections: Connections = {
    Start: { main: [[to('A')]] },
    A: { main: [[to('B'), to('C')]] },
  };

  beforeEach(() => {
    window.localStorage.clear();
    useWorkflowStore.getState().reset();
  });

  it('lays out the whole canvas as one undo step, keeps connections and fits the view', async () => {
    load(nodes(), connections);
    const flow = fakeFlow();
    const before = positions();
    const connectionsBefore = structuredClone(useWorkflowStore.getState().connections);

    tidyUp(flow);

    const state = useWorkflowStore.getState();
    const expected = layoutWorkflow({
      nodes: nodes(),
      connections,
      stickyNotes: [],
      nodeGroups: [],
      triggers: ['Start'],
      aiInputs: {},
      collapsedGroups: {},
    });
    expect(positions()).toEqual({ ...before, ...expected.positions });
    expect(positions()).not.toEqual(before);
    expect(state.connections).toEqual(connectionsBefore);
    expect(state.past).toHaveLength(1);
    await waitFor(() => expect(flow.fitView).toHaveBeenCalledTimes(1));
    expect(flow.fitBounds).not.toHaveBeenCalled();

    act(() => useWorkflowStore.getState().undo());
    expect(positions()).toEqual(before);
  });

  it('a selection moves only its nodes and fits the selection’s new bounds', async () => {
    load(nodes(), connections);
    const flow = fakeFlow();
    tidyUp(flow, { nodes: ['A', 'B', 'C'] });

    const after = positions();
    expect(after.Start).toEqual([400, 500]);
    expect(after).not.toEqual(Object.fromEntries(nodes().map((n) => [n.name, n.position])));
    await waitFor(() => expect(flow.fitBounds).toHaveBeenCalledTimes(1));
    expect(flow.fitView).not.toHaveBeenCalled();
    const [rect] = flow.fitBounds.mock.calls[0] as unknown as [
      { x: number; y: number; width: number; height: number },
    ];
    const xs = ['A', 'B', 'C'].map((n) => after[n]![0]);
    const ys = ['A', 'B', 'C'].map((n) => after[n]![1]);
    expect(rect.x).toBe(Math.min(...xs));
    expect(rect.y).toBe(Math.min(...ys));
    expect(rect.x + rect.width).toBe(Math.max(...xs) + 220);
    expect(rect.y + rect.height).toBe(Math.max(...ys) + 64);
  });

  it('a selection of one node tidies the whole canvas', () => {
    load(nodes(), connections);
    tidyUp(fakeFlow(), { nodes: ['A'] });
    expect(positions().Start).not.toEqual([400, 500]);
  });

  it('uses the measured node sizes from the canvas', () => {
    const big = { width: 300, height: 400 };
    load(nodes(), connections);
    tidyUp(fakeFlow({ 'id-B': big }));
    const after = positions();
    const expected = layoutWorkflow({
      nodes: nodes(),
      connections,
      triggers: ['Start'],
      sizes: { B: big },
    }).positions;
    expect(after).toEqual(expected);
    // B (tall) and C share a layer without overlap
    expect(Math.abs(after.B![1] - after.C![1])).toBeGreaterThanOrEqual(64);
  });

  it('runs a second time without a new undo step', () => {
    load(nodes(), connections);
    tidyUp(fakeFlow());
    tidyUp(fakeFlow());
    expect(useWorkflowStore.getState().past).toHaveLength(1);
  });

  it('does nothing when the workflow is read-only', () => {
    useWorkflowStore
      .getState()
      .load({ id: 'wf-ro', name: 'RO', nodes: nodes(), connections }, { readOnly: true });
    const flow = fakeFlow();
    tidyUp(flow);
    expect(positions().Start).toEqual([400, 500]);
    expect(useWorkflowStore.getState().past).toHaveLength(0);
  });

  it('a covering sticky moves with its node; AI sub-nodes hang under the agent', () => {
    const graph = [
      node('Start', 0, 0, 'core.manualTrigger'),
      node('Agent', 700, 300, 'ai.agent'),
      node('Memory', 100, 700, 'ai.memory'),
      node('Model', 900, 900, 'ai.model'),
    ];
    const sticky: StickyNote = { id: 'note', content: 'x', position: [680, 280], width: 260, height: 104 };
    const lonely: StickyNote = {
      id: 'lonely',
      content: 'y',
      position: [-900, -900],
      width: 200,
      height: 100,
    };
    load(
      graph,
      {
        Start: { main: [[to('Agent')]] },
        Model: { ai_languageModel: [[to('Agent', 'ai_languageModel')]] },
        Memory: { ai_memory: [[to('Agent', 'ai_memory')]] },
      },
      { stickyNotes: [sticky, lonely] },
    );
    tidyUp(fakeFlow());
    const after = positions();
    // model before memory: the agent's input order
    expect(after.Model![1]).toBe(after.Memory![1]);
    expect(after.Model![0]).toBeLessThan(after.Memory![0]);
    expect(after.Model![1]).toBeGreaterThan(after.Agent![1]);
    const stickies = useWorkflowStore.getState().stickyNotes;
    expect(stickies.find((s) => s.id === 'note')!.position).toEqual([
      after.Agent![0] - 20,
      after.Agent![1] - 20,
    ]);
    expect(stickies.find((s) => s.id === 'lonely')!.position).toEqual([-900, -900]);
  });

  it('a collapsed group is one card; an expanded one is laid out by its members', () => {
    const graph = [
      node('Start', 0, 0, 'core.manualTrigger'),
      node('A', 500, 600),
      node('B', 200, 900),
      node('End', 1500, 0),
    ];
    const chain: Connections = {
      Start: { main: [[to('A')]] },
      A: { main: [[to('B')]] },
      B: { main: [[to('End')]] },
    };
    const nodeGroups = [{ id: 'g1', name: 'G', nodeIds: ['id-A', 'id-B'] }];
    load(graph, chain, { nodeGroups });

    // collapsed (the default view): the card's measured size is the box
    const card = { width: COLLAPSED_GROUP_WIDTH, height: COLLAPSED_GROUP_HEIGHT };
    tidyUp(fakeFlow({ [groupFlowId('g1')]: card }));
    const collapsed = layoutWorkflow({
      nodes: graph,
      connections: chain,
      nodeGroups,
      triggers: ['Start'],
      collapsedGroups: { g1: card },
    }).positions;
    expect(positions()).toEqual(collapsed);

    useWorkflowStore
      .getState()
      .load({ id: 'wf-tidy', name: 'Tidy', nodes: graph, connections: chain, nodeGroups });
    setGroupsExpanded(['g1'], true);
    tidyUp(fakeFlow());
    const expanded = layoutWorkflow({
      nodes: graph,
      connections: chain,
      nodeGroups,
      triggers: ['Start'],
    }).positions;
    expect(positions()).toEqual(expanded);
    expect(positions().A![1]).toBe(positions().B![1]);
  });
});

describe('Shift+Alt+T in the editor', () => {
  it('tidies the canvas and one undo puts every node back', async () => {
    signedIn();
    const wf = backend().seedWorkflow({
      name: 'Messy',
      nodes: [node('Start', 600, 400, 'core.manualTrigger'), node('Shape', 0, 0), node('Other', 300, 900)],
      connections: { Start: { main: [[to('Shape')]] }, Shape: { main: [[to('Other')]] } },
    });
    renderApp(`/workflow/${wf.id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
    await waitFor(() => expect(document.querySelector('[data-id="id-Shape"]')).toBeTruthy());
    await waitFor(() => expect(useWorkflowStore.getState().nodeTypeLookup).toBeDefined());
    const before = positions();
    const history = useWorkflowStore.getState().past.length;

    act(() => void fireEvent.keyDown(window, { key: 'T', code: 'KeyT', altKey: true, shiftKey: true }));

    const after = positions();
    expect(after).not.toEqual(before);
    expect(after.Start![1]).toBe(after.Shape![1]);
    expect(after.Shape![1]).toBe(after.Other![1]);
    expect(after.Start![0]).toBeLessThan(after.Shape![0]);
    expect(after.Shape![0]).toBeLessThan(after.Other![0]);
    expect(useWorkflowStore.getState().past).toHaveLength(history + 1);

    act(() => void fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true }));
    expect(positions()).toEqual(before);
  });
});
