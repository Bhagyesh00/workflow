/** P3-02: the context menu model (entries, order, labels, enable rules) for every target. */
import type { NodeTypeDescription, RunData, WorkflowNode, WorkflowNodeGroup } from '@workflow/workflow';
import { describe, expect, it, vi } from 'vitest';
import {
  buildMenu,
  type MenuActions,
  type MenuEntry,
  type MenuInputs,
  type MenuModel,
} from '../src/features/editor/node-menu';
import type { WorkflowGraph } from '../src/lib/workflow-ops';

const isTrigger = (name: string) => name.includes('Trigger') || name === 'core.webhook';

const desc = (name: string, extra: Partial<NodeTypeDescription> = {}): NodeTypeDescription =>
  ({
    name,
    displayName: name,
    description: '',
    group: [isTrigger(name) ? 'trigger' : 'transform'],
    version: 1,
    defaults: { name },
    inputs: isTrigger(name) ? [] : ['main'],
    outputs: ['main'],
    properties: [],
    ...extra,
  }) as NodeTypeDescription;

const TYPES: Record<string, NodeTypeDescription> = {
  'core.webhook': desc('core.webhook', {
    webhooks: [{ name: 'default', httpMethod: 'GET', path: 'p' }],
  }),
  'core.wait': desc('core.wait', {
    webhooks: [{ name: 'default', httpMethod: 'POST', path: '', restartWebhook: true }],
  }),
  'core.set': desc('core.set'),
  'core.executeWorkflow': desc('core.executeWorkflow'),
};

const node = (id: string, type: string, x = 0, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  name: id.toUpperCase(),
  type,
  typeVersion: 1,
  position: [x, 0],
  parameters: {},
  ...extra,
});

const link = (to: string) => ({ main: [[{ node: to, type: 'main' as const, index: 0 }]] });

function graph(extra: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    nodes: [
      node('w', 'core.webhook'),
      node('a', 'core.set', 200),
      node('b', 'core.set', 400),
      node('c', 'core.set', 600),
      node('x', 'core.executeWorkflow', 800),
    ],
    connections: { W: link('A'), A: link('B'), B: link('C') },
    pinData: {},
    stickyNotes: [{ id: 's1', content: 'hi', position: [0, 100], width: 200, height: 100 }],
    nodeGroups: [],
    ...extra,
  };
}

const RUN: RunData = {
  A: [{ startTime: 0, executionTime: 1, data: { main: [[{ json: { a: 1 } }]] } }],
} as unknown as RunData;

const sel = (...nodes: string[]) => ({ nodes, stickies: [], edges: [] });

function inputs(over: Partial<MenuInputs> = {}): MenuInputs {
  return {
    target: { type: 'node', nodeName: 'A' },
    graph: graph(),
    selection: sel('A'),
    readOnly: false,
    published: false,
    descriptions: { get: (t) => TYPES[t] },
    runData: RUN,
    ...over,
  };
}

/** every action is a spy, created on first use */
function actions(): MenuActions {
  const cache: Record<string, unknown> = {};
  return new Proxy({} as MenuActions, {
    get: (_t, key: string) => {
      cache[key] ??= vi.fn();
      return cache[key];
    },
  });
}

const entries = (model: MenuModel): MenuEntry[] => model.filter((e): e is MenuEntry => e !== 'separator');
const labels = (model: MenuModel) => entries(model).map((e) => e.label);
const find = (model: MenuModel, label: string) => entries(model).find((e) => e.label === label);

