/**
 * P3-04 canvas groups in the editor (L4): Ctrl+G with the inline title rename, the title bar
 * (rename, Ungroup, right-click menu), the blocked-edit toast with its Ungroup action, auto-extend,
 * delete and copy/paste, and save -> reload -> moveGroup with one undo step.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode, WorkflowNodeGroup } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { saveWorkflow } from '../src/features/editor/editor-actions';
import { setGroupsExpanded } from '../src/lib/group-view';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { toWorkflowBody, useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const node = (id: string, name: string, type: string, x: number, y = 0): WorkflowNode => ({
  id,
  name,
  type,
  typeVersion: 1,
  position: [x, y],
  parameters: {},
});

const main = (target: string) => [[{ node: target, type: 'main' as const, index: 0 }]];

/** Start -> Shape -> Clean -> Send, Spare loose; group "Group" = Shape, Clean */
function seed(nodeGroups: WorkflowNodeGroup[] = [{ id: 'grp1', name: 'Group', nodeIds: ['n2', 'n3'] }]) {
  signedIn();
  return backend().seedWorkflow({
    name: 'Grouped',
    nodes: [
      node('n1', 'Start', 'core.manualTrigger', 0),
      node('n2', 'Shape', 'core.set', 300),
      node('n3', 'Clean', 'core.set', 600),
      node('n4', 'Send', 'core.noOp', 900),
      node('n5', 'Spare', 'core.noOp', 300, 500),
    ],
    connections: {
      Start: { main: main('Shape') },
      Shape: { main: main('Clean') },
      Clean: { main: main('Send') },
    },
    nodeGroups,
  });
}

