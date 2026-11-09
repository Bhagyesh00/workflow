/**
 * Phase 3 C0b contracts: store slices (groups, pins, publish pointer, archive), ui flags, new
 * shortcuts and canvas context menu wiring, endpoint URLs and bodies, moved commands and the demo
 * backend's new routes. Stubs other lanes fill are mocked; their return values are never asserted.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type NodeTypeDescription,
  validateWorkflowNodeGroups,
  type WorkflowNode,
  type WorkflowNodeGroup,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApiRequest, setTransport } from '../src/api/client';
import {
  annotationTagsApi,
  binaryDataUrl,
  executionsApi,
  favoritesApi,
  fetchBinaryData,
  foldersApi,
  inboxApi,
  reviewsApi,
  settingsApi,
  workflowsApi,
} from '../src/api/endpoints';
import { PUSH_EVENT_TYPES } from '../src/api/types';
import { confirmDialog } from '../src/components/ui/Dialog';
import { demoGroupedWorkflow, demoNodeTypes } from '../src/demo/fixtures';
import { addNodeFromDescription } from '../src/features/editor/add-node';
import { saveWorkflow } from '../src/features/editor/editor-actions';
import {
  canPin,
  copySelectionToClipboard,
  cutSelection,
  readMemoryClipboard,
} from '../src/features/editor/node-commands';
import { openSubWorkflow } from '../src/features/editor/open-resources';
import { tidyUp } from '../src/features/editor/tidy-up';
import { copyNodeWebhookUrl } from '../src/features/editor/webhook-urls';
import { addStickyAt, downloadWorkflow, duplicateWorkflow } from '../src/features/editor/workflow-commands';
import {
  debugExecution,
  deleteExecution,
  retryExecution,
  stopExecution,
} from '../src/features/executions/execution-commands';
import { setGroupsExpanded } from '../src/lib/group-view';
import {
  crossingEditError,
  extendGroupsForConnection,
  groupNodes,
  groupsOfNodes,
  ungroupNodes,
} from '../src/lib/node-groups';
import { replaceNode } from '../src/lib/replace-node';
import { connectionId, EMPTY_GRAPH, pasteSubgraph, type WorkflowGraph } from '../src/lib/workflow-ops';
import { useRunStore } from '../src/stores/run-store';
import { toast, useToastStore, useUiStore } from '../src/stores/ui-store';
import { graphOf, toWorkflowBody, useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp, runDataFor, testQueryClient, withProviders } from './utils';

vi.mock('../src/features/editor/tidy-up', () => ({ tidyUp: vi.fn() }));
vi.mock('../src/features/editor/webhook-urls', () => ({ copyNodeWebhookUrl: vi.fn(async () => true) }));
vi.mock('../src/features/editor/open-resources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/editor/open-resources')>()),
  openSubWorkflow: vi.fn(),
}));
vi.mock('../src/lib/group-view', () => ({
  setGroupsExpanded: vi.fn(),
  isGroupExpanded: vi.fn(),
  setGroupDescriptionPinned: vi.fn(),
  isGroupDescriptionPinned: vi.fn(),
}));
vi.mock('../src/lib/replace-node', () => ({ replaceNode: vi.fn() }));
vi.mock('../src/lib/node-groups', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/node-groups')>();
  return {
    ...original,
    groupNodes: vi.fn((graph: WorkflowGraph, names: string[]) => {
      const ids = graph.nodes.filter((n) => names.includes(n.name)).map((n) => n.id);
      const group: WorkflowNodeGroup = { id: 'grp-new', name: 'Group 2', nodeIds: ids };
      return {
        graph: { ...graph, nodeGroups: [...graph.nodeGroups, group] },
        groupId: 'grp-new',
        problems: [],
      };
    }),
    ungroupNodes: vi.fn((graph: WorkflowGraph, id: string) => ({
      ...graph,
      nodeGroups: graph.nodeGroups.filter((g) => g.id !== id),
    })),
    crossingEditError: vi.fn(() => null),
    extendGroupsForConnection: vi.fn((graph: WorkflowGraph) => ({ graph, extended: [] })),
  };
});
vi.mock('../src/components/ui/Dialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/components/ui/Dialog')>()),
  confirmDialog: vi.fn(async () => true),
}));

const describeOf = (name: string): NodeTypeDescription => demoNodeTypes.find((d) => d.name === name)!;
const descriptions = { get: (type: string) => demoNodeTypes.find((d) => d.name === type) };

const node = (id: string, name: string, type: string, x: number): WorkflowNode => ({
  id,
  name,
  type,
  typeVersion: 1,
  position: [x, 0],
  parameters: {},
});

const GROUP: WorkflowNodeGroup = { id: 'grp1', name: 'Group', nodeIds: ['n2', 'n3'] };

function seed(extra: Partial<Parameters<ReturnType<typeof backend>['seedWorkflow']>[0]> = {}) {
  signedIn();
  return backend().seedWorkflow({
    name: 'Grouped',
    nodes: [
      node('n1', 'Start', 'core.manualTrigger', 0),
      node('n2', 'Shape', 'core.set', 300),
      node('n3', 'Other', 'core.set', 600),
    ],
    connections: {
      Start: { main: [[{ node: 'Shape', type: 'main', index: 0 }]] },
      Shape: { main: [[{ node: 'Other', type: 'main', index: 0 }]] },
    },
    stickyNotes: [{ id: 's1', content: 'note', position: [0, 300], width: 200, height: 100 }],
    nodeGroups: [GROUP],
    ...extra,
  });
}

async function openEditor(id: string) {
  const utils = renderApp(`/workflow/${id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(document.querySelector('[data-id="n2"]')).toBeTruthy());
  return utils;
}

const select = (nodes: string[], stickies: string[] = []) =>
  act(() => useWorkflowStore.getState().select({ nodes, stickies, edges: [] }));

const key = (init: KeyboardEventInit) => act(() => void fireEvent.keyDown(window, init));

const deps = () => ({ navigate: vi.fn(), descriptions });

beforeEach(() => {
  vi.clearAllMocks();
  useWorkflowStore.getState().reset();
  useWorkflowStore.setState({ nodeTypeLookup: undefined });
  useRunStore.getState().reset();
  useToastStore.setState({ toasts: [] });
  useUiStore.setState({
    ndvNode: null,
    sidePanel: null,
    contextMenu: null,
    renameTarget: null,
    convertOpen: false,
    importOpen: false,
    importUrlOpen: false,
    replaceTarget: null,
    workflowRenameRequested: false,
    tagsEditRequested: false,
  });
});

// ---------------------------------------------------------------------------------------------
describe('workflow store slices', () => {
  const load = () =>
    useWorkflowStore.getState().load({
      id: 'w1',
      name: 'W',
      versionId: 'v1',
      nodes: [node('a', 'A', 'core.set', 0), node('b', 'B', 'core.set', 300)],
      connections: {},
      nodeGroups: [{ id: 'g', name: 'Group', nodeIds: ['a', 'b'] }],
    });

  it('keeps nodeGroups through load, undo and redo, and in toWorkflowBody', () => {
    load();
    const s = useWorkflowStore.getState();
    expect(s.nodeGroups).toEqual([{ id: 'g', name: 'Group', nodeIds: ['a', 'b'] }]);
    s.applyGraph({ ...graphOf(s), nodeGroups: [] });
    expect(useWorkflowStore.getState().nodeGroups).toEqual([]);
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().nodeGroups).toHaveLength(1);
    useWorkflowStore.getState().redo();
    expect(useWorkflowStore.getState().nodeGroups).toEqual([]);
    useWorkflowStore.getState().undo();
    expect(toWorkflowBody(useWorkflowStore.getState()).nodeGroups).toEqual([
      { id: 'g', name: 'Group', nodeIds: ['a', 'b'] },
    ]);
    useWorkflowStore.getState().reset();
    expect(useWorkflowStore.getState().nodeGroups).toEqual([]);
    expect(EMPTY_GRAPH.nodeGroups).toEqual([]);
  });

  it('pasteSubgraph keeps the graph nodeGroups', () => {
    const graph: WorkflowGraph = {
      ...EMPTY_GRAPH,
      nodes: [node('a', 'A', 'core.set', 0)],
      nodeGroups: [GROUP],
    };
    const result = pasteSubgraph(graph, {
      kind: 'workflow-clipboard',
      nodes: [node('x', 'X', 'core.set', 0)],
      connections: {},
    });
    expect(result.graph.nodeGroups).toEqual([GROUP]);
  });

  it('setPinDataMany and applyGraph are one undo step each', () => {
    load();
    const s = useWorkflowStore.getState();
    const before = s.past.length;
    s.setPinDataMany({ A: [{ json: { a: 1 } }], B: [{ json: { b: 1 } }] });
    expect(Object.keys(useWorkflowStore.getState().pinData).sort()).toEqual(['A', 'B']);
    expect(useWorkflowStore.getState().past).toHaveLength(before + 1);
    useWorkflowStore.getState().setPinDataMany({ A: null });
    expect(Object.keys(useWorkflowStore.getState().pinData)).toEqual(['B']);
    useWorkflowStore.getState().undo();
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().pinData).toEqual({});

    const g = graphOf(useWorkflowStore.getState());
    useWorkflowStore.getState().applyGraph(
      {
        ...g,
        nodes: g.nodes.map((n) => ({ ...n, position: [n.position[0] + 10, 5] as [number, number] })),
      },
      { nodes: ['B'], stickies: [], edges: [] },
    );
    expect(useWorkflowStore.getState().selection.nodes).toEqual(['B']);
    expect(useWorkflowStore.getState().nodes[0].position).toEqual([10, 5]);
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().nodes[0].position).toEqual([0, 0]);
  });

  it('keeps the publish pointer: setPublished, and setActive as its wrapper', () => {
    load();
    const s = useWorkflowStore.getState();
    expect(s.meta).toMatchObject({
      active: false,
      publishedVersionId: null,
      folderId: null,
      isArchived: false,
    });
    s.setPublished('v1');
    expect(useWorkflowStore.getState().meta).toMatchObject({ active: true, publishedVersionId: 'v1' });
    s.setActive(false);
    expect(useWorkflowStore.getState().meta).toMatchObject({ active: false, publishedVersionId: null });
    s.setActive(true, 'v2');
    expect(useWorkflowStore.getState().meta).toMatchObject({
      active: true,
      publishedVersionId: 'v2',
      versionId: 'v2',
    });
  });

  it('loads an archived workflow read-only', () => {
    useWorkflowStore.getState().load({ id: 'w', name: 'Old', isArchived: true, folderId: 'f1' });
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    expect(useWorkflowStore.getState().meta).toMatchObject({ isArchived: true, folderId: 'f1' });
    useWorkflowStore.getState().setArchived(false, false);
    expect(useWorkflowStore.getState().readOnly).toBe(false);
    useWorkflowStore.getState().setArchived(true);
    expect(useWorkflowStore.getState().readOnly).toBe(true);
  });

  it('group actions delegate to lib/node-groups and record history', () => {
    load();
    useWorkflowStore.getState().select({ nodes: ['A', 'B'] });
    const before = useWorkflowStore.getState().past.length;
    useWorkflowStore.getState().groupSelection();
    expect(groupNodes).toHaveBeenCalledWith(
      expect.objectContaining({ nodeGroups: expect.any(Array) }),
      ['A', 'B'],
      undefined,
    );
    expect(useWorkflowStore.getState().past).toHaveLength(before + 1);
    useWorkflowStore.getState().ungroup('g');
    expect(ungroupNodes).toHaveBeenCalledWith(expect.anything(), 'g');
  });

  it('refuses a group-crossing edit with a toast whose Ungroup action ungroups', () => {
    load();
    vi.mocked(crossingEditError).mockReturnValueOnce({ message: 'Only one exit is allowed', groupId: 'g' });
    const ref = {
      source: 'A',
      sourceType: 'main' as const,
      sourceIndex: 0,
      target: 'B',
      targetType: 'main' as const,
      targetIndex: 0,
    };
    useWorkflowStore.getState().connect(ref);
    expect(crossingEditError).toHaveBeenCalledWith(expect.anything(), ref, 'connect', undefined);
    expect(useWorkflowStore.getState().connections).toEqual({});
    const shown = useToastStore.getState().toasts.at(-1)!;
    expect(shown).toMatchObject({ kind: 'error', title: 'Only one exit is allowed' });
    expect(shown.action?.label).toBe('Ungroup');
    shown.action!.onClick();
    expect(ungroupNodes).toHaveBeenCalledWith(expect.anything(), 'g');

    // allowed: connect, then the auto-extend hook reports the extended group
    vi.mocked(extendGroupsForConnection).mockImplementationOnce((graph) => ({ graph, extended: ['Group'] }));
    useWorkflowStore.getState().connect(ref);
    expect(useWorkflowStore.getState().connections.A?.main?.[0]).toEqual([
      { node: 'B', type: 'main', index: 0 },
    ]);
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'info', title: "'Group' extended" });

    vi.mocked(crossingEditError).mockReturnValueOnce({ message: 'Blocked', groupId: 'g' });
    useWorkflowStore.getState().disconnect(ref);
    expect(crossingEditError).toHaveBeenLastCalledWith(expect.anything(), ref, 'disconnect', undefined);
    expect(useWorkflowStore.getState().connections.A?.main?.[0]).toHaveLength(1);
    vi.mocked(crossingEditError).mockReturnValueOnce({ message: 'Blocked', groupId: 'g' });
    useWorkflowStore.getState().insertOnConnection(ref, node('c', 'C', 'core.set', 0));
    expect(crossingEditError).toHaveBeenLastCalledWith(expect.anything(), ref, 'insert', undefined);
    expect(useWorkflowStore.getState().nodes).toHaveLength(2);
  });

  /** the real guard and auto-extend for one test (the file mocks them to "allowed") */
  async function withRealGroupGuard(run: () => void) {
    const real = await vi.importActual<typeof import('../src/lib/node-groups')>('../src/lib/node-groups');
    vi.mocked(crossingEditError).mockImplementation(real.crossingEditError);
    vi.mocked(extendGroupsForConnection).mockImplementation(real.extendGroupsForConnection);
    try {
      run();
    } finally {
      vi.mocked(crossingEditError).mockImplementation(() => null);
      vi.mocked(extendGroupsForConnection).mockImplementation((graph: WorkflowGraph) => ({
        graph,
        extended: [],
      }));
    }
  }

  /** Start -> A -> B with the group {A, B} */
  const loadChain = () =>
    useWorkflowStore.getState().load({
      id: 'w1',
      name: 'W',
      versionId: 'v1',
      nodes: [
        node('s', 'Start', 'core.manualTrigger', 0),
        node('a', 'A', 'core.set', 300),
        node('b', 'B', 'core.set', 600),
      ],
      connections: {
        Start: { main: [[{ node: 'A', type: 'main', index: 0 }]] },
        A: { main: [[{ node: 'B', type: 'main', index: 0 }]] },
      },
      nodeGroups: [{ id: 'g', name: 'Group', nodeIds: ['a', 'b'] }],
    });
  const groupProblems = () =>
    validateWorkflowNodeGroups(toWorkflowBody(useWorkflowStore.getState()) as never).map((p) => p.code);

  it('addNode links go through the group guard and auto-extend, as connect does', async () => {
    loadChain();
    const fromA = {
      source: 'A',
      sourceType: 'main' as const,
      sourceIndex: 0,
      targetType: 'main' as const,
      targetIndex: 0,
    };
    useWorkflowStore.getState().addNode(node('n', 'N', 'core.set', 900), { from: fromA });
    expect(crossingEditError).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ name: 'N' })]) }),
      { ...fromA, target: 'N' },
      'connect',
      undefined,
    );
    expect(extendGroupsForConnection).toHaveBeenCalled();

    // refused: nothing is added and the toast offers Ungroup
    loadChain();
    vi.mocked(crossingEditError).mockReturnValueOnce({ message: 'Blocked', groupId: 'g' });
    useWorkflowStore.getState().addNode(node('n', 'N', 'core.set', 900), { from: fromA });
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Start', 'A', 'B']);
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', title: 'Blocked' });
    expect(useToastStore.getState().toasts.at(-1)?.action?.label).toBe('Ungroup');

    // allowed: the extended group gets the info toast
    loadChain();
    vi.mocked(extendGroupsForConnection).mockImplementationOnce((graph) => ({ graph, extended: ['Group'] }));
    useWorkflowStore.getState().addNode(node('n', 'N', 'core.set', 900), { from: fromA });
    expect(useWorkflowStore.getState().connections.A?.main?.[0]).toContainEqual({
      node: 'N',
      type: 'main',
      index: 0,
    });
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'info', title: "'Group' extended" });

    // with the real rules, adding after A never leaves an invalid group to save
    await withRealGroupGuard(() => {
      loadChain();
      useWorkflowStore.getState().addNode(node('n', 'N', 'core.set', 900), { from: fromA });
    });
    expect(groupProblems()).toEqual([]);
    // adding after the exit node B is a plain connection outside the group
    await withRealGroupGuard(() => {
      loadChain();
      useWorkflowStore
        .getState()
        .addNode(node('n', 'N', 'core.set', 900), { from: { ...fromA, source: 'B' } });
    });
    expect(useWorkflowStore.getState().connections.B?.main?.[0]).toEqual([
      { node: 'N', type: 'main', index: 0 },
    ]);
    expect(useWorkflowStore.getState().nodeGroups).toEqual([{ id: 'g', name: 'Group', nodeIds: ['a', 'b'] }]);
  });

  it('deleting a selected cable that would break a group is refused; cables of deleted nodes are not', async () => {
    const cable = (source: string, target: string) =>
      connectionId({
        source,
        sourceType: 'main',
        sourceIndex: 0,
        target,
        targetType: 'main',
        targetIndex: 0,
      });
    const inner = cable('A', 'B');
    await withRealGroupGuard(() => {
      loadChain();
      useWorkflowStore.getState().select({ nodes: [], stickies: [], edges: [inner] });
      useWorkflowStore.getState().deleteSelection();
    });
    expect(useWorkflowStore.getState().connections.A?.main?.[0]).toEqual([
      { node: 'B', type: 'main', index: 0 },
    ]);
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error' });
    expect(useToastStore.getState().toasts.at(-1)?.action?.label).toBe('Ungroup');
    expect(groupProblems()).toEqual([]);

    // the cable goes with its deleted node B: the group shrinks to {A}, nothing is refused
    useToastStore.setState({ toasts: [] });
    await withRealGroupGuard(() => {
      loadChain();
      useWorkflowStore.getState().select({ nodes: ['B'], stickies: [], edges: [inner] });
      useWorkflowStore.getState().deleteSelection();
    });
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Start', 'A']);
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(groupProblems()).toEqual([]);

    // a cable outside any group is deleted as before
    await withRealGroupGuard(() => {
      loadChain();
      useWorkflowStore.getState().select({ nodes: [], stickies: [], edges: [cable('Start', 'A')] });
      useWorkflowStore.getState().deleteSelection();
    });
    expect(useWorkflowStore.getState().connections.Start?.main?.[0] ?? []).toEqual([]);
  });

  it('groupsOfNodes lists the groups holding any of the nodes', () => {
    const graph: WorkflowGraph = {
      ...EMPTY_GRAPH,
      nodes: [node('a', 'A', 'core.set', 0), node('b', 'B', 'core.set', 0), node('c', 'C', 'core.set', 0)],
      nodeGroups: [
        { id: 'g1', name: 'G1', nodeIds: ['a'] },
        { id: 'g2', name: 'G2', nodeIds: ['b'] },
      ],
    };
    expect(groupsOfNodes(graph, ['B', 'C'])).toEqual(['g2']);
    expect(groupsOfNodes(graph, ['A', 'B'])).toEqual(['g1', 'g2']);
    expect(groupsOfNodes(graph, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('saving', () => {
  it('sends nodeGroups in the create and update bodies, and autosaved only when asked', async () => {
    signedIn();
    useWorkflowStore
      .getState()
      .load({ name: 'New', nodes: [node('a', 'A', 'core.set', 0)], nodeGroups: [GROUP] });
    const created = await saveWorkflow(deps());
    expect(created).toBeTruthy();
    const post = backend().requests.find((r) => r.method === 'POST' && r.path === '/workflows')!;
    expect((post.body as { nodeGroups: unknown }).nodeGroups).toEqual([GROUP]);

    useWorkflowStore.getState().setName('Renamed');
    await saveWorkflow(deps());
    const patches = () => backend().requests.filter((r) => r.method === 'PATCH');
    expect(patches()[0].body).toMatchObject({ nodeGroups: [GROUP] });
    expect(patches()[0].body).not.toHaveProperty('autosaved');

    useWorkflowStore.getState().setName('Renamed again');
    await saveWorkflow(deps(), { autosaved: true });
    expect(patches()[1].body).toMatchObject({ autosaved: true, nodeGroups: [GROUP] });
    const versions = await workflowsApi.versions(created!.id);
    expect(versions.data[0]).toMatchObject({ autosaved: true, versionName: null, description: null });
    expect(versions.data[1].autosaved).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('editor wiring', () => {
  it('right-click on a node selects it and opens the menu; the pane gives the canvas target', async () => {
    const wf = seed();
    await openEditor(wf.id);
    fireEvent.contextMenu(document.querySelector('[data-id="n2"]')!, { clientX: 40, clientY: 50 });
    expect(useWorkflowStore.getState().selection.nodes).toEqual(['Shape']);
    expect(useUiStore.getState().contextMenu).toEqual({
      x: 40,
      y: 50,
      target: { type: 'node', nodeName: 'Shape' },
    });

    select(['Shape', 'Other']);
    fireEvent.contextMenu(document.querySelector('[data-id="n3"]')!);
    expect(useUiStore.getState().contextMenu?.target).toEqual({ type: 'selection' });
    expect(useWorkflowStore.getState().selection.nodes).toEqual(['Shape', 'Other']);

    fireEvent.contextMenu(document.querySelector('.react-flow__pane')!, { clientX: 10, clientY: 20 });
    const menu = useUiStore.getState().contextMenu!;
    expect(menu).toMatchObject({ x: 10, y: 20, target: { type: 'canvas' } });
    expect(menu.target.type === 'canvas' && menu.target.position).toHaveLength(2);

    fireEvent.contextMenu(document.querySelector('[data-id="sticky:s1"]')!);
    expect(useUiStore.getState().contextMenu?.target).toMatchObject({ stickyId: 's1' });
    expect(useWorkflowStore.getState().selection.stickies).toEqual(['s1']);

    // the node toolbar's More button opens the same menu
    act(() => useUiStore.getState().closeContextMenu());
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Other' }));
    expect(useUiStore.getState().contextMenu?.target).toEqual({ type: 'node', nodeName: 'Other' });
    expect(useWorkflowStore.getState().selection.nodes).toEqual(['Other']);
  });

  it('new shortcuts call their commands', async () => {
    const wf = seed();
    await openEditor(wf.id);
    select(['Shape']);

    key({ key: 'F2', code: 'F2' });
    expect(useUiStore.getState().renameTarget).toBe('Shape');
    // F2 opens the modal rename dialog, and keys are ignored while a dialog is open: close it first
    act(() => useUiStore.getState().setRenameTarget(null));

    key({ key: 'r', code: 'KeyR' });
    expect(useUiStore.getState()).toMatchObject({ replaceTarget: 'Shape', sidePanel: 'creator' });
    expect(await screen.findByText('Replace Shape')).toBeTruthy();
    act(() => useUiStore.getState().setSidePanel(null));
    expect(useUiStore.getState().replaceTarget).toBeNull();

    key({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true });
    expect(openSubWorkflow).toHaveBeenCalledWith('Shape');

    key({ key: 'u', code: 'KeyU', altKey: true });
    expect(copyNodeWebhookUrl).toHaveBeenLastCalledWith('Shape', 'production');
    key({ key: 'U', code: 'KeyU', altKey: true, shiftKey: true });
    expect(copyNodeWebhookUrl).toHaveBeenLastCalledWith('Shape', 'test');

    key({ key: '©', code: 'KeyG', altKey: true });
    expect(setGroupsExpanded).toHaveBeenLastCalledWith(['grp1'], true);
    key({ key: 'G', code: 'KeyG', altKey: true, shiftKey: true });
    expect(setGroupsExpanded).toHaveBeenLastCalledWith(['grp1'], false);
    select([]);
    key({ key: 'g', code: 'KeyG', altKey: true });
    expect(setGroupsExpanded).toHaveBeenLastCalledWith('all', true);

    key({ key: 'T', code: 'KeyT', altKey: true, shiftKey: true });
    expect(tidyUp).toHaveBeenLastCalledWith(expect.anything(), undefined);
    select(['Shape', 'Other']);
    key({ key: 'T', code: 'KeyT', altKey: true, shiftKey: true });
    expect(tidyUp).toHaveBeenLastCalledWith(expect.anything(), { nodes: ['Shape', 'Other'], stickies: [] });

    key({ key: 'x', code: 'KeyX', altKey: true });
    expect(useUiStore.getState().convertOpen).toBe(true);
    act(() => useUiStore.getState().setConvertOpen(false));

    key({ key: 'g', code: 'KeyG', ctrlKey: true });
    expect(groupNodes).toHaveBeenCalledWith(expect.anything(), ['Shape', 'Other'], expect.any(Function));
    expect(useWorkflowStore.getState().nodeGroups.map((g) => g.id)).toEqual(['grp1', 'grp-new']);
    select(['Shape']);
    key({ key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true });
    expect(ungroupNodes).toHaveBeenCalledWith(expect.anything(), 'grp1');
  });

  it('P pins the last output (one undo step) and unpins pinned nodes', async () => {
    const wf = seed();
    await openEditor(wf.id);
    act(() => useRunStore.setState({ runData: runDataFor('Shape', [{ a: 1 }]) }));
    select(['Shape']);
    const before = useWorkflowStore.getState().past.length;
    key({ key: 'p', code: 'KeyP' });
    expect(useWorkflowStore.getState().pinData.Shape).toEqual([{ json: { a: 1 } }]);
    expect(useWorkflowStore.getState().past).toHaveLength(before + 1);
    key({ key: 'p', code: 'KeyP' });
    expect(useWorkflowStore.getState().pinData.Shape).toBeUndefined();
    act(() => useWorkflowStore.getState().undo());
    expect(useWorkflowStore.getState().pinData.Shape).toHaveLength(1);
  });

  it('the canvas Tidy up button and the selection toolbar call their commands', async () => {
    const user = userEvent.setup();
    // Shape and Other outside any group, so the selection can be grouped (one group per node)
    const wf = seed({ nodeGroups: [] });
    await openEditor(wf.id);
    await user.click(screen.getByRole('button', { name: 'Tidy up' }));
    expect(tidyUp).toHaveBeenCalledWith(expect.anything(), undefined);

    expect(screen.queryByRole('toolbar', { name: 'Selection actions' })).toBeNull();
    select(['Shape', 'Other']);
    const toolbar = await screen.findByRole('toolbar', { name: 'Selection actions' });
    await user.click(within(toolbar).getByRole('button', { name: /Convert to sub-workflow/ }));
    expect(useUiStore.getState().convertOpen).toBe(true);
    act(() => useUiStore.getState().setConvertOpen(false));
    const group = within(toolbar).getByRole('button', { name: /Group/ });
    expect((group as HTMLButtonElement).disabled).toBe(false);
    await user.click(group);
    expect(vi.mocked(groupNodes).mock.calls.at(-1)?.[1]).toEqual(['Shape', 'Other']);
  });

  it('an archived workflow opens read-only with Restore and Delete instead of Archive', async () => {
    const user = userEvent.setup();
    const wf = seed({ isArchived: true });
    await openEditor(wf.id);
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Restore' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
  });

  it('"Import from URL" in the More menu sets the flag; rename and tags requests reach the header', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    await user.click(await screen.findByRole('menuitem', { name: 'Import from URL' }));
    expect(useUiStore.getState().importUrlOpen).toBe(true);

    act(() => useUiStore.getState().setWorkflowRenameRequested(true));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Workflow name' })),
    );
    expect(useUiStore.getState().workflowRenameRequested).toBe(false);

    act(() => useUiStore.getState().setTagsEditRequested(true));
    expect(await screen.findByRole('textbox', { name: 'Find or create a tag' })).toBeTruthy();
    expect(useUiStore.getState().tagsEditRequested).toBe(false);
  });

  it('ui.importOpen opens the import dialog on the workflows page', async () => {
    signedIn();
    renderApp('/workflows');
    await screen.findByRole('heading', { name: 'Workflows' }, { timeout: 20_000 });
    act(() => useUiStore.getState().setImportOpen(true));
    expect(await screen.findByRole('dialog', { name: 'Import a workflow' })).toBeTruthy();
  });

  it('the executions page sends its annotation and version URL params to the list', async () => {
    signedIn();
    renderApp('/executions?annotationTags=t1,t2&vote=up&workflowVersionId=v1');
    await waitFor(() =>
      expect(
        backend().requests.some(
          (r) =>
            r.path === '/executions' &&
            r.query?.annotationTags === 't1,t2' &&
            r.query?.vote === 'up' &&
            r.query?.workflowVersionId === 'v1',
        ),
      ).toBe(true),
    );
  });

  it('shows the Inbox nav only while workflow reviews are on, and lists the new push event', async () => {
    signedIn();
    renderApp('/workflows');
    await screen.findByRole('heading', { name: 'Workflows' }, { timeout: 20_000 });
    expect(screen.queryByRole('link', { name: /Inbox/ })).toBeNull();
    expect(PUSH_EVENT_TYPES).toContain('workflowReviewChanged');
  });
});

// ---------------------------------------------------------------------------------------------
describe('endpoints', () => {
  function record() {
    const requests: ApiRequest[] = [];
    setTransport(async (request) => {
      requests.push(request);
      return { status: 200, body: { data: null } };
    });
    return requests;
  }
  const last = (requests: ApiRequest[]) => {
    const { method, path, query, body } = requests[requests.length - 1];
    return { method, path, query, body };
  };

  it('build the documented URLs and bodies', async () => {
    const r = record();
    await workflowsApi.list({
      folderId: 'root',
      archived: 'all',
      search: 'x',
      nodeTypes: ['a', 'b'],
      matchTags: true,
    });
    expect(last(r)).toMatchObject({
      method: 'GET',
      path: '/workflows',
      query: { folderId: 'root', archived: 'all', search: 'x', nodeTypes: 'a,b', matchTags: true },
    });
    await workflowsApi.archive('w 1');
    expect(last(r)).toMatchObject({ method: 'POST', path: '/workflows/w%201/archive' });
    await workflowsApi.unarchive('w1');
    expect(last(r)).toMatchObject({ method: 'POST', path: '/workflows/w1/unarchive' });
    await workflowsApi.move({ workflowIds: ['a'], folderId: null });
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/workflows/move',
      body: { workflowIds: ['a'], folderId: null },
    });
    await workflowsApi.activate('w1');
    expect(last(r)).toMatchObject({ method: 'POST', path: '/workflows/w1/activate', body: {} });
    await workflowsApi.activate('w1', { versionId: 'v1', versionName: 'One', description: 'd' });
    expect(last(r).body).toEqual({ versionId: 'v1', versionName: 'One', description: 'd' });
    await workflowsApi.updateVersion('w1', 'v1', { versionName: 'Named' });
    expect(last(r)).toMatchObject({
      method: 'PATCH',
      path: '/workflows/w1/versions/v1',
      body: { versionName: 'Named' },
    });
    await workflowsApi.diffVersions('w1', 'v1', 'published');
    expect(last(r)).toMatchObject({
      method: 'GET',
      path: '/workflows/w1/versions/v1/diff',
      query: { against: 'published' },
    });
    await workflowsApi.importFromUrl('https://example.com/wf.json?token=secret');
    expect(last(r)).toEqual({
      method: 'POST',
      path: '/workflows/from-url',
      query: undefined,
      body: { url: 'https://example.com/wf.json?token=secret' },
    });
    await workflowsApi.publishTimeline('w1', { skip: 20, take: 20 });
    expect(last(r)).toMatchObject({
      method: 'GET',
      path: '/workflows/w1/publish-timeline',
      query: { skip: 20, take: 20 },
    });
    await workflowsApi.run('w1', { destinationNode: 'C', runData: {}, dirtyNodeNames: ['B'] });
    expect(last(r).body).toMatchObject({ destinationNode: 'C', dirtyNodeNames: ['B'] });

    await foldersApi.list({ parentFolderId: 'root', tags: ['a', 'b'] });
    expect(last(r)).toMatchObject({
      method: 'GET',
      path: '/folders',
      query: { parentFolderId: 'root', tags: 'a,b' },
    });
    await foldersApi.get('f1');
    expect(last(r)).toMatchObject({ method: 'GET', path: '/folders/f1' });
    await foldersApi.create({ name: 'F', parentFolderId: null });
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/folders',
      body: { name: 'F', parentFolderId: null },
    });
    await foldersApi.update('f1', { name: 'G', tagIds: ['t'] });
    expect(last(r)).toMatchObject({
      method: 'PATCH',
      path: '/folders/f1',
      body: { name: 'G', tagIds: ['t'] },
    });
    await foldersApi.remove('f1', 'root');
    expect(last(r)).toMatchObject({
      method: 'DELETE',
      path: '/folders/f1',
      body: { transferToFolderId: 'root' },
    });
    await foldersApi.remove('f1');
    expect(last(r).body).toEqual({});

    await favoritesApi.list();
    expect(last(r)).toMatchObject({ method: 'GET', path: '/favorites' });
    await favoritesApi.add('folder', 'f1');
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/favorites',
      body: { resourceType: 'folder', resourceId: 'f1' },
    });
    await favoritesApi.remove('workflow', 'w1');
    expect(last(r)).toMatchObject({ method: 'DELETE', path: '/favorites/workflow/w1' });

    await annotationTagsApi.list({ withUsageCount: true });
    expect(last(r)).toMatchObject({
      method: 'GET',
      path: '/annotation-tags',
      query: { withUsageCount: true },
    });
    await annotationTagsApi.create('bug');
    expect(last(r)).toMatchObject({ method: 'POST', path: '/annotation-tags', body: { name: 'bug' } });
    await annotationTagsApi.update('t1', 'ok');
    expect(last(r)).toMatchObject({ method: 'PATCH', path: '/annotation-tags/t1', body: { name: 'ok' } });
    await annotationTagsApi.remove('t1');
    expect(last(r)).toMatchObject({ method: 'DELETE', path: '/annotation-tags/t1' });
    await executionsApi.annotate('e1', { tags: ['t1'], vote: null });
    expect(last(r)).toMatchObject({
      method: 'PATCH',
      path: '/executions/e1',
      body: { tags: ['t1'], vote: null },
    });
    await executionsApi.list({ annotationTags: ['t1', 't2'], vote: 'down', workflowVersionId: 'v1' });
    expect(last(r)).toMatchObject({
      path: '/executions',
      query: { annotationTags: 't1,t2', vote: 'down', workflowVersionId: 'v1' },
    });

    await reviewsApi.list({ workflowId: 'w1', state: 'open' });
    expect(last(r)).toMatchObject({
      method: 'GET',
      path: '/workflow-reviews',
      query: { workflowId: 'w1', state: 'open' },
    });
    await reviewsApi.eligibleReviewers('w1');
    expect(last(r)).toMatchObject({
      path: '/workflow-reviews/eligible-reviewers',
      query: { workflowId: 'w1' },
    });
    await reviewsApi.create({ workflowId: 'w1', versionName: 'V', title: 'T', reviewerUserIds: ['u2'] });
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/workflow-reviews',
      body: { reviewerUserIds: ['u2'] },
    });
    await reviewsApi.updateVersion('r1', { versionName: 'V2' });
    expect(last(r)).toMatchObject({ method: 'POST', path: '/workflow-reviews/r1/update-version' });
    await reviewsApi.decide('r1', { decision: 'changes_requested', note: 'Fix it' });
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/workflow-reviews/r1/decision',
      body: { decision: 'changes_requested', note: 'Fix it' },
    });
    await reviewsApi.activity('r1', 'c1');
    expect(last(r)).toMatchObject({
      method: 'GET',
      path: '/workflow-reviews/r1/activity',
      query: { cursor: 'c1' },
    });
    await reviewsApi.comment('r1', 'Looks good');
    expect(last(r)).toMatchObject({
      method: 'POST',
      path: '/workflow-reviews/r1/comments',
      body: { body: 'Looks good' },
    });
    await reviewsApi.get('r1');
    expect(last(r)).toMatchObject({ method: 'GET', path: '/workflow-reviews/r1' });
    await inboxApi.list({ tab: 'mine' });
    expect(last(r)).toMatchObject({ method: 'GET', path: '/inbox', query: { tab: 'mine' } });
    await inboxApi.summary();
    expect(last(r)).toMatchObject({ method: 'GET', path: '/inbox/summary' });
    await settingsApi.update({ workflowReviews: { enabled: true } });
    expect(last(r)).toMatchObject({
      method: 'PATCH',
      path: '/settings',
      body: { workflowReviews: { enabled: true } },
    });
  });

  it('binaryDataUrl and fetchBinaryData', async () => {
    expect(
      binaryDataUrl({ data: '', id: 'fs:t/e/1', mimeType: 'image/png', fileName: 'a.png' }, 'download'),
    ).toBe(
      `${window.location.origin}/rest/binary-data?id=fs%3At%2Fe%2F1&action=download&mimeType=image%2Fpng&fileName=a.png`,
    );
    expect(binaryDataUrl({ data: 'aGk=', mimeType: 'text/plain' })).toBeNull();
    const inline = await fetchBinaryData({ data: btoa('hello'), mimeType: 'text/plain' });
    expect(inline.type).toBe('text/plain');
    expect(await inline.text()).toBe('hello');
    const typed = await fetchBinaryData(
      { data: btoa('%PDF-'), mimeType: 'application/octet-stream' },
      { type: 'application/pdf' },
    );
    expect(typed.type).toBe('application/pdf');
    signedIn();
    await expect(fetchBinaryData({ data: '', id: 'fs:x', mimeType: 'image/png' })).rejects.toMatchObject({
      status: 404,
      message: 'Could not load the binary data',
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('demo backend', () => {
  const call = (method: string, path: string, body?: unknown, query?: Record<string, string>) =>
    backend().handle({ method: method as 'GET', path, body, query });

  it('answers every new route (no 404 "No route")', async () => {
    const wf = seed();
    const routes: Array<[string, string]> = [
      ['GET', '/folders'],
      ['GET', '/folders/f1'],
      ['POST', '/folders'],
      ['PATCH', '/folders/f1'],
      ['DELETE', '/folders/f1'],
      ['GET', '/favorites'],
      ['POST', '/favorites'],
      ['DELETE', '/favorites/workflow/w1'],
      ['POST', '/workflows/move'],
      ['POST', `/workflows/${wf.id}/archive`],
      ['POST', `/workflows/${wf.id}/unarchive`],
      ['GET', '/annotation-tags'],
      ['POST', '/annotation-tags'],
      ['PATCH', '/annotation-tags/t1'],
      ['DELETE', '/annotation-tags/t1'],
      ['PATCH', '/executions/e1'],
      ['PATCH', `/workflows/${wf.id}/versions/${wf.versionId}`],
      ['GET', `/workflows/${wf.id}/publish-timeline`],
      ['GET', `/workflows/${wf.id}/versions/${wf.versionId}/diff`],
      ['POST', '/workflows/from-url'],
      ['GET', '/workflow-reviews'],
      ['GET', '/workflow-reviews/eligible-reviewers'],
      ['POST', '/workflow-reviews'],
      ['GET', '/workflow-reviews/r1'],
      ['POST', '/workflow-reviews/r1/update-version'],
      ['POST', '/workflow-reviews/r1/decision'],
      ['GET', '/workflow-reviews/r1/activity'],
      ['POST', '/workflow-reviews/r1/comments'],
      ['GET', '/inbox'],
      ['GET', '/inbox/summary'],
      ['PATCH', '/settings'],
    ];
    for (const [method, path] of routes) {
      const response = await call(method, path, {});
      const code = (response.body as { error?: { message?: string } } | null)?.error?.message ?? '';
      expect(code.startsWith('No route'), `${method} ${path}`).toBe(false);
    }
  });

  it('stores the new workflow fields; publishing keeps the pointer and the timeline', async () => {
    signedIn();
    const active = backend().seedWorkflow({ name: 'Live', active: true, nodes: [], nodeGroups: [GROUP] });
    expect(active.publishedVersionId).toBe(active.versionId);
    expect(active).toMatchObject({ nodeGroups: [GROUP], folderId: null, isArchived: false });
    const list = await call('GET', '/workflows');
    expect((list.body as { data: unknown[] }).data[0]).toMatchObject({
      isArchived: false,
      folderId: null,
      publishedVersionId: active.versionId,
    });

    const wf = backend().seedWorkflow({
      name: 'Hook',
      nodes: [{ ...node('h', 'Hook', 'core.webhook', 0), parameters: { path: 'x' } }],
    });
    const on = await call('POST', `/workflows/${wf.id}/activate`, {});
    expect(on.status).toBe(200);
    expect((on.body as { data: { publishedVersionId: string } }).data.publishedVersionId).toBe(wf.versionId);
    await call('POST', `/workflows/${wf.id}/deactivate`, {});
    const timeline = await call('GET', `/workflows/${wf.id}/publish-timeline`, undefined, { take: '10' });
    const entries = (timeline.body as { data: Array<{ event: string; versionId: string; userName: string }> })
      .data;
    expect(entries.map((e) => e.event)).toEqual(['deactivated', 'activated']);
    expect(entries[1]).toMatchObject({ versionId: wf.versionId, userName: 'Olive Owner' });
  });

  it('from-url answers fixtures and n8n messages; the URL never reaches a fetch', async () => {
    signedIn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const url = 'https://example.com/flow.json';
    backend().setUrlFixture(url, { name: 'From URL', nodes: [], connections: {} });
    const ok = await call('POST', '/workflows/from-url', { url });
    expect((ok.body as { data: { name: string } }).data.name).toBe('From URL');
    const missing = await call('POST', '/workflows/from-url', { url: 'https://example.com/other.json' });
    expect(missing).toMatchObject({
      status: 400,
      body: { error: { message: 'The URL does not point to valid JSON file!' } },
    });
    backend().setUrlFixture('https://example.com/bad.json', { hello: 1 });
    const bad = await call('POST', '/workflows/from-url', { url: 'https://example.com/bad.json' });
    expect(bad.body).toMatchObject({
      error: { message: 'The data in the file does not seem to be a workflow JSON file!' },
    });
    expect((await call('POST', '/workflows/from-url', { url: 'ftp://x' })).status).toBe(400);
    backend().setDemoRole('viewer');
    expect((await call('POST', '/workflows/from-url', { url })).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('settings, command-bar search, diff and the version filter', async () => {
    const wf = seed();
    const settings = await call('GET', '/settings');
    expect((settings.body as { data: object }).data).toMatchObject({
      autosaveEnabled: true,
      workflowReviews: { enabled: false },
    });
    expect((await call('PATCH', '/settings', { workflowReviews: { enabled: true } })).status).toBe(200);
    expect(((await call('GET', '/settings')).body as { data: object }).data).toMatchObject({
      workflowReviews: { enabled: true },
    });

    backend().tags.push({ id: 'tg', name: 'billing', tenantId: backend().session!.tenantId });
    backend().seedWorkflow({ name: 'Tagged', nodes: [], tags: [{ id: 'tg', name: 'billing' }] });
    const names = async (query: Record<string, string>) =>
      (
        (await call('GET', '/workflows', undefined, query)).body as { data: Array<{ name: string }> }
      ).data.map((w) => w.name);
    expect(await names({ search: 'zzz', nodeTypes: 'core.set' })).toEqual(['Grouped']);
    expect(await names({ search: 'bill' })).toEqual([]);
    expect(await names({ search: 'bill', matchTags: 'true' })).toEqual(['Tagged']);

    const diff = await call('GET', `/workflows/${wf.id}/versions/${wf.versionId}/diff`, undefined, {
      against: 'current',
    });
    expect((diff.body as { data: object }).data).toMatchObject({ from: wf.versionId, to: 'current' });
    expect(
      (
        await call('GET', `/workflows/${wf.id}/versions/${wf.versionId}/diff`, undefined, {
          against: 'published',
        })
      ).status,
    ).toBe(404);
  });

  it('/run passes runData and dirtyNodeNames to the simulator and records the version', async () => {
    const wf = seed();
    const simulate = vi.spyOn(backend(), 'simulate');
    const runData = runDataFor('Start', [{ a: 1 }]);
    const started = await call('POST', `/workflows/${wf.id}/run`, {
      destinationNode: 'Other',
      runData,
      dirtyNodeNames: ['Shape'],
    });
    const { executionId } = (started.body as { data: { executionId: string } }).data;
    await waitFor(() =>
      expect(simulate).toHaveBeenCalledWith(
        expect.objectContaining({ executionId, runData, dirtyNodeNames: ['Shape'] }),
      ),
    );
    const list = await call('GET', '/executions', undefined, { workflowVersionId: wf.versionId });
    expect(
      (list.body as { data: Array<{ id: string; workflowVersionId: string; annotation: null }> }).data[0],
    ).toMatchObject({
      id: executionId,
      workflowVersionId: wf.versionId,
      annotation: null,
    });
    const none = await call('GET', '/executions', undefined, { workflowVersionId: 'other' });
    expect((none.body as { data: unknown[] }).data).toEqual([]);
  });

  it('the demo seed has a workflow with a group', () => {
    expect(demoGroupedWorkflow.nodeGroups?.[0].nodeIds).toEqual(['g-2', 'g-3']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('moved commands behave as before', () => {
  it('addStickyAt places a 260x160 note around the point and selects it', () => {
    useWorkflowStore.getState().load({ name: 'W' });
    const id = addStickyAt({ screenToFlowPosition: () => ({ x: 500, y: 300 }) })!;
    expect(useWorkflowStore.getState().stickyNotes[0]).toMatchObject({
      id,
      position: [380, 220],
      width: 260,
      height: 160,
      content: '## Note\nDescribe what this part of the workflow does.',
    });
    expect(useWorkflowStore.getState().selection.stickies).toEqual([id]);
    addStickyAt({ screenToFlowPosition: () => ({ x: 0, y: 0 }) }, [100, 100]);
    expect(useWorkflowStore.getState().stickyNotes[1].position).toEqual([-20, 20]);
  });

  it('duplicateWorkflow saves a copy with fresh webhook ids and opens it', async () => {
    signedIn();
    const wf = backend().seedWorkflow({
      name: 'Hooked',
      nodes: [{ ...node('h', 'Hook', 'core.webhook', 0), webhookId: 'hook-1' }],
    });
    useWorkflowStore.getState().load(wf);
    const navigate = vi.fn();
    const copy = await duplicateWorkflow({ navigate });
    expect(copy?.name).toBe('Hooked copy');
    expect(navigate).toHaveBeenCalledWith(`/workflow/${copy!.id}`);
    expect(copy!.nodes[0].webhookId).not.toBe('hook-1');
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ title: 'Workflow duplicated' });
  });

  it('downloadWorkflow saves the canvas as JSON', async () => {
    const created = vi.spyOn(URL, 'createObjectURL');
    useWorkflowStore.getState().load({ name: 'My flow', nodes: [node('a', 'A', 'core.set', 0)] });
    downloadWorkflow();
    const blob = created.mock.calls[0][0] as Blob;
    const json = JSON.parse(await blob.text());
    expect(json).toMatchObject({ name: 'My flow', nodes: [{ name: 'A' }], connections: {} });
    expect(json).not.toHaveProperty('nodeGroups');
    created.mockRestore();
  });

  it('copy and cut keep the clipboard and the toast', () => {
    useWorkflowStore
      .getState()
      .load({ name: 'W', nodes: [node('a', 'A', 'core.set', 0), node('b', 'B', 'core.set', 0)] });
    useWorkflowStore.getState().select({ nodes: ['A', 'B'] });
    expect(copySelectionToClipboard()).toBe(2);
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Copied 2 items');
    expect(JSON.parse(readMemoryClipboard()).nodes).toHaveLength(2);
    useWorkflowStore.getState().select({ nodes: ['A'] });
    expect(cutSelection()).toBe(1);
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['B']);
    useWorkflowStore.getState().select({ nodes: [] });
    expect(copySelectionToClipboard()).toBe(0);
  });

  it('canPin follows the n8n rules', () => {
    const set = describeOf('core.set');
    const runData = runDataFor('S', [{ a: 1 }]);
    expect(canPin(node('s', 'S', 'core.set', 0), set, runData)).toBe(true);
    expect(canPin(node('s', 'S', 'core.set', 0), set, {})).toBe(false);
    expect(
      canPin(node('s', 'S', 'core.splitInBatches', 0), { ...set, name: 'core.splitInBatches' }, runData),
    ).toBe(false);
    expect(canPin(node('s', 'S', 'core.if', 0), describeOf('core.if'), runData)).toBe(false);
    expect(canPin(node('s', 'S', 'ai.lmChatDemo', 0), describeOf('ai.lmChatDemo'), runData)).toBe(false);
    expect(canPin(node('s', 'S', 'core.set', 0), undefined, runData)).toBe(false);
  });

  it('execution commands retry, stop, delete and debug with the page toasts', async () => {
    const wf = seed();
    const started = await workflowsApi.run(wf.id, {});
    await waitFor(() => expect(backend().executions[0].status).not.toBe('running'));
    backend().executions[0].status = 'error';
    const navigate = vi.fn();
    const queryClient = testQueryClient();
    const retryId = await retryExecution(started.executionId, true, { navigate, queryClient });
    expect(retryId).toBeTruthy();
    expect(navigate).toHaveBeenLastCalledWith(`/executions/${retryId}`);
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Retry started');

    expect(await stopExecution(started.executionId)).toBe(true);
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Execution stopped');

    expect(await deleteExecution(started.executionId, { navigate })).toBe(true);
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete this execution?' }));
    expect(navigate).toHaveBeenLastCalledWith('/executions');
    expect(backend().executions.some((e) => e.id === started.executionId)).toBe(false);

    expect(await retryExecution('missing', false)).toBeNull();
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Could not retry the execution');

    debugExecution('w 1', 'e 1', { navigate });
    expect(navigate).toHaveBeenLastCalledWith('/workflow/w%201?debug=e%201');
  });

  it('addNodeFromDescription extends the selected chain, selects the node and opens it', () => {
    useWorkflowStore.getState().load({ name: 'W', nodes: [node('a', 'Start', 'core.manualTrigger', 0)] });
    useWorkflowStore.getState().select({ nodes: ['Start'] });
    const flow = { screenToFlowPosition: () => ({ x: 0, y: 0 }) };
    const name = addNodeFromDescription(describeOf('core.set'), { flow, descriptions })!;
    const s = useWorkflowStore.getState();
    expect(s.nodes.find((n) => n.name === name)?.position).toEqual([300, 0]);
    expect(s.connections.Start?.main?.[0]).toEqual([{ node: name, type: 'main', index: 0 }]);
    expect(s.selection.nodes).toEqual([name]);
    expect(useUiStore.getState().ndvNode).toBe(name);
  });

  it('addNodeFromDescription replaces ui.replaceTarget through lib/replace-node as one undo step', () => {
    useWorkflowStore.getState().load({ name: 'W', nodes: [node('a', 'Old', 'core.set', 40)] });
    useUiStore.getState().openCreator();
    useUiStore.getState().setReplaceTarget('Old');
    const flow = { screenToFlowPosition: () => ({ x: 0, y: 0 }) };
    vi.mocked(replaceNode).mockReturnValueOnce({ error: 'The group would break' });
    expect(addNodeFromDescription(describeOf('core.code'), { flow, descriptions })).toBeNull();
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'error',
      description: 'The group would break',
    });
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Old']);

    vi.mocked(replaceNode).mockImplementationOnce((graph, _old, replacement) => ({
      graph: { ...graph, nodes: [{ ...replacement, name: 'Code' }] },
      nodeName: 'Code',
    }));
    const past = useWorkflowStore.getState().past.length;
    expect(addNodeFromDescription(describeOf('core.code'), { flow, descriptions })).toBe('Code');
    expect(replaceNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodes: expect.any(Array) }),
      'Old',
      expect.objectContaining({ type: 'core.code', position: [40, 0] }),
      descriptions,
      undefined,
    );
    expect(useWorkflowStore.getState().past).toHaveLength(past + 1);
    expect(useWorkflowStore.getState().selection.nodes).toEqual(['Code']);
    expect(useUiStore.getState()).toMatchObject({ replaceTarget: null, sidePanel: null });
  });

  it('a toast action renders as a button that runs it and closes the toast', async () => {
    const user = userEvent.setup();
    withProviders(<div />);
    const onClick = vi.fn();
    act(() => void toast.error('Blocked', undefined, { label: 'Ungroup', onClick }));
    await user.click(await screen.findByRole('button', { name: 'Ungroup' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
