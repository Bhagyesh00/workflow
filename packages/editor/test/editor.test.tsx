import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../src/lib/ids';
import { useRunStore } from '../src/stores/run-store';
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
const shape: WorkflowNode = {
  id: 'n2',
  name: 'Shape',
  type: 'core.set',
  typeVersion: 1,
  position: [300, 0],
  parameters: {
    mode: 'manual',
    includeOtherFields: false,
    assignments: {
      assignments: [{ id: 'a', name: 'greeting', type: 'string', value: '=hello {{ 1 + 1 }}' }],
    },
  },
};

function seed() {
  signedIn();
  return backend().seedWorkflow({
    name: 'Greeter',
    nodes: [trigger, shape],
    connections: { Start: { main: [[{ node: 'Shape', type: 'main', index: 0 }]] } },
  });
}

async function openEditor(id: string) {
  const utils = renderApp(`/workflow/${id}`);
  // generous: the first render loads the whole editor bundle, which is slow when test files run in parallel
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  await waitFor(() => expect(document.querySelector('[data-id="n2"]')).toBeTruthy());
  return utils;
}

describe('workflow editor', () => {
  beforeEach(() => {
    useUiStore.setState({ ndvNode: null, sidePanel: null, saveConflict: false });
  });

  it('loads the workflow onto the canvas with its ports', async () => {
    const wf = seed();
    await openEditor(wf.id);
    const shapeNode = document.querySelector<HTMLElement>('[data-id="n2"]')!;
    expect(within(shapeNode).getByText('Shape')).toBeTruthy();
    expect(shapeNode.querySelector('[data-handleid="in:main:0"]')).toBeTruthy();
    expect(shapeNode.querySelector('[data-handleid="out:main:0"]')).toBeTruthy();
    expect(document.querySelector('[data-id="n1"] [data-handleid="in:main:0"]')).toBeNull();
  });

  it('saves with the current versionId and resolves a 409 by overwriting', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    const name = screen.getByRole('textbox', { name: 'Workflow name' });
    await user.clear(name);
    await user.type(name, 'Greeter v2{Enter}');
    expect(useWorkflowStore.getState().dirty).toBe(true);

    // someone else saves in the meantime
    const stored = backend().workflows.find((w) => w.id === wf.id)!;
    stored.versionId = newId();
    stored.name = 'Their name';

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This workflow changed elsewhere')).toBeTruthy();
    const conflicted = backend().requests.filter((r) => r.method === 'PATCH');
    expect(conflicted).toHaveLength(1);
    expect((conflicted[0].body as { versionId: string }).versionId).toBe(wf.versionId);

    await user.click(screen.getByRole('button', { name: 'Keep mine and overwrite' }));
    await waitFor(() => expect(backend().workflows.find((w) => w.id === wf.id)?.name).toBe('Greeter v2'));
    await waitFor(() => expect(useWorkflowStore.getState().dirty).toBe(false));
    expect(useWorkflowStore.getState().meta.versionId).toBe(
      backend().workflows.find((w) => w.id === wf.id)?.versionId,
    );
  });

  it('resolves a 409 by loading the other version', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    const name = screen.getByRole('textbox', { name: 'Workflow name' });
    await user.clear(name);
    await user.type(name, 'Mine{Enter}');
    const stored = backend().workflows.find((w) => w.id === wf.id)!;
    stored.versionId = newId();
    stored.name = 'Theirs';
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Load their version' }));
    await waitFor(() => expect(useWorkflowStore.getState().meta.name).toBe('Theirs'));
    expect(useWorkflowStore.getState().dirty).toBe(false);
  });

  it('executes the workflow and shows live node status from push events', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    await user.click(screen.getByRole('button', { name: 'Execute workflow' }));
    await waitFor(() => expect(useRunStore.getState().status).toBe('success'), { timeout: 5000 });
    const run = backend().requests.find((r) => r.path === `/workflows/${wf.id}/run`)!;
    expect(run.body).toMatchObject({ pinData: {} });
    expect((run.body as { workflowData?: unknown }).workflowData).toBeUndefined();
    await waitFor(() => expect(document.querySelector('[data-id="n2"] [title="Succeeded"]')).toBeTruthy());
    expect(screen.getByTestId('edge-count').textContent).toBe('1 item');
    const output = useRunStore.getState().runData.Shape[0].data?.main?.[0]?.[0]?.json;
    expect(output).toEqual({ greeting: 'hello 2' });
  });

  it('sends unsaved changes with the run request', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    act(() => useWorkflowStore.getState().setParameter('Shape', ['includeOtherFields'], true));
    await user.click(screen.getByRole('button', { name: 'Execute workflow' }));
    await waitFor(() => expect(useRunStore.getState().status).toBe('success'), { timeout: 5000 });
    const run = backend().requests.find((r) => r.path === `/workflows/${wf.id}/run`)!;
    const data = (run.body as { workflowData: { nodes: WorkflowNode[] } }).workflowData;
    expect(data.nodes.find((n) => n.name === 'Shape')?.parameters.includeOtherFields).toBe(true);
  });

  it('shows failed nodes and activation errors', async () => {
    const user = userEvent.setup();
    signedIn();
    const wf = backend().seedWorkflow({
      name: 'Broken',
      nodes: [
        trigger,
        { ...shape, id: 'n3', name: 'Call', type: 'core.httpRequest', parameters: { url: '' } },
      ],
      connections: { Start: { main: [[{ node: 'Call', type: 'main', index: 0 }]] } },
    });
    renderApp(`/workflow/${wf.id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 5000 });
    await user.click(screen.getByRole('button', { name: 'Execute workflow' }));
    await waitFor(() => expect(useRunStore.getState().status).toBe('error'), { timeout: 5000 });
    await waitFor(() => expect(document.querySelector('[data-id="n3"] [title="Failed"]')).toBeTruthy());

    await user.click(screen.getByRole('switch', { name: /inactive/i }));
    expect(await screen.findByText('The workflow could not be activated')).toBeTruthy();
    expect(screen.getByText(/trigger other than the manual trigger/)).toBeTruthy();
  });

  it('opens the node details view with input data, parameters and output', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    await user.click(screen.getByRole('button', { name: 'Execute workflow' }));
    await waitFor(() => expect(useRunStore.getState().status).toBe('success'), { timeout: 5000 });
    fireEvent.doubleClick(document.querySelector('[data-id="n2"]')!);
    const dialog = await screen.findByRole('dialog', { name: 'Shape details' });
    expect(within(dialog).getByRole('region', { name: 'Input' })).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Fields to Set' })).toBeTruthy();
    const output = within(dialog).getByRole('region', { name: 'Output' });
    expect(within(output).getByText('hello 2')).toBeTruthy();
    // pin the output, then the canvas shows the pinned badge
    await user.click(within(output).getByRole('button', { name: /^Pin$/ }));
    expect(useWorkflowStore.getState().pinData.Shape).toEqual([{ json: { greeting: 'hello 2' } }]);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(document.querySelector('[data-id="n2"] [title="Output is pinned"]')).toBeTruthy(),
    );
  });

  it('renames a node from the NDV and keeps references working', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    act(() =>
      useWorkflowStore.getState().setParameter('Shape', ['jsonOutput'], "={{ $('Start').item.json }}"),
    );
    fireEvent.doubleClick(document.querySelector('[data-id="n1"]')!);
    const dialog = await screen.findByRole('dialog', { name: 'Start details' });
    const input = within(dialog).getByRole('textbox', { name: 'Node name' });
    await user.clear(input);
    await user.type(input, 'Kickoff{Enter}');
    await waitFor(() => expect(useWorkflowStore.getState().nodes[0].name).toBe('Kickoff'));
    expect(useWorkflowStore.getState().nodes[1].parameters.jsonOutput).toBe("={{ $('Kickoff').item.json }}");
  });

  it('adds a node from the node creator and connects it after the selection', async () => {
    const user = userEvent.setup();
    const wf = seed();
    await openEditor(wf.id);
    act(() => useWorkflowStore.getState().select({ nodes: ['Shape'], stickies: [], edges: [] }));
    await user.click(screen.getByRole('button', { name: 'Add node' }));
    const creator = await screen.findByRole('complementary', { name: 'Node creator' });
    await user.type(within(creator).getByRole('textbox', { name: 'Search nodes' }), 'no op');
    await user.click(await within(creator).findByTestId('creator-item-core.noOp'));
    await waitFor(() =>
      expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toContain('No Operation'),
    );
    const connections = useWorkflowStore.getState().connections.Shape?.main?.[0] ?? [];
    expect(connections.map((c) => c.node)).toEqual(['No Operation']);
    expect(useUiStore.getState().ndvNode).toBe('No Operation');
  });

  it('guards against leaving with unsaved changes', async () => {
    const user = userEvent.setup();
    const wf = seed();
    const { router } = await openEditor(wf.id);
    act(() => useWorkflowStore.getState().setName('Changed'));
    await act(async () => {
      await router.navigate('/workflows');
    });
    expect(await screen.findByText('Save changes before leaving?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Stay' }));
    expect(router.state.location.pathname).toBe(`/workflow/${wf.id}`);
  });
});