describe('node menu (single node)', () => {
  it('lists the entries in n8n order with their shortcuts', () => {
    const model = buildMenu(inputs(), actions());
    expect(labels(model)).toEqual([
      'Open',
      'Test step',
      'Rename',
      'Replace',
      'Deactivate',
      'Pin',
      'Copy',
      'Duplicate',
      'Tidy up',
      'Select all',
      'Deselect all',
      'Delete',
    ]);
    expect(find(model, 'Open')?.shortcut).toBe('Enter');
    expect(find(model, 'Rename')?.shortcut).toBe('F2');
    expect(find(model, 'Replace')?.shortcut).toBe('R');
    expect(find(model, 'Deactivate')?.shortcut).toBe('D');
    expect(find(model, 'Pin')?.shortcut).toBe('P');
    expect(find(model, 'Copy')?.shortcut).toBe('Ctrl+C');
    expect(find(model, 'Duplicate')?.shortcut).toBe('Ctrl+D');
    expect(find(model, 'Tidy up')?.shortcut).toBe('Shift+Alt+T');
    expect(find(model, 'Delete')?.shortcut).toBe('Del');
    expect(find(model, 'Delete')?.danger).toBe(true);
  });

  it('shows Activate for a deactivated node and Unpin for a pinned one', () => {
    const g = graph();
    g.nodes[1] = { ...g.nodes[1], disabled: true };
    g.pinData = { A: [{ json: { a: 1 } }] };
    const model = buildMenu(inputs({ graph: g }), actions());
    expect(labels(model)).toContain('Activate');
    expect(labels(model)).toContain('Unpin');
    expect(find(model, 'Unpin')?.disabled).toBeFalsy();
  });

  it('disables Pin when the node cannot be pinned (no run data)', () => {
    const model = buildMenu(inputs({ runData: {} }), actions());
    expect(find(model, 'Pin')?.disabled).toBe(true);
  });

  it('shows the URL entries by type and publish state', () => {
    const hook = { target: { type: 'node', nodeName: 'W' } as const, selection: sel('W') };
    const draft = buildMenu(inputs(hook), actions());
    expect(labels(draft)).toContain('Copy test URL');
    expect(labels(draft)).not.toContain('Copy production URL');
    expect(find(draft, 'Copy test URL')?.shortcut).toBe('Shift+Alt+U');

    const live = buildMenu(inputs({ ...hook, published: true }), actions());
    expect(find(live, 'Copy production URL')?.shortcut).toBe('Alt+U');
    const l = labels(live);
    expect(l.indexOf('Copy test URL')).toBe(l.indexOf('Test step') + 1);
    expect(l.indexOf('Copy production URL')).toBe(l.indexOf('Copy test URL') + 1);

    // a production-only webhook (resume URL) has no test URL
    const wait = buildMenu(
      inputs({
        target: { type: 'node', nodeName: 'Z' },
        graph: graph({ nodes: [...graph().nodes, node('z', 'core.wait', 900)] }),
        selection: sel('Z'),
        published: true,
      }),
      actions(),
    );
    expect(labels(wait)).not.toContain('Copy test URL');
    expect(labels(wait)).toContain('Copy production URL');

    // no URL entries for a node without a webhook
    expect(labels(buildMenu(inputs({ published: true }), actions())).join()).not.toContain('URL');
  });

  it('adds Open sub-workflow on a node that calls one', () => {
    const model = buildMenu(
      inputs({ target: { type: 'node', nodeName: 'X' }, selection: sel('X'), subWorkflowNodes: ['X'] }),
      actions(),
    );
    expect(find(model, 'Open sub-workflow')?.shortcut).toBe('Ctrl+Shift+O');
    expect(labels(buildMenu(inputs(), actions()))).not.toContain('Open sub-workflow');
  });

  it('read-only disables every write entry but not Copy, Open or Select all', () => {
    const model = buildMenu(inputs({ readOnly: true }), actions());
    for (const label of ['Rename', 'Replace', 'Deactivate', 'Pin', 'Duplicate', 'Tidy up', 'Delete'])
      expect(find(model, label)?.disabled, label).toBe(true);
    for (const label of ['Open', 'Copy', 'Select all', 'Deselect all', 'Test step'])
      expect(find(model, label)?.disabled, label).toBeFalsy();
  });

  it('offers Ungroup and Rename group for a group member', () => {
    const group: WorkflowNodeGroup = { id: 'g1', name: 'Group', nodeIds: ['a', 'b'] };
    const model = buildMenu(inputs({ graph: graph({ nodeGroups: [group] }) }), actions());
    expect(labels(model)).toContain('Ungroup');
    expect(labels(model)).toContain('Rename group');
    expect(find(model, 'Ungroup')?.shortcut).toBe('Ctrl+Shift+G');
  });

  it('runs each entry through its action', () => {
    const a = actions();
    const model = buildMenu(inputs(), a);
    for (const label of [
      'Open',
      'Test step',
      'Rename',
      'Replace',
      'Deactivate',
      'Pin',
      'Copy',
      'Duplicate',
      'Tidy up',
      'Select all',
      'Deselect all',
      'Delete',
    ])
      find(model, label)?.run();
    expect(a.open).toHaveBeenCalledWith('A');
    expect(a.testStep).toHaveBeenCalledWith('A');
    expect(a.rename).toHaveBeenCalledWith('A');
    expect(a.replace).toHaveBeenCalledWith('A');
    expect(a.toggleDisabled).toHaveBeenCalledWith(['A']);
    expect(a.pin).toHaveBeenCalledWith(['A']);
    expect(a.copy).toHaveBeenCalled();
    expect(a.duplicate).toHaveBeenCalled();
    expect(a.tidyUp).toHaveBeenCalledWith(undefined);
    expect(a.selectAll).toHaveBeenCalled();
    expect(a.deselectAll).toHaveBeenCalled();
    expect(a.removeNodes).toHaveBeenCalledWith(['A']);
  });
});

