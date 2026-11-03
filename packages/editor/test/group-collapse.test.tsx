/**
 * P3-04 addendum (L4): collapse / expand, descriptions and the view-only push layout.
 * Collapsed (the default): one 400-wide card takes the members' outside cables. Expanded: a frame
 * around the members pushes overlapping nodes aside on screen only; the save body never moves.
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildFlowElements, type FlowNode } from '../src/components/canvas/flow-elements';
import { demoNodeTypes } from '../src/demo/fixtures';
import {
  COLLAPSED_GROUP_WIDTH,
  DEFAULT_NODE_SIZE,
  GROUP_HEADER,
  GROUP_PADDING,
  GROUP_VIEW_EVENT,
  PUSH_GAP,
} from '../src/lib/group-layout-push';
import {
  isGroupDescriptionPinned,
  isGroupExpanded,
  setGroupDescriptionPinned,
  setGroupsExpanded,
} from '../src/lib/group-view';
import { EMPTY_GRAPH, type WorkflowGraph } from '../src/lib/workflow-ops';
import { toWorkflowBody, useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const node = (id: string, name: string, x: number, y = 0, type = 'core.set'): WorkflowNode => ({
  id,
  name,
  type,
  typeVersion: 1,
  position: [x, y],
  parameters: {},
});
const main = (target: string) => [[{ node: target, type: 'main' as const, index: 0 }]];

/** S -> A -> B -> X; group G = A, B; Y sits where the expanded frame reaches (below the card) */
const GRAPH: WorkflowGraph = {
  ...EMPTY_GRAPH,
  nodes: [
    node('s', 'S', 0, 0, 'core.manualTrigger'),
    node('a', 'A', 300),
    node('b', 'B', 500),
    node('x', 'X', 900),
    node('y', 'Y', 550, 80),
  ],
  connections: { S: { main: main('A') }, A: { main: main('B') }, B: { main: main('X') } },
  nodeGroups: [{ id: 'g', name: 'G', nodeIds: ['a', 'b'], description: 'Cleans the lead fields' }],
};

const descriptions = { get: (type: string) => demoNodeTypes.find((d) => d.name === type) };
const build = (expanded: string[], extra: { pinned?: string[] } = {}) =>
  buildFlowElements({
    ...GRAPH,
    descriptions,
    runData: {},
    runningNodes: [],
    selectedNodes: [],
    selectedStickies: [],
    readOnly: false,
    expandedGroups: new Set(expanded),
    pinnedGroupDescriptions: new Set(extra.pinned ?? []),
  });
const byId = (nodes: FlowNode[], id: string) => nodes.find((n) => n.id === id)!;

describe('group elements', () => {
  it('collapsed: one card takes the outside cables, members stay mounted but hidden', () => {
    const { nodes, edges } = build([]);
    const card = byId(nodes, 'group:g');
    expect(card).toMatchObject({
      type: 'nodeGroup',
      width: COLLAPSED_GROUP_WIDTH,
      data: { collapsed: true },
    });
    expect(card.position).toEqual({ x: 300 - GROUP_PADDING, y: -GROUP_HEADER });
    expect(byId(nodes, 'a').style).toMatchObject({ opacity: 0, pointerEvents: 'none' });
    expect(byId(nodes, 'a').selectable).toBe(false);
    expect(byId(nodes, 'x').style).toBeUndefined();

    const into = edges.find((e) => e.data?.ref.source === 'S')!;
    expect(into).toMatchObject({ source: 's', target: 'group:g', targetHandle: 'group-in' });
    const out = edges.find((e) => e.data?.ref.target === 'X')!;
    expect(out).toMatchObject({ source: 'group:g', sourceHandle: 'group-out', target: 'x' });
    expect(edges.find((e) => e.data?.ref.source === 'A')?.hidden).toBe(true);
    // a collapsed group pushes nothing
    expect(byId(nodes, 'y').position).toEqual({ x: 550, y: 80 });
  });

  it('expanded: the frame wraps the members and pushes the overlapping node on screen only', () => {
    const { nodes, edges } = build(['g']);
    const frame = byId(nodes, 'group:g');
    const width = 500 + DEFAULT_NODE_SIZE.width - 300 + 2 * GROUP_PADDING;
    expect(frame).toMatchObject({ width, data: { collapsed: false } });
    expect(frame.position).toEqual({ x: 300 - GROUP_PADDING, y: -GROUP_HEADER });
    expect(byId(nodes, 'a').style).toBeUndefined();
    const inside = edges.find((e) => e.data?.ref.source === 'A')!;
    expect(inside).toMatchObject({ source: 'a', target: 'b' });
    expect(inside.hidden).toBeUndefined();

    // Y is below the card and overlaps the frame: the lower lane moves down; X (right, clear) stays
    const frameBottom = -GROUP_HEADER + frame.height!;
    expect(byId(nodes, 'y').position).toEqual({ x: 550, y: frameBottom + PUSH_GAP });
    expect(byId(nodes, 'x').position).toEqual({ x: 900, y: 0 });
    expect(GRAPH.nodes.find((n) => n.id === 'y')?.position).toEqual([550, 80]);
  });

  it('a pinned description makes the collapsed card taller', () => {
    const plain = byId(build([]).nodes, 'group:g').height!;
    const pinned = byId(build([], { pinned: ['g'] }).nodes, 'group:g');
    expect(pinned.height!).toBeGreaterThan(plain);
    expect(pinned.data).toMatchObject({ descriptionPinned: true });
  });
});

