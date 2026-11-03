import { screen, waitFor } from '@testing-library/react';
import type { WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const trigger: WorkflowNode = {
  id: 't',
  name: 'Start',
  type: 'core.manualTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

const patches = () => backend().requests.filter((r) => r.method === 'PATCH' && /^\/workflows\/[^/]+$/.test(r.path));

async function openEditor(active = false) {
  signedIn();
  const wf = backend().seedWorkflow({ name: 'Auto', nodes: [trigger], connections: {}, active });
  renderApp(`/workflow/${wf.id}`);
  await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
  // the settings (autosaveEnabled) load after the page
  await new Promise((r) => setTimeout(r, 300));
  return wf;
}

describe('autosave (P3-17)', () => {
  beforeEach(() => {
    useWorkflowStore.getState().reset?.();
  });

  it('saves the draft with autosaved: true after a change, never activates or publishes', async () => {
    await openEditor(true);
    expect(patches()).toHaveLength(0);
    useWorkflowStore.getState().moveNodes({ Start: [120, 40] });
    expect(patches()).toHaveLength(0); // not before the 1.5 s pause
    await waitFor(() => expect(patches()).toHaveLength(1), { timeout: 6000 });
    expect(patches()[0].body).toMatchObject({ autosaved: true });
    expect(backend().requests.some((r) => r.path.endsWith('/activate'))).toBe(false);
    expect(backend().requests.some((r) => JSON.stringify(r.body ?? '').includes('publishIfActive'))).toBe(false);
    await waitFor(() => expect(useWorkflowStore.getState().dirty).toBe(false));
    await screen.findByText('Autosaved');
  }, 60_000);

  it('saves at most 5 s after the first unsaved change while edits keep coming', async () => {
    await openEditor();
    const start = Date.now();
    for (let i = 1; i <= 8; i++) {
      useWorkflowStore.getState().moveNodes({ Start: [i * 10, 0] });
      await new Promise((r) => setTimeout(r, 900));
    }
    await waitFor(() => expect(patches().length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
    expect(Date.now() - start).toBeLessThan(8000);
  }, 60_000);

  it('does nothing for a read-only (archived) workflow', async () => {
    await openEditor();
    useWorkflowStore.getState().setArchived(true);
    useWorkflowStore.getState().moveNodes({ Start: [5, 5] });
    await new Promise((r) => setTimeout(r, 2500));
    expect(patches()).toHaveLength(0);
  }, 60_000);
});
