/**
 * P3-05 editor: the Convert to sub-workflow dialog and its requests (create in the parent's folder,
 * publish, one undo step in the parent, success toast with "Open in new tab").
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowsApi } from '../src/api/endpoints';
import { HttpError } from '../src/demo/mock-http';
import { useToastStore, useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const node = (id: string, name: string, type: string, x: number, parameters = {}): WorkflowNode => ({
  id,
  name,
  type,
  typeVersion: 1,
  position: [x, 0],
  parameters,
});

function seed(folderId: string | null = 'folder-1') {
  signedIn();
  return backend().seedWorkflow({
    name: 'Parent',
    folderId,
    nodes: [
      node('n1', 'Start', 'core.manualTrigger', 0),
      node('n2', 'Shape', 'core.set', 300),
      node('n3', 'Other', 'core.set', 600),
      node('n4', 'Last', 'core.set', 900, { v: "={{ $('Shape').item.json.a }}" }),
    ],
    connections: {
      Start: { main: [[{ node: 'Shape', type: 'main', index: 0 }]] },
      Shape: { main: [[{ node: 'Other', type: 'main', index: 0 }]] },
      Other: { main: [[{ node: 'Last', type: 'main', index: 0 }]] },
    },
  });
}

async function openEditor(id: string) {
  renderApp(`/workflow/${id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(document.querySelector('[data-id="n2"]')).toBeTruthy());
}

const select = (nodes: string[]) =>
  act(() => useWorkflowStore.getState().select({ nodes, stickies: [], edges: [] }));
const requests = (method: string, path: RegExp) =>
  backend().requests.filter((r) => r.method === method && path.test(r.path));

beforeEach(() => {
  vi.restoreAllMocks();
  useWorkflowStore.getState().reset();
  useToastStore.setState({ toasts: [] });
  useUiStore.setState({ convertOpen: false });
});

describe('Convert to sub-workflow', () => {
  it('creates the workflow in the parent folder, publishes it and replaces the nodes in one undo step', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    select(['Shape', 'Other']);
    const toolbar = await screen.findByRole('toolbar', { name: 'Selection actions' });
    await user.click(within(toolbar).getByRole('button', { name: /Convert to sub-workflow/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Convert to sub-workflow' });
    expect(within(dialog).getByText(/Move 2 nodes to a new workflow/)).toBeTruthy();
    const input = within(dialog).getByRole('textbox', { name: 'Sub-workflow name' });
    await user.clear(input);
    await user.type(input, 'Shape it');
    const before = useWorkflowStore.getState().past.length;
    await user.click(within(dialog).getByRole('button', { name: 'Convert' }));

    await waitFor(() => expect(useUiStore.getState().convertOpen).toBe(false));
    const [create] = requests('POST', /^\/workflows$/);
    const body = create.body as {
      name: string;
      folderId: string | null;
      nodes: WorkflowNode[];
      settings: unknown;
    };
    expect(body.name).toBe('Shape it');
    expect(body.folderId).toBe('folder-1');
    expect(body.settings).toEqual({ executionOrder: 'v1' });
    expect(body.nodes.map((n) => n.name)).toEqual(['Start', 'Shape', 'Other', 'Return']);
    const created = backend().workflows.find((w) => w.name === 'Shape it')!;
    const [publish] = requests('POST', /\/activate$/);
    expect(publish.path).toBe(`/workflows/${created.id}/activate`);
    expect(publish.body).toEqual({ versionId: created.versionId });

    const s = useWorkflowStore.getState();
    expect(s.nodes.map((n) => n.name)).toEqual(['Start', 'Last', 'Call Shape it']);
    const call = s.nodes.find((n) => n.name === 'Call Shape it')!;
    expect(call.type).toBe('core.executeWorkflow');
    expect(call.parameters.workflowId).toEqual({
      __rl: true,
      mode: 'list',
      value: created.id,
      cachedResultName: 'Shape it',
    });
    expect(s.connections.Start?.main?.[0]).toEqual([{ node: 'Call Shape it', type: 'main', index: 0 }]);
    expect(s.connections['Call Shape it']?.main?.[0]).toEqual([{ node: 'Last', type: 'main', index: 0 }]);
    expect(s.nodes.find((n) => n.name === 'Last')!.parameters).toEqual({
      v: "={{ $('Call Shape it').item.json.Shape_a }}",
    });
    expect(s.selection.nodes).toEqual(['Call Shape it']);
    expect(s.past).toHaveLength(before + 1);
    // the parent is only changed locally (saved with the next save)
    expect(requests('PATCH', /^\/workflows\//)).toHaveLength(0);

    const success = useToastStore.getState().toasts.find((t) => t.title === 'Created sub-workflow')!;
    expect(success.kind).toBe('success');
    expect(success.action?.label).toBe('Open in new tab');
    success.action!.onClick();
    expect(open).toHaveBeenCalledWith(`/workflow/${created.id}`, '_blank', 'noopener');

    act(() => useWorkflowStore.getState().undo());
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Start', 'Shape', 'Other', 'Last']);
  });

  it('still converts when publishing the new workflow fails', async () => {
    const user = userEvent.setup();
    const wf = seed(null);
    await openEditor(wf.id);
    const warn = vi.spyOn(console, 'warn');
    vi.spyOn(workflowsApi, 'activate').mockRejectedValue(new HttpError(400, 'invalid', 'Cannot publish'));
    select(['Shape']);
    act(() => useUiStore.getState().setConvertOpen(true));
    const dialog = await screen.findByRole('dialog', { name: 'Convert to sub-workflow' });
    expect(within(dialog).getByText(/Move 1 node to a new workflow/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Convert' }));
    await waitFor(() => expect(useUiStore.getState().convertOpen).toBe(false));
    const [create] = requests('POST', /^\/workflows$/);
    expect((create.body as { name: string; folderId: unknown }).name).toBe('My sub-workflow');
    expect((create.body as { folderId: unknown }).folderId).toBeNull();
    // the user is told the new workflow stayed a draft; nothing goes to the console
    const unpublished = useToastStore
      .getState()
      .toasts.find((t) => t.title === 'Could not publish the sub-workflow')!;
    expect(unpublished.kind).toBe('error');
    expect(unpublished.description).toBe('Cannot publish. "My sub-workflow" is saved as a draft.');
    expect(unpublished.action?.label).toBe('Open in new tab');
    expect(warn).not.toHaveBeenCalled();
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toContain('Call My sub-workflow');
    expect(useToastStore.getState().toasts.some((t) => t.title === 'Created sub-workflow')).toBe(true);
  });

  it('keeps the parent and the dialog when the new workflow cannot be created', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    vi.spyOn(workflowsApi, 'create').mockRejectedValue(new HttpError(403, 'forbidden', 'No access'));
    select(['Shape', 'Other']);
    act(() => useUiStore.getState().setConvertOpen(true));
    const dialog = await screen.findByRole('dialog', { name: 'Convert to sub-workflow' });
    await user.click(within(dialog).getByRole('button', { name: 'Convert' }));
    await waitFor(() =>
      expect(
        useToastStore.getState().toasts.some((t) => t.title === 'Could not create the sub-workflow'),
      ).toBe(true),
    );
    expect(useUiStore.getState().convertOpen).toBe(true);
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Start', 'Shape', 'Other', 'Last']);
    expect(requests('POST', /\/activate$/)).toHaveLength(0);
  });

  it('asks for a name', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    select(['Shape']);
    act(() => useUiStore.getState().setConvertOpen(true));
    const dialog = await screen.findByRole('dialog', { name: 'Convert to sub-workflow' });
    await user.clear(within(dialog).getByRole('textbox', { name: 'Sub-workflow name' }));
    await user.click(within(dialog).getByRole('button', { name: 'Convert' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Enter a name for the sub-workflow.');
    expect(requests('POST', /^\/workflows$/)).toHaveLength(0);
  });

  it('Alt+X on a selection the rules refuse shows the rule and opens no dialog', async () => {
    const wf = seed();
    await openEditor(wf.id);
    select(['Start', 'Shape']);
    act(() => void fireEvent.keyDown(window, { key: 'x', code: 'KeyX', altKey: true }));
    await waitFor(() => expect(useUiStore.getState().convertOpen).toBe(false));
    const error = useToastStore
      .getState()
      .toasts.find((t) => t.title === 'Could not convert to a sub-workflow')!;
    expect(error.kind).toBe('error');
    expect(error.description).toMatch(/trigger node cannot be part of a group/);
    expect(screen.queryByRole('dialog', { name: 'Convert to sub-workflow' })).toBeNull();
    expect(requests('POST', /^\/workflows$/)).toHaveLength(0);
  });
});
