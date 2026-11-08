/** P3-01: the command bar in the app: keys, tabs, search, paging, editor and execution commands. */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executionsApi } from '../src/api/endpoints';
import { useCommandRegistry } from '../src/features/command-bar/commands';
import { useBuilderStore } from '../src/stores/builder-store';
import { useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const trigger: WorkflowNode = {
  id: 'n1',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};
const code: WorkflowNode = {
  id: 'n2',
  name: 'Shape',
  type: 'core.set',
  typeVersion: 1,
  position: [300, 0],
  parameters: {},
};

const bar = () => screen.queryByRole('dialog', { name: 'Command bar' });
const input = () => screen.getByRole('combobox', { name: 'Search the command bar' });
const inBar = () => within(screen.getByRole('dialog', { name: 'Command bar' }));
const optionTitles = () =>
  inBar()
    .queryAllByRole('option')
    .map((o) => o.textContent ?? '');

/** Ctrl+K as the user presses it; false when the page called preventDefault */
function pressCtrlK(): boolean {
  return fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
}

/** the signed-in app: the shell (and with it the command bar) is mounted */
async function renderShell(path: string) {
  const utils = renderApp(path);
  await screen.findByRole('navigation', { name: 'Main' }, { timeout: 20_000 });
  return utils;
}

async function openBar() {
  act(() => {
    pressCtrlK();
  });
  await screen.findByRole('dialog', { name: 'Command bar' });
}

async function openEditor(id: string) {
  const utils = renderApp(`/workflow/${id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(document.querySelector('[data-id="n1"]')).toBeTruthy());
  return utils;
}

beforeEach(() => {
  signedIn();
  useUiStore.setState({ commandBarOpen: false, ndvNode: null, sidePanel: null });
});

afterEach(() => {
  useCommandRegistry.setState({ sources: {}, nodeAdder: null });
  vi.restoreAllMocks();
});

describe('command bar keys', () => {
  it('Ctrl+K opens and closes it, and stops the browser search; Esc closes', async () => {
    await renderShell('/workflows');
    expect(bar()).toBeNull();
    let notPrevented = true;
    act(() => {
      notPrevented = pressCtrlK();
    });
    expect(notPrevented).toBe(false);
    await screen.findByRole('dialog', { name: 'Command bar' });
    expect(document.activeElement).toBe(input());
    act(() => {
      pressCtrlK();
    });
    await waitFor(() => expect(bar()).toBeNull());
    await openBar();
    fireEvent.keyDown(input(), { key: 'Escape' });
    await waitFor(() => expect(bar()).toBeNull());
  });

  it('works from a text field', async () => {
    await renderShell('/workflows');
    const search = document.createElement('input');
    document.body.append(search);
    search.focus();
    act(() => {
      fireEvent.keyDown(search, { key: 'k', metaKey: true });
    });
    await screen.findByRole('dialog', { name: 'Command bar' });
  });

  it('stays closed over another modal dialog and over the node details view', async () => {
    const wf = backend().seedWorkflow({ name: 'Greeter', nodes: [trigger, code], connections: {} });
    await openEditor(wf.id);
    act(() => useUiStore.getState().openNdv('Shape'));
    await waitFor(() => expect(document.querySelector('[data-ndv]')).toBeTruthy());
    act(() => {
      pressCtrlK();
    });
    expect(bar()).toBeNull();
  });

  it('switches tabs with Tab, Shift+Tab and the arrows at the caret edges', async () => {
    await renderShell('/workflows');
    await openBar();
    const selected = () => screen.getByRole('tab', { selected: true }).textContent;
    expect(selected()).toBe('All');
    const user = userEvent.setup();
    await user.keyboard('{Tab}');
    expect(selected()).toBe('Nodes');
    await user.keyboard('{Tab}{Tab}');
    expect(selected()).toBe('Actions');
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(selected()).toBe('Workflows');
    await user.keyboard('{ArrowRight}');
    expect(selected()).toBe('Actions');
    await user.keyboard('{ArrowLeft}');
    expect(selected()).toBe('Workflows');
    await user.click(screen.getByRole('tab', { name: 'All' }));
    expect(selected()).toBe('All');
  });
});

describe('command bar search', () => {
  it('a workflow name + Enter opens the workflow', async () => {
    backend().seedWorkflow({ name: 'Lead cleanup', nodes: [trigger], connections: {} });
    const target = backend().seedWorkflow({ name: 'Invoice sync', nodes: [trigger], connections: {} });
    const { router } = await renderShell('/workflows');
    await openBar();
    const user = userEvent.setup();
    await user.type(input(), 'invoice');
    await inBar().findByRole('option', { name: /Invoice sync/ });
    await waitFor(() => expect(optionTitles().some((t) => t.includes('Lead cleanup'))).toBe(false));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe(`/workflow/${target.id}`));
    expect(bar()).toBeNull();
  });

  it('an empty query lists recent workflows first, 5 of them, with Show all', async () => {
    for (let i = 0; i < 8; i++) backend().seedWorkflow({ name: `Flow ${i}`, nodes: [], connections: {} });
    await renderShell('/workflows');
    await openBar();
    await inBar().findByRole('option', { name: /Show all workflows/ });
    const titles = optionTitles();
    expect(titles.filter((t) => t.startsWith('Flow '))).toHaveLength(5);
    const firstAction = titles.findIndex((t) => t.startsWith('Open workflow'));
    expect(firstAction).toBeGreaterThan(titles.findIndex((t) => t.startsWith('Show all workflows')));
    await userEvent.setup().click(inBar().getByRole('option', { name: /Show all workflows/ }));
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Workflows');
    await waitFor(() => expect(optionTitles().filter((t) => t.startsWith('Flow '))).toHaveLength(8));
  });

  it('the Workflows tab loads 20 at a time and never lists archived workflows', async () => {
    for (let i = 0; i < 25; i++) backend().seedWorkflow({ name: `Batch ${i}`, nodes: [], connections: {} });
    backend().seedWorkflow({ name: 'Batch old', nodes: [], connections: {}, isArchived: true });
    await renderShell('/workflows');
    await openBar();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Workflows' }));
    const more = await inBar().findByRole('option', { name: 'Load more' });
    expect(optionTitles().filter((t) => t.startsWith('Batch '))).toHaveLength(20);
    await userEvent.setup().click(more);
    await waitFor(() => expect(optionTitles().filter((t) => t.startsWith('Batch '))).toHaveLength(25));
    expect(inBar().queryByRole('option', { name: 'Load more' })).toBeNull();
    expect(optionTitles().some((t) => t.includes('Batch old'))).toBe(false);
  });

  it('finds a workflow that holds a node named like the query', async () => {
    const holder = backend().seedWorkflow({ name: 'Plain name', nodes: [trigger, code], connections: {} });
    backend().seedWorkflow({ name: 'Other', nodes: [trigger], connections: {} });
    await renderShell('/workflows');
    await openBar();
    await userEvent.setup().type(input(), 'Edit Fields (Set)');
    await inBar().findByRole('option', { name: /Plain name/ });
    // the search settles after the debounce: only the workflow holding the node is left
    await waitFor(() => expect(optionTitles()).toEqual(['Plain name']));
    expect(holder.id).toBeTruthy();
  });

  it('the Nodes tab tells you to open a workflow when none is open', async () => {
    await renderShell('/workflows');
    await openBar();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Nodes' }));
    expect(await screen.findByText('Open a workflow to add nodes.')).toBeTruthy();
  });

  it('go-to commands open the page; Ctrl+Enter opens a workflow in a new tab', async () => {
    const wf = backend().seedWorkflow({ name: 'Tabbed', nodes: [], connections: {} });
    backend().seedWorkflow({ name: 'Distractor', nodes: [], connections: {} });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { router } = await renderShell('/workflows');
    await openBar();
    const user = userEvent.setup();
    await user.type(input(), 'go to exec');
    await inBar().findByRole('option', { name: /Go to Executions/ });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/executions'));
    await openBar();
    await user.type(input(), 'tabbed');
    await waitFor(() => expect(optionTitles()).toEqual(['Tabbed']));
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(open).toHaveBeenCalledWith(`/workflow/${wf.id}`, '_blank', 'noopener,noreferrer');
  });
});

describe('command bar in the editor', () => {
  it('"edit fields" + Enter adds Edit Fields after the selected node and selects it', async () => {
    const wf = backend().seedWorkflow({ name: 'Greeter', nodes: [trigger], connections: {} });
    await openEditor(wf.id);
    act(() => useWorkflowStore.getState().select({ nodes: ['Start'], stickies: [], edges: [] }));
    await openBar();
    const user = userEvent.setup();
    await user.type(input(), 'edit fields');
    await inBar().findByRole('option', { name: /Edit Fields \(Set\)/ });
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(useWorkflowStore.getState().nodes.some((n) => n.type === 'core.set')).toBe(true),
    );
    const s = useWorkflowStore.getState();
    const added = s.nodes.find((n) => n.type === 'core.set');
    expect(s.selection.nodes).toEqual([added?.name]);
    expect(s.connections.Start.main?.[0]?.[0]?.node).toBe(added?.name);
    expect(bar()).toBeNull();
  });

  it('offers the editor commands, without Save, and runs them', async () => {
    const wf = backend().seedWorkflow({ name: 'Greeter', nodes: [trigger, code], connections: {} });
    await openEditor(wf.id);
    await openBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Actions' }));
    await inBar().findByRole('option', { name: /Add sticky note/ });
    const titles = optionTitles();
    for (const expected of [
      'Add node',
      'Add sticky note',
      'Nodes in workflow',
      'Test workflow',
      'Tidy up workflow',
      'Select all',
      'Rename workflow',
      'Add tag',
      'Workflow settings',
      'Duplicate workflow',
      'Download workflow',
      'Import from file',
      'Import from URL',
      'Publish workflow',
      'Archive workflow',
      'Go to Workflows',
    ]) {
      expect(
        titles.some((t) => t.startsWith(expected)),
        expected,
      ).toBe(true);
    }
    expect(titles.some((t) => /^save/i.test(t))).toBe(false);
    expect(titles.some((t) => t.startsWith('Unarchive'))).toBe(false);

    await user.click(inBar().getByRole('option', { name: /Add sticky note/ }));
    await waitFor(() => expect(useWorkflowStore.getState().stickyNotes).toHaveLength(1));
    await openBar();
    // the header takes the request at once, so watch for it
    let asked = false;
    const stop = useUiStore.subscribe((state) => {
      if (state.workflowRenameRequested) asked = true;
    });
    await user.type(input(), 'rename workflow');
    await user.keyboard('{Enter}');
    stop();
    expect(asked).toBe(true);
  });

  it('"Nodes in workflow" is a second level; Backspace on an empty query goes back', async () => {
    const wf = backend().seedWorkflow({ name: 'Greeter', nodes: [trigger, code], connections: {} });
    await openEditor(wf.id);
    await openBar();
    const user = userEvent.setup();
    await user.type(input(), 'nodes in');
    await inBar().findByRole('option', { name: /Nodes in workflow/ });
    await user.keyboard('{Enter}');
    await inBar().findByRole('option', { name: /^Shape/ });
    expect(optionTitles()).toHaveLength(2);
    expect(optionTitles()[0]).toMatch(/^Start/);
    expect(screen.queryByRole('tab')).toBeNull();
    await user.keyboard('{Backspace}');
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(4));
    // choosing a node opens it
    await user.type(input(), 'nodes in');
    await user.keyboard('{Enter}');
    await user.click(await inBar().findByRole('option', { name: /^Shape/ }));
    expect(useUiStore.getState().ndvNode).toBe('Shape');
    expect(bar()).toBeNull();
  });

  it('an archived workflow offers Unarchive and Delete, and none of the write commands', async () => {
    const wf = backend().seedWorkflow({ name: 'Old', nodes: [trigger], connections: {}, isArchived: true });
    await openEditor(wf.id);
    await openBar();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Actions' }));
    await inBar().findByRole('option', { name: /Unarchive workflow/ });
    const titles = optionTitles();
    expect(titles.some((t) => t.startsWith('Delete workflow'))).toBe(true);
    for (const hidden of [
      'Archive workflow',
      'Add sticky note',
      'Add node',
      'Publish workflow',
      'Test workflow',
    ])
      expect(
        titles.some((t) => t.startsWith(hidden)),
        hidden,
      ).toBe(false);
    expect(titles.some((t) => t.startsWith('Download workflow'))).toBe(true);
  });

  it('a streaming builder turn hides the write commands until it ends', async () => {
    const wf = backend().seedWorkflow({ name: 'Greeter', nodes: [trigger, code], connections: {} });
    await openEditor(wf.id);
    act(() => useBuilderStore.getState().setStreaming(true));
    try {
      await openBar();
      await userEvent.setup().click(screen.getByRole('tab', { name: 'Actions' }));
      await inBar().findByRole('option', { name: /Download workflow/ });
      const titles = optionTitles();
      for (const hidden of [
        'Add node',
        'Add sticky note',
        'Test workflow',
        'Tidy up workflow',
        'Rename workflow',
        'Publish workflow',
      ])
        expect(
          titles.some((t) => t.startsWith(hidden)),
          hidden,
        ).toBe(false);
      expect(useCommandRegistry.getState().nodeAdder).toBeNull();
      act(() => useBuilderStore.getState().setStreaming(false));
      await inBar().findByRole('option', { name: /Add sticky note/ });
    } finally {
      act(() => useBuilderStore.getState().setStreaming(false));
    }
  });
});

describe('command bar on an execution', () => {
  async function failedExecution() {
    const wf = backend().seedWorkflow({
      name: 'Caller',
      nodes: [trigger, { ...code, id: 'c', name: 'Call', type: 'core.httpRequest', parameters: { url: '' } }],
      connections: { Start: { main: [[{ node: 'Call', type: 'main' as const, index: 0 }]] } },
    });
    await backend().handle({ method: 'POST', path: `/workflows/${wf.id}/run`, body: {} });
    await waitFor(() => expect(backend().executions.filter((e) => e.status !== 'running')).toHaveLength(1));
    return backend().executions[0];
  }

  it('offers debug, vote, retry and delete; vote sends the vote', async () => {
    const execution = await failedExecution();
    execution.status = 'error';
    const annotate = vi.spyOn(executionsApi, 'annotate').mockResolvedValue(null);
    const { router } = await renderShell(`/executions/${execution.id}`);
    await screen.findByText('Caller');
    await waitFor(() => expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy());
    await openBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Actions' }));
    await inBar().findByRole('option', { name: /Vote up/ });
    const titles = optionTitles();
    for (const expected of [
      'Debug in editor',
      'Vote up',
      'Vote down',
      'Retry with current workflow',
      'Retry with original workflow',
      'Delete execution',
    ])
      expect(
        titles.some((t) => t.startsWith(expected)),
        expected,
      ).toBe(true);
    expect(titles.some((t) => t.startsWith('Stop execution'))).toBe(false);
    await user.click(inBar().getByRole('option', { name: /Vote up/ }));
    await waitFor(() => expect(annotate).toHaveBeenCalledWith(execution.id, { vote: 'up' }));

    await openBar();
    await user.type(input(), 'debug');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        `/workflow/${encodeURIComponent(execution.workflowId)}?debug=${encodeURIComponent(execution.id)}`,
      ),
    );
  });

  it('a successful execution offers no Retry', async () => {
    const execution = await failedExecution();
    execution.status = 'success';
    await renderShell(`/executions/${execution.id}`);
    await screen.findByText('Caller');
    await openBar();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Actions' }));
    await inBar().findByRole('option', { name: /Vote up/ });
    expect(optionTitles().some((t) => t.startsWith('Retry'))).toBe(false);
  });
});