describe('node menu (multi-selection)', () => {
  const multi = (over: Partial<MenuInputs> = {}) =>
    inputs({ target: { type: 'selection' }, selection: sel('A', 'B'), ...over });

  it('is the single menu without Open, Test step, Rename and with plural labels', () => {
    const model = buildMenu(multi(), actions());
    expect(labels(model)).toEqual([
      'Deactivate nodes',
      'Pin nodes',
      'Copy nodes',
      'Duplicate nodes',
      'Tidy up selection',
      'Group nodes',
      'Convert to sub-workflow',
      'Select all',
      'Deselect all',
      'Delete nodes',
    ]);
    expect(find(model, 'Group nodes')?.shortcut).toBe('Ctrl+G');
    expect(find(model, 'Convert to sub-workflow')?.shortcut).toBe('Alt+X');
  });

  it('a right-click on a selected node with 2+ selected shows this menu', () => {
    const model = buildMenu(multi({ target: { type: 'node', nodeName: 'A' } }), actions());
    expect(labels(model)).toContain('Group nodes');
    expect(labels(model)).not.toContain('Open');
  });

  it('disables Group when not groupable and hides Convert when not extractable', () => {
    const model = buildMenu(multi({ selection: sel('W', 'A') }), actions());
    expect(find(model, 'Group nodes')?.disabled).toBe(true);
    expect(find(model, 'Group nodes')?.reason).toBeTruthy();
    expect(labels(model)).not.toContain('Convert to sub-workflow');
  });

  it('read-only: no Convert, Group disabled, writes disabled, Copy enabled', () => {
    const model = buildMenu(multi({ readOnly: true }), actions());
    expect(labels(model)).not.toContain('Convert to sub-workflow');
    expect(find(model, 'Group nodes')?.disabled).toBe(true);
    expect(find(model, 'Delete nodes')?.disabled).toBe(true);
    expect(find(model, 'Copy nodes')?.disabled).toBeFalsy();
  });

  it('acts on all selected nodes', () => {
    const a = actions();
    const model = buildMenu(multi(), a);
    find(model, 'Deactivate nodes')?.run();
    find(model, 'Tidy up selection')?.run();
    find(model, 'Group nodes')?.run();
    find(model, 'Convert to sub-workflow')?.run();
    find(model, 'Delete nodes')?.run();
    expect(a.toggleDisabled).toHaveBeenCalledWith(['A', 'B']);
    expect(a.tidyUp).toHaveBeenCalledWith({ nodes: ['A', 'B'], stickies: [] });
    expect(a.group).toHaveBeenCalled();
    expect(a.convert).toHaveBeenCalled();
    expect(a.removeSelection).toHaveBeenCalled();
  });
});

