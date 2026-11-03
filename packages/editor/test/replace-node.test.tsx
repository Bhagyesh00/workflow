/**
 * P3-11 Replace (R): lib/replace-node keeps position, accepted connections and group membership,
 * refuses a group-breaking replace; the node panel opens in replace mode (title, trigger filter);
 * the context menu entry; one undo step.
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Connections, NodeTypeDescription, WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { replaceNode } from '../src/lib/replace-node';
import type { WorkflowGraph } from '../src/lib/workflow-ops';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const desc = (name: string, over: Partial<NodeTypeDescription> = {}): NodeTypeDescription =>
  ({
    name,
    displayName: name.split('.')[1],
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: name.split('.')[1] },
    inputs: ['main'],
    outputs: ['main'],
    properties: [],
    ...over,
  }) as NodeTypeDescription;

const TYPES: Record<string, NodeTypeDescription> = {
  'core.set': desc('core.set'),
  'core.if': desc('core.if', { outputs: ['main', 'main'] }),
  'core.start': desc('core.start', { group: ['trigger'], inputs: [] }),
  'core.sink': desc('core.sink', { outputs: [] }),
};
const descriptions = { get: (t: string) => TYPES[t] };

const mk = (id: string, name: string, type: string, x: number): WorkflowNode => ({
  id,
  name,
  type,
  typeVersion: 1,
  position: [x, 10],
  parameters: {},
});
const to = (node: string, index = 0) => ({ node, type: 'main' as const, index });

function graph(over: Partial<WorkflowGraph> = {}): WorkflowGraph {
  const connections: Connections = {
    A: { main: [[to('Mid')]] },
    Mid: { main: [[to('C')], [to('D')]] },
  };
  return {
    nodes: [
      mk('a', 'A', 'core.set', 0),
      mk('m', 'Mid', 'core.if', 200),
      mk('c', 'C', 'core.set', 400),
      mk('d', 'D', 'core.set', 400),
    ],
    connections,
    pinData: { Mid: [{ json: { x: 1 } }] },
    stickyNotes: [],
    nodeGroups: [],
    ...over,
  };
}

function ok(r: ReturnType<typeof replaceNode>) {
  if ('error' in r) throw new Error(r.error);
  return r;
}

describe('replaceNode', () => {
  it('takes the position, the incoming and outgoing cables, and drops the pin', () => {
    const r = ok(replaceNode(graph(), 'Mid', mk('new', 'If', 'core.if', 0), descriptions));
    expect(r.nodeName).toBe('If');
    expect(r.graph.nodes.find((x) => x.name === 'If')?.position).toEqual([200, 10]);
    expect(r.graph.nodes.map((x) => x.name)).toEqual(['A', 'If', 'C', 'D']);
    expect(r.graph.connections.A.main?.[0]).toEqual([to('If')]);
    expect(r.graph.connections.If.main).toEqual([[to('C')], [to('D')]]);
    expect(r.graph.connections.Mid).toBeUndefined();
    expect(r.graph.pinData).toEqual({});
  });

  it('drops the cables its type does not accept', () => {
    const set = ok(replaceNode(graph(), 'Mid', mk('new', 'Set', 'core.set', 0), descriptions));
    expect(set.graph.connections.A.main?.[0]).toEqual([to('Set')]);
    // one main output only: the second branch is dropped
    expect(set.graph.connections.Set.main).toEqual([[to('C')], []]);
    const sink = ok(replaceNode(graph(), 'Mid', mk('n2', 'Sink', 'core.sink', 0), descriptions));
    expect(sink.graph.connections.Sink.main?.flat()).toEqual([]);
    const trigger = ok(replaceNode(graph(), 'A', mk('n3', 'Start', 'core.start', 0), descriptions));
    expect(trigger.graph.connections.Start.main?.[0]).toEqual([to('Mid')]);
  });

  it('removes an incoming cable when the new node has no input', () => {
    const r = ok(replaceNode(graph(), 'Mid', mk('n', 'Start', 'core.start', 0), descriptions));
    expect(r.graph.connections.A.main?.[0]).toEqual([]);
  });

  it('gives a unique name and a fresh id, and does not touch its input', () => {
    const input = graph();
    const r = ok(replaceNode(input, 'Mid', mk('m', 'C', 'core.if', 0), descriptions));
    expect(r.nodeName).toBe('C1');
    expect(r.graph.nodes.find((x) => x.name === 'C1')?.id).not.toBe('m');
    expect(input.nodes.map((n) => n.name)).toEqual(['A', 'Mid', 'C', 'D']);
    expect(replaceNode(input, 'Nope', mk('n', 'X', 'core.set', 0), descriptions)).toHaveProperty('error');
  });

  it('keeps a group member in its group', () => {
    const g = graph({ nodeGroups: [{ id: 'g1', name: 'Group', nodeIds: ['a', 'm'] }] });
    const r = ok(replaceNode(g, 'Mid', mk('new', 'If', 'core.if', 0), descriptions));
    expect(r.graph.nodeGroups[0].nodeIds).toEqual(['a', 'new']);
  });

  it('refuses a replace that breaks the group and changes nothing', () => {
    // a trigger has no input, so the group loses its path from first to last node
    const g = graph({ nodeGroups: [{ id: 'g1', name: 'Group', nodeIds: ['a', 'm'] }] });
    const r = replaceNode(g, 'Mid', mk('new', 'Start', 'core.start', 0), descriptions);
    expect(r).toHaveProperty('error');
    expect(g.nodes.map((n) => n.name)).toEqual(['A', 'Mid', 'C', 'D']);
    expect(g.nodeGroups[0].nodeIds).toEqual(['a', 'm']);
  });
});

async function openEditor(nodes: WorkflowNode[], connections: Connections = {}) {
  signedIn();
  const wf = backend().seedWorkflow({ name: 'R', nodes, connections });
  renderApp(`/workflow/${wf.id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(document.querySelector(`[data-id="${nodes[0].id}"]`)).toBeTruthy());
  await waitFor(() => expect(useWorkflowStore.getState().nodeTypeLookup).toBeDefined());
}

describe('replace mode in the editor', () => {
  beforeEach(() => {
    useUiStore.setState({
      sidePanel: null,
      replaceTarget: null,
      contextMenu: null,
      creatorContext: {},
      ndvNode: null,
    });
    useToastStore.setState({ toasts: [] });
  });

  it('opens "Replace <name>" with non-triggers for a node, picks in place as one undo step', async () => {
    await openEditor([mk('n1', 'Start', 'core.manualTrigger', 0), mk('n2', 'Shape', 'core.set', 300)], {
      Start: { main: [[to('Shape')]] },
    });
    act(() => {
      useUiStore.getState().openCreator();
      useUiStore.getState().setReplaceTarget('Shape');
    });
    expect(await screen.findByText('Replace Shape')).toBeTruthy();
    const panel = () => within(screen.getByRole('complementary', { name: 'Node creator' }));
    expect(panel().queryByText('Manual Trigger')).toBeNull();

    const past = useWorkflowStore.getState().past.length;
    await userEvent.setup().click(await panel().findByText('Code'));
    const s = useWorkflowStore.getState();
    expect(s.nodes.map((n) => n.name)).toEqual(['Start', 'Code']);
    expect(s.nodes[1].position).toEqual([300, 10]);
    expect(s.connections.Start.main?.[0]?.[0]?.node).toBe('Code');
    expect(s.selection.nodes).toEqual(['Code']);
    expect(s.past).toHaveLength(past + 1);
    expect(useUiStore.getState()).toMatchObject({ sidePanel: null, replaceTarget: null, ndvNode: null });
    act(() => s.undo());
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Start', 'Shape']);

    // a trigger is replaced by triggers only
    act(() => {
      useUiStore.getState().openCreator();
      useUiStore.getState().setReplaceTarget('Start');
    });
    expect(await screen.findByText('Replace Start')).toBeTruthy();
    expect(panel().queryByText('Code')).toBeNull();
    expect(panel().getAllByText('Manual Trigger').length).toBeGreaterThan(0);
  });

  it('the context menu Replace entry opens replace mode', async () => {
    await openEditor([mk('n2', 'Shape', 'core.set', 300)]);
    act(() =>
      useUiStore.getState().openContextMenu({ x: 100, y: 100, target: { type: 'node', nodeName: 'Shape' } }),
    );
    const menu = screen.getByRole('menu', { name: 'Canvas actions' });
    await userEvent.setup().click(within(menu).getByRole('menuitem', { name: /^Replace/ }));
    expect(useUiStore.getState()).toMatchObject({ sidePanel: 'creator', replaceTarget: 'Shape' });
    expect(await screen.findByText('Replace Shape')).toBeTruthy();
  });

  it('read-only disables the Replace entry', async () => {
    await openEditor([mk('n2', 'Shape', 'core.set', 300)]);
    act(() => useWorkflowStore.setState({ readOnly: true }));
    act(() =>
      useUiStore.getState().openContextMenu({ x: 100, y: 100, target: { type: 'node', nodeName: 'Shape' } }),
    );
    const menu = screen.getByRole('menu', { name: 'Canvas actions' });
    expect(
      within(menu)
        .getByRole('menuitem', { name: /^Replace/ })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('a node picked in the command bar is added, not swapped in, while the panel is in replace mode', async () => {
    await openEditor([mk('n1', 'Start', 'core.manualTrigger', 0), mk('n2', 'Shape', 'core.set', 300)], {
      Start: { main: [[to('Shape')]] },
    });
    act(() => {
      useWorkflowStore.getState().select({ nodes: ['Shape'], stickies: [], edges: [] });
      useUiStore.getState().openCreator();
      useUiStore.getState().setReplaceTarget('Shape');
    });
    act(() => {
      fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    });
    const bar = await screen.findByRole('dialog', { name: 'Command bar' });
    const user = userEvent.setup();
    await user.type(within(bar).getByRole('combobox', { name: 'Search the command bar' }), 'edit fields');
    await within(bar).findByRole('option', { name: /Edit Fields \(Set\)/ });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(useWorkflowStore.getState().nodes).toHaveLength(3));
    expect(useWorkflowStore.getState().nodes.some((n) => n.name === 'Shape')).toBe(true);
    expect(useUiStore.getState()).toMatchObject({ replaceTarget: null, sidePanel: null });
  });
});