async function openEditor(id: string) {
  const utils = renderApp(`/workflow/${id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(document.querySelector('[data-id="n2"]')).toBeTruthy());
  await waitFor(() => expect(useWorkflowStore.getState().nodeTypeLookup).toBeDefined());
  return utils;
}

const store = () => useWorkflowStore.getState();
const select = (nodes: string[]) => act(() => store().select({ nodes, stickies: [], edges: [] }));
const ref = (source: string, target: string) => ({
  source,
  sourceType: 'main' as const,
  sourceIndex: 0,
  target,
  targetType: 'main' as const,
  targetIndex: 0,
});
const deps = () => ({ navigate: () => undefined, descriptions: { get: () => undefined } });

beforeEach(() => {
  window.localStorage.clear();
  store().reset();
  useToastStore.setState({ toasts: [] });
  useUiStore.setState({ contextMenu: null });
});

describe('canvas groups in the editor', () => {
  it('Ctrl+G groups the selection as "Group 2", expands it and opens the title for a rename', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    select(['Send', 'Spare']);
    expect(store().selection.nodes).toEqual(['Send', 'Spare']);
    // Send and Spare are not connected: refused with the rule text
    act(() => void fireEvent.keyDown(window, { key: 'g', code: 'KeyG', ctrlKey: true }));
    expect(store().nodeGroups).toHaveLength(1);
    expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Could not group these nodes');

    select(['Send']);
    act(() => void fireEvent.keyDown(window, { key: 'g', code: 'KeyG', ctrlKey: true }));
    const created = store().nodeGroups[1];
    expect(created).toMatchObject({ name: 'Group 2', nodeIds: ['n4'] });

    const input = await screen.findByRole('textbox', { name: 'Group name' });
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('button', { name: 'Collapse group Group 2' })).toBeTruthy();
    await user.clear(input);
    await user.type(input, 'Deliver{Enter}');
    expect(store().nodeGroups[1].name).toBe('Deliver');
    expect(screen.queryByRole('textbox', { name: 'Group name' })).toBeNull();
  });

  it('renames on double-click, keeps names unique, and Escape cancels', async () => {
    const user = userEvent.setup();
    const wf = seed([
      { id: 'grp1', name: 'Group', nodeIds: ['n2', 'n3'] },
      { id: 'grp2', name: 'Last', nodeIds: ['n4'] },
    ]);
    await openEditor(wf.id);
    // fireEvent: a user-event double-click starts a d3-drag on the title, which jsdom cannot run
    fireEvent.doubleClick(screen.getByText('Group', { selector: '[data-group-name]' }));
    const input = screen.getByRole('textbox', { name: 'Group name' });
    await user.clear(input);
    await user.type(input, 'Last{Enter}');
    expect(store().nodeGroups[0].name).toBe('Last 2');

    fireEvent.doubleClick(screen.getByText('Last 2', { selector: '[data-group-name]' }));
    await user.type(screen.getByRole('textbox', { name: 'Group name' }), 'zzz{Escape}');
    expect(store().nodeGroups[0].name).toBe('Last 2');
  });

  it('right-click on the title selects the members and opens the group menu; Ungroup is one undo step', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    fireEvent.contextMenu(document.querySelector('[data-id="group:grp1"] .wf-group-drag')!, {
      clientX: 30,
      clientY: 40,
    });
    expect(useUiStore.getState().contextMenu).toEqual({
      x: 30,
      y: 40,
      target: { type: 'group', groupId: 'grp1' },
    });
    expect(store().selection.nodes).toEqual(['Shape', 'Clean']);

    await user.click(screen.getByRole('button', { name: 'Ungroup Group' }));
    expect(store().nodeGroups).toEqual([]);
    await waitFor(() => expect(document.querySelector('[data-id="group:grp1"]')).toBeNull());
    act(() => store().undo());
    expect(store().nodeGroups.map((g) => g.id)).toEqual(['grp1']);
  });

  it('blocks a crossing edit with the reason and an Ungroup action', async () => {
    const wf = seed();
    await openEditor(wf.id);
    // Spare is fed by Start, so it cannot join: Shape would get a second exit
    act(() => store().connect(ref('Start', 'Spare')));
    act(() => store().connect(ref('Shape', 'Spare')));
    expect(store().connections.Shape?.main?.[0]).toHaveLength(1);
    const shown = useToastStore.getState().toasts.at(-1)!;
    expect(shown).toMatchObject({
      kind: 'error',
      title: '"Group" can send output from one node only. Ungroup it to make this change.',
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(shown.title);
    fireEvent.click(within(alert).getByRole('button', { name: 'Ungroup' }));
    expect(store().nodeGroups).toEqual([]);
  });

  it('auto-extends the group when a new branch leaves it, with an info toast', async () => {
    const wf = seed();
    await openEditor(wf.id);
    act(() => store().connect(ref('Shape', 'Spare')));
    expect(store().nodeGroups[0].nodeIds).toEqual(['n2', 'n3', 'n5']);
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ kind: 'info', title: "'Group' extended" });
  });

  it('delete shrinks the group; copy and paste of every member brings a second group', async () => {
    const wf = seed();
    await openEditor(wf.id);
    select(['Shape', 'Clean']);
    let pasted: string[] = [];
    act(() => {
      pasted = store().duplicateSelection();
    });
    expect(store().nodeGroups.map((g) => g.name)).toEqual(['Group', 'Group 2']);
    const copyIds = store()
      .nodes.filter((n) => pasted.includes(n.name))
      .map((n) => n.id);
    expect(store().nodeGroups[1].nodeIds).toEqual(copyIds);

    select(['Clean']);
    act(() => store().deleteSelection());
    expect(store().nodeGroups[0].nodeIds).toEqual(['n2']);
  });

  it('save -> reload -> moveGroup moves every member as one undo step; the save body keeps the group', async () => {
    const wf = seed();
    const first = await openEditor(wf.id);
    act(() => store().renameGroup('grp1', 'Prepare'));
    await act(async () => void (await saveWorkflow(deps())));
    expect(backend().workflow(wf.id).nodeGroups).toEqual([
      { id: 'grp1', name: 'Prepare', nodeIds: ['n2', 'n3'] },
    ]);
    first.unmount();

    await openEditor(wf.id);
    expect(store().nodeGroups[0].name).toBe('Prepare');
    act(() => setGroupsExpanded(['grp1'], true));
    expect(await screen.findByRole('button', { name: 'Collapse group Prepare' })).toBeTruthy();

    const past = store().past.length;
    act(() => {
      store().checkpoint();
      store().moveGroup('grp1', 40, 20, { history: false });
      store().moveGroup('grp1', 10, 5, { history: false });
    });
    expect(store().past).toHaveLength(past + 1);
    const body = toWorkflowBody(store());
    expect(body.nodes.find((n) => n.id === 'n2')?.position).toEqual([350, 25]);
    expect(body.nodes.find((n) => n.id === 'n3')?.position).toEqual([650, 25]);
    expect(body.nodes.find((n) => n.id === 'n4')?.position).toEqual([900, 0]);
    expect(body.nodeGroups).toEqual([{ id: 'grp1', name: 'Prepare', nodeIds: ['n2', 'n3'] }]);
    act(() => store().undo());
    expect(store().nodes.find((n) => n.id === 'n2')?.position).toEqual([300, 0]);
  });
});
