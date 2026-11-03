/** P3-13: Import from URL dialog (editor): validation, body-only URL, paste as one undo step, errors. */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const trigger = {
  id: 'n1',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0] as [number, number],
  parameters: {},
};
const remote = {
  name: 'Remote',
  nodes: [
    { ...trigger, id: 'r1', name: 'Start' },
    { ...trigger, id: 'r2', name: 'Step', type: 'core.set', position: [200, 0] as [number, number] },
  ],
  connections: { Start: { main: [[{ node: 'Step', type: 'main' as const, index: 0 }]] } },
};
const FLOW_URL = 'https://example.com/flow.json?token=abc';

describe('Import from URL dialog', () => {
  let id: string;
  beforeEach(() => {
    const mock = signedIn();
    id = mock.seedWorkflow({ name: 'Mine', nodes: [trigger], connections: {} }).id;
    useUiStore.setState({ importUrlOpen: false });
  });

  async function openDialog() {
    const utils = renderApp(`/workflow/${id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
    await waitFor(() => expect(document.querySelector('[data-id="n1"]')).toBeTruthy());
    act(() => useUiStore.getState().setImportUrlOpen(true));
    const input = await screen.findByLabelText('Workflow URL');
    return { ...utils, input };
  }

  it('keeps Import disabled until the URL is http(s)', async () => {
    const { input } = await openDialog();
    const button = screen.getByRole('button', { name: 'Import' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'ftp://example.com/x' } });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: FLOW_URL } });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('pastes the file as one undo step with fresh ids, sends the URL in the body only', async () => {
    const mock = backend();
    mock.setUrlFixture(FLOW_URL, remote);
    const { input } = await openDialog();
    fireEvent.change(input, { target: { value: FLOW_URL } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(useWorkflowStore.getState().nodes.length).toBe(3));
    const names = useWorkflowStore.getState().nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(3);
    expect(useWorkflowStore.getState().nodes.some((n) => n.id === 'r1')).toBe(false);
    const call = mock.requests.find((r) => String(r.path).includes('from-url'));
    expect(call?.path).not.toContain('token');
    expect(call?.method).toBe('POST');
    await waitFor(() => expect(useUiStore.getState().importUrlOpen).toBe(false));
    act(() => useWorkflowStore.getState().undo());
    expect(useWorkflowStore.getState().nodes.length).toBe(1);
  });

  it('shows the server message when the URL is not a JSON file and stays open', async () => {
    const { input } = await openDialog();
    fireEvent.change(input, { target: { value: 'https://example.com/other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('The URL does not point to valid JSON file!')).toBeTruthy();
    expect(useUiStore.getState().importUrlOpen).toBe(true);
    expect(useWorkflowStore.getState().nodes.length).toBe(1);
  });

  it('refuses an answer that is not a workflow', async () => {
    backend().setUrlFixture(FLOW_URL, { nodes: 'x', connections: {} });
    const { input } = await openDialog();
    fireEvent.change(input, { target: { value: FLOW_URL } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(
      await screen.findByText('The data in the file does not seem to be a workflow JSON file!'),
    ).toBeTruthy();
    expect(useWorkflowStore.getState().nodes.length).toBe(1);
  });
});