describe('node menu (group frame, sticky, canvas)', () => {
  const group: WorkflowNodeGroup = { id: 'g1', name: 'Group', nodeIds: ['a', 'b'], description: 'about it' };
  const withGroup = (over: Partial<MenuInputs> = {}) =>
    inputs({
      target: { type: 'group', groupId: 'g1' },
      graph: graph({ nodeGroups: [group] }),
      selection: sel('A', 'B'),
      ...over,
    });

  it('group title: Rename group, Ungroup, then the selection menu worded for the group', () => {
    const l = labels(buildMenu(withGroup(), actions()));
    expect(l.slice(0, 2)).toEqual(['Rename group', 'Ungroup']);
    expect(l).toContain('Tidy up selection');
    expect(l).not.toContain('Group nodes');
    expect(l).not.toContain('Open');
  });

  it('group view entries: collapse, expand, description toggle; enabled in read-only', () => {
    const a = actions();
    const expanded = buildMenu(withGroup({ readOnly: true, groupView: { expanded: ['g1'], pinned: [] } }), a);
    expect(find(expanded, 'Collapse group')?.shortcut).toBe('Shift+Alt+G');
    expect(find(expanded, 'Collapse group')?.disabled).toBeFalsy();
    expect(labels(expanded)).not.toContain('Show description');
    find(expanded, 'Collapse group')?.run();
    expect(a.setGroupsExpanded).toHaveBeenCalledWith(['g1'], false);

    const collapsed = buildMenu(withGroup({ groupView: { expanded: [], pinned: [] } }), a);
    expect(find(collapsed, 'Expand group')?.shortcut).toBe('Alt+G');
    expect(labels(collapsed)).toContain('Show description');
    const pinned = buildMenu(withGroup({ groupView: { expanded: [], pinned: ['g1'] } }), a);
    expect(labels(pinned)).toContain('Hide description');
    find(pinned, 'Hide description')?.run();
    expect(a.setDescriptionPinned).toHaveBeenCalledWith('g1', false);
  });

  it('sticky: Edit sticky note, Change color, Duplicate, Delete, Select all, Deselect all', () => {
    const base = {
      target: { type: 'sticky', stickyId: 's1' } as const,
      selection: { nodes: [], stickies: ['s1'], edges: [] },
    };
    const model = buildMenu(inputs(base), actions());
    expect(labels(model)).toEqual([
      'Edit sticky note',
      'Change color',
      'Duplicate',
      'Delete',
      'Select all',
      'Deselect all',
    ]);
    expect(find(model, 'Edit sticky note')?.shortcut).toBe('Enter');
    const ro = buildMenu(inputs({ ...base, readOnly: true }), actions());
    for (const label of ['Edit sticky note', 'Change color', 'Duplicate', 'Delete'])
      expect(find(ro, label)?.disabled, label).toBe(true);
    expect(find(ro, 'Select all')?.disabled).toBeFalsy();
  });

  it('canvas: Add node, Add sticky note, Tidy up workflow, Select all', () => {
    const a = actions();
    const model = buildMenu(inputs({ target: { type: 'canvas', position: [10, 20] } }), a);
    expect(labels(model)).toEqual(['Add node', 'Add sticky note', 'Tidy up workflow', 'Select all']);
    expect(find(model, 'Add node')?.shortcut).toBe('N');
    expect(find(model, 'Add sticky note')?.shortcut).toBe('Shift+S');
    find(model, 'Add node')?.run();
    find(model, 'Add sticky note')?.run();
    expect(a.addNode).toHaveBeenCalledWith([10, 20]);
    expect(a.addSticky).toHaveBeenCalledWith([10, 20]);
    const ro = buildMenu(inputs({ target: { type: 'canvas', position: [0, 0] }, readOnly: true }), actions());
    expect(find(ro, 'Add node')?.disabled).toBe(true);
    expect(find(ro, 'Add sticky note')?.disabled).toBe(true);
    expect(find(ro, 'Tidy up workflow')?.disabled).toBe(true);
    expect(find(ro, 'Select all')?.disabled).toBeFalsy();
  });

  it('canvas with groups adds Expand all / Collapse all (enabled in read-only)', () => {
    const a = actions();
    const model = buildMenu(
      inputs({
        target: { type: 'canvas', position: [0, 0] },
        graph: graph({ nodeGroups: [group] }),
        readOnly: true,
        groupView: { expanded: [], pinned: [] },
      }),
      a,
    );
    expect(labels(model)).toContain('Expand all groups');
    expect(labels(model)).not.toContain('Collapse all groups');
    find(model, 'Expand all groups')?.run();
    expect(a.setGroupsExpanded).toHaveBeenCalledWith('all', true);
  });
});