describe('group view of a new workflow', () => {
  const stored = () =>
    JSON.parse(window.localStorage.getItem('workflow.groupView') ?? '{}') as Record<string, unknown>;
  const newWorkflowWithGroup = () => {
    useWorkflowStore.getState().reset();
    useWorkflowStore.setState({ ...GRAPH });
    setGroupsExpanded(['g'], true);
    setGroupDescriptionPinned('g', true);
  };

  it('keeps the expanded and pinned state on the first save and tells the canvas', () => {
    newWorkflowWithGroup();
    let events = 0;
    const count = () => events++;
    window.addEventListener(GROUP_VIEW_EVENT, count);
    act(() => useWorkflowStore.getState().markSaved({ id: 'wf-first-save', versionId: 'v1' }));
    window.removeEventListener(GROUP_VIEW_EVENT, count);

    expect(isGroupExpanded('g')).toBe(true);
    expect(isGroupDescriptionPinned('g')).toBe(true);
    expect(isGroupExpanded('g', 'wf-first-save')).toBe(true);
    expect(events).toBeGreaterThan(0);
    expect(stored()).toHaveProperty('wf-first-save');
    expect(stored()).not.toHaveProperty('__unsaved__');

    // a later save of the same workflow changes nothing
    act(() => useWorkflowStore.getState().markSaved({ id: 'wf-first-save', versionId: 'v2' }));
    expect(isGroupExpanded('g')).toBe(true);
  });

  it('never carries the unsaved state into the next new workflow or an opened one', () => {
    newWorkflowWithGroup();
    useWorkflowStore.getState().reset();
    useWorkflowStore.setState({ nodeGroups: GRAPH.nodeGroups });
    expect(isGroupExpanded('g')).toBe(false);
    expect(isGroupDescriptionPinned('g')).toBe(false);

    newWorkflowWithGroup();
    useWorkflowStore.getState().load({ ...GRAPH, id: 'wf-opened', name: 'Opened' });
    expect(isGroupExpanded('g')).toBe(false);
    expect(stored()).not.toHaveProperty('__unsaved__');
  });
});

// ---------------------------------------------------------------------------------------------
function seed() {
  signedIn();
  return backend().seedWorkflow({
    name: 'Grouped',
    nodes: GRAPH.nodes,
    connections: GRAPH.connections,
    nodeGroups: [{ id: 'g', name: 'G', nodeIds: ['a', 'b'] }],
  });
}

async function openEditor(id: string) {
  const utils = renderApp(`/workflow/${id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(document.querySelector('[data-id="group:g"]')).toBeTruthy());
  return utils;
}

/** the y of a node on screen (React Flow's translate) */
const screenY = (id: string) => {
  const el = document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  return Number(/translate\([-\d.]+px,\s*([-\d.]+)px/.exec(el.style.transform)?.[1]);
};

beforeEach(() => {
  window.localStorage.clear();
  useWorkflowStore.getState().reset();
});

describe('collapse and expand in the editor', () => {
  it('shows the card, expands into a frame (kept in this browser) and never saves the push', async () => {
    const user = userEvent.setup();
    const wf = seed();
    const first = await openEditor(wf.id);
    const card = document.querySelector('[data-id="group:g"]')!;
    expect(card.textContent).toContain('G');
    expect(card.textContent).toContain('2 nodes');
    expect(screenY('y')).toBe(80);

    await user.click(screen.getByRole('button', { name: 'Expand group G' }));
    expect(isGroupExpanded('g', wf.id)).toBe(true);
    await waitFor(() => expect(screenY('y')).toBeGreaterThan(80));
    expect(useWorkflowStore.getState().dirty).toBe(false);
    expect(toWorkflowBody(useWorkflowStore.getState()).nodes.find((n) => n.id === 'y')?.position).toEqual([
      550, 80,
    ]);
    first.unmount();

    useWorkflowStore.getState().reset();
    await openEditor(wf.id);
    expect(screen.getByRole('button', { name: 'Collapse group G' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Collapse group G' }));
    expect(isGroupExpanded('g', wf.id)).toBe(false);
    await waitFor(() => expect(screenY('y')).toBe(80));
  });

  it('edits the description on the title bar (145 max) and pins it on the card', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    expect(screen.queryByRole('button', { name: 'Show description of G' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Edit description of G' }));
    const box = screen.getByRole('textbox', { name: 'Group description' });
    expect(box.getAttribute('maxlength')).toBe('145');
    await user.type(box, '  Cleans the lead fields  {Enter}');
    expect(useWorkflowStore.getState().nodeGroups[0].description).toBe('Cleans the lead fields');
    expect(screen.queryByText('Cleans the lead fields')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show description of G' }));
    expect(isGroupDescriptionPinned('g', wf.id)).toBe(true);
    // the canvas fits a tiny jsdom pane, far below zoom 0.66: the pinned description stays hidden
    expect(screen.queryByText('Cleans the lead fields')).toBeNull();
    const zoomIn = screen.getByRole('button', { name: /zoom in/i });
    for (let i = 0; i < 14; i++) await user.click(zoomIn);
    expect(await screen.findByText('Cleans the lead fields')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Hide description of G' }));
    expect(screen.queryByText('Cleans the lead fields')).toBeNull();
  });

  it('a read-only canvas can expand but offers no edits', async () => {
    const user = userEvent.setup();
    const wf = seed();
    backend().workflow(wf.id).isArchived = true;
    await openEditor(wf.id);
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Ungroup G' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit description of G' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Expand group G' }));
    expect(isGroupExpanded('g', wf.id)).toBe(true);
    act(() => useWorkflowStore.getState().renameGroup('g', 'Nope'));
    expect(useWorkflowStore.getState().nodeGroups[0].name).toBe('G');
  });
});
