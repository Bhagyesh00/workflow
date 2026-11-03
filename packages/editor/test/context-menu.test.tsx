/**
 * P3-02 in the editor: the right-click menu on a node, a selection, a group title, a sticky note and the
 * canvas; each entry's store effect, read-only, the webhook URL entries, the Convert / Group rules, and
 * closing on Escape, outside click, wheel and resize; arrow keys; the rename dialog; F2.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode, WorkflowNodeGroup } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyNodeWebhookUrl } from '../src/features/editor/webhook-urls';
import { type ContextMenuTarget, useToastStore, useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const node = (id: string, name: string, type: string, x: number, extra: Partial<WorkflowNode> = {}) => ({
  id,
  name,
  type,
  typeVersion: 1,
  position: [x, 0] as [number, number],
  parameters: {},
  ...extra,
});
const main = (target: string) => [[{ node: target, type: 'main' as const, index: 0 }]];

function seed(over: { nodeGroups?: WorkflowNodeGroup[]; hook?: boolean } = {}) {
  signedIn();
  return backend().seedWorkflow({
    name: 'Menu',
    nodes: [
      over.hook
        ? node('n1', 'Hook', 'core.webhook', 0, { webhookId: 'hook-1', parameters: { path: 'hook-1' } })
        : node('n1', 'Start', 'core.manualTrigger', 0),
      node('n2', 'Shape', 'core.set', 300),
      node('n3', 'Clean', 'core.set', 600),
      node('n4', 'Send', 'core.noOp', 900),
    ],
    connections: {
      [over.hook ? 'Hook' : 'Start']: { main: main('Shape') },
      Shape: { main: main('Clean') },
      Clean: { main: main('Send') },
    },
    stickyNotes: [{ id: 'st1', content: 'Remember', position: [0, 200], width: 200, height: 100 }],
    nodeGroups: over.nodeGroups ?? [],
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
const select = (nodes: string[], stickies: string[] = []) =>
  act(() => store().select({ nodes, stickies, edges: [] }));
const openMenu = (target: ContextMenuTarget) =>
  act(() => useUiStore.getState().openContextMenu({ x: 120, y: 90, target }));
const menu = () => screen.getByRole('menu', { name: 'Canvas actions' });
const item = (name: string) => within(menu()).getByRole('menuitem', { name: new RegExp(`^${name}(\\s|$)`) });
const queryItem = (name: string) =>
  within(menu()).queryByRole('menuitem', { name: new RegExp(`^${name}(\\s|$)`) });
const node2 = (name: string) => store().nodes.find((n) => n.name === name);

describe('context menu (P3-02)', () => {
  beforeEach(() => {
    useUiStore.setState({
      contextMenu: null,
      renameTarget: null,
      convertOpen: false,
      stickyAction: null,
      ndvNode: null,
      sidePanel: null,
      creatorContext: {},
    });
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a right-click on a node opens the node menu and selects the node', async () => {
    const wf = seed();
    await openEditor(wf.id);
    const el = document.querySelector('[data-id="n3"]') as HTMLElement;
    fireEvent.contextMenu(el, { clientX: 200, clientY: 150 });
    await screen.findByRole('menu', { name: 'Canvas actions' });
    expect(store().selection.nodes).toEqual(['Clean']);
    expect(
      ['Open', 'Test step', 'Rename', 'Deactivate', 'Copy', 'Duplicate', 'Delete'].every((n) => queryItem(n)),
    ).toBe(true);
  });

  it('Open, Rename, Deactivate and Duplicate and Delete change the store', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);

    openMenu({ type: 'node', nodeName: 'Shape' });
    await user.click(item('Open'));
    expect(useUiStore.getState().ndvNode).toBe('Shape');
    act(() => useUiStore.getState().openNdv(null));
    expect(screen.queryByRole('menu')).toBeNull();

    openMenu({ type: 'node', nodeName: 'Shape' });
    await user.click(item('Deactivate'));
    expect(node2('Shape')?.disabled).toBe(true);
    openMenu({ type: 'node', nodeName: 'Shape' });
    expect(queryItem('Activate')).toBeTruthy();
    await user.click(item('Activate'));
    expect(node2('Shape')?.disabled).toBeFalsy();

    openMenu({ type: 'node', nodeName: 'Shape' });
    await user.click(item('Duplicate'));
    expect(store().nodes).toHaveLength(5);

    openMenu({ type: 'node', nodeName: 'Send' });
    await user.click(item('Delete'));
    expect(node2('Send')).toBeUndefined();
  });

  it('Rename opens the dialog and renames; a duplicate name shows the error and keeps the node', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    openMenu({ type: 'node', nodeName: 'Shape' });
    await user.click(item('Rename'));
    const dialog = await screen.findByRole('dialog', { name: 'Rename node' });
    const input = within(dialog).getByLabelText('Node name');
    await user.clear(input);
    await user.type(input, 'Clean{Enter}');
    expect(within(dialog).getByRole('alert').textContent).toMatch(/already exists/);
    expect(node2('Shape')).toBeTruthy();
    await user.clear(input);
    await user.type(input, 'Reshape{Enter}');
    await waitFor(() => expect(node2('Reshape')).toBeTruthy());
    expect(node2('Shape')).toBeUndefined();
    expect(screen.queryByRole('dialog', { name: 'Rename node' })).toBeNull();
  });

  it('F2 opens the rename dialog for the selected node', async () => {
    const wf = seed();
    await openEditor(wf.id);
    select(['Shape']);
    fireEvent.keyDown(window, { key: 'F2', code: 'F2' });
    await screen.findByRole('dialog', { name: 'Rename node' });
  });

  it('Pin is disabled without output data; Select all and Deselect all change the selection', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    openMenu({ type: 'node', nodeName: 'Shape' });
    expect(item('Pin').hasAttribute('disabled')).toBe(true);
    await user.click(item('Select all'));
    expect(store().selection.nodes).toHaveLength(4);
    openMenu({ type: 'node', nodeName: 'Shape' });
    await user.click(item('Deselect all'));
    expect(store().selection.nodes).toHaveLength(0);
  });

  it('a multi-selection menu acts on every selected node', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    select(['Shape', 'Clean']);
    openMenu({ type: 'selection' });
    expect(queryItem('Open')).toBeNull();
    expect(queryItem('Rename')).toBeNull();
    await user.click(item('Deactivate nodes'));
    expect(node2('Shape')?.disabled).toBe(true);
    expect(node2('Clean')?.disabled).toBe(true);
    openMenu({ type: 'selection' });
    await user.click(item('Delete nodes'));
    expect(node2('Shape')).toBeUndefined();
    expect(node2('Clean')).toBeUndefined();
  });

  it('Group nodes calls the group command; Convert opens the convert dialog state', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    const group = vi.spyOn(store(), 'groupSelection').mockReturnValue(null);
    select(['Shape', 'Clean']);
    openMenu({ type: 'selection' });
    await user.click(item('Group nodes'));
    expect(group).toHaveBeenCalledTimes(1);
    openMenu({ type: 'selection' });
    await user.click(item('Convert to sub-workflow'));
    expect(useUiStore.getState().convertOpen).toBe(true);
  });

  it('Group is disabled with a reason and Convert is hidden when the selection cannot be used', async () => {
    const wf = seed();
    await openEditor(wf.id);
    select(['Start', 'Shape']);
    openMenu({ type: 'selection' });
    expect(item('Group nodes').hasAttribute('disabled')).toBe(true);
    expect(item('Group nodes').getAttribute('title')).toBeTruthy();
    expect(queryItem('Convert to sub-workflow')).toBeNull();
  });

  it('a group title menu: Rename group (dialog) and Ungroup', async () => {
    const user = userEvent.setup();
    const wf = seed({ nodeGroups: [{ id: 'grp1', name: 'Group', nodeIds: ['n2', 'n3'] }] });
    await openEditor(wf.id);
    const rename = vi.spyOn(store(), 'renameGroup').mockImplementation(() => undefined);
    const ungroup = vi.spyOn(store(), 'ungroup').mockImplementation(() => undefined);
    openMenu({ type: 'group', groupId: 'grp1' });
    await waitFor(() => expect(store().selection.nodes.sort()).toEqual(['Clean', 'Shape']));
    const names = within(menu())
      .getAllByRole('menuitem')
      .map((e) => e.textContent ?? '');
    expect(names[0]).toMatch(/^Rename group/);
    expect(names[1]).toMatch(/^Ungroup/);
    expect(names.some((n) => n.startsWith('Tidy up selection'))).toBe(true);
    await user.click(item('Rename group'));
    const dialog = await screen.findByRole('dialog', { name: 'Rename group' });
    const input = within(dialog).getByLabelText('Group name');
    await user.clear(input);
    await user.type(input, 'Cleanup{Enter}');
    expect(rename).toHaveBeenCalledWith('grp1', 'Cleanup');
    openMenu({ type: 'group', groupId: 'grp1' });
    await user.click(item('Ungroup'));
    expect(ungroup).toHaveBeenCalledWith('grp1');
  });

  it('a sticky menu edits the note and recolours it', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    openMenu({ type: 'sticky', stickyId: 'st1' });
    expect(
      ['Edit sticky note', 'Change color', 'Duplicate', 'Delete', 'Select all', 'Deselect all'].every(
        queryItem,
      ),
    ).toBe(true);
    await user.click(item('Edit sticky note'));
    await screen.findByRole('textbox', { name: 'Sticky note text' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Sticky note text' }), { key: 'Escape' });

    openMenu({ type: 'sticky', stickyId: 'st1' });
    await user.click(item('Change color'));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label') ?? '').toMatch(/^Sticky colour/),
    );

    openMenu({ type: 'sticky', stickyId: 'st1' });
    await user.click(item('Duplicate'));
    expect(store().stickyNotes).toHaveLength(2);
  });

  it('the canvas menu adds a node at the click and a sticky note', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    openMenu({ type: 'canvas', position: [40, 60] });
    expect(['Add node', 'Add sticky note', 'Tidy up workflow', 'Select all'].every(queryItem)).toBe(true);
    await user.click(item('Add node'));
    expect(useUiStore.getState().sidePanel).toBe('creator');
    expect(useUiStore.getState().creatorContext.position).toEqual([40, 60]);
    openMenu({ type: 'canvas', position: [500, 400] });
    await user.click(item('Add sticky note'));
    expect(store().stickyNotes).toHaveLength(2);
  });

  it('read-only disables the write entries and keeps Copy', async () => {
    const wf = seed();
    await openEditor(wf.id);
    act(() => useWorkflowStore.setState({ readOnly: true }));
    openMenu({ type: 'node', nodeName: 'Shape' });
    for (const name of ['Rename', 'Deactivate', 'Duplicate', 'Delete'])
      expect(item(name).hasAttribute('disabled'), name).toBe(true);
    expect(item('Copy').hasAttribute('disabled')).toBe(false);
    openMenu({ type: 'canvas', position: [0, 0] });
    expect(item('Add node').hasAttribute('disabled')).toBe(true);
    expect(item('Select all').hasAttribute('disabled')).toBe(false);
  });

  it('shows the URL entries by publish state and copies the URL', async () => {
    const user = userEvent.setup();
    const wf = seed({ hook: true });
    await openEditor(wf.id);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    openMenu({ type: 'node', nodeName: 'Hook' });
    expect(queryItem('Copy test URL')).toBeTruthy();
    expect(queryItem('Copy production URL')).toBeNull();
    await user.click(item('Copy test URL'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0][0])).toMatch(/\/webhook-test\/.+\/hook-1$/);

    act(() => useWorkflowStore.setState((s) => ({ meta: { ...s.meta, active: true } })));
    openMenu({ type: 'node', nodeName: 'Hook' });
    await user.click(item('Copy production URL'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(String(writeText.mock.calls[1][0])).toMatch(/\/webhook\/.+\/hook-1$/);

    // a node without a webhook has neither entry
    openMenu({ type: 'node', nodeName: 'Shape' });
    expect(queryItem('Copy test URL')).toBeNull();
    expect(queryItem('Copy production URL')).toBeNull();
  });

  it('copyNodeWebhookUrl refuses an unsaved workflow and a node without a URL', async () => {
    const wf = seed({ hook: true });
    await openEditor(wf.id);
    expect(await copyNodeWebhookUrl('Shape', 'test')).toBe(false);
    act(() => useWorkflowStore.setState((s) => ({ meta: { ...s.meta, id: undefined } })));
    expect(await copyNodeWebhookUrl('Hook', 'test')).toBe(false);
    expect(useToastStore.getState().toasts.some((t) => t.kind === 'error')).toBe(true);
  });

  it('closes on Escape, an outside click, the wheel and a resize', async () => {
    const wf = seed();
    await openEditor(wf.id);
    for (const close of [
      () => fireEvent.keyDown(document.body, { key: 'Escape' }),
      () => fireEvent.mouseDown(document.body),
      () => fireEvent.wheel(document.body),
      () => fireEvent(window, new Event('resize')),
    ]) {
      openMenu({ type: 'node', nodeName: 'Shape' });
      expect(screen.getByRole('menu', { name: 'Canvas actions' })).toBeTruthy();
      act(() => {
        close();
      });
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      expect(useUiStore.getState().contextMenu).toBeNull();
    }
  });

  it('arrow keys move through the entries, skipping disabled ones', async () => {
    const wf = seed();
    await openEditor(wf.id);
    openMenu({ type: 'node', nodeName: 'Shape' });
    const items = within(menu()).getAllByRole('menuitem');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu(), { key: 'ArrowUp' });
    fireEvent.keyDown(menu(), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu(), { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
  });
});
