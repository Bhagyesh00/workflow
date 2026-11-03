/**
 * P3-06 in the editor: after a run, editing B marks it dirty (badge with n8n's tooltip, output banner); "Execute
 * step" on C sends the last run data with dirtyNodeNames ['B'], so the trigger and A are not run again; undoing
 * the edit clears the mark.
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PushEvent } from '../src/api/types';
import { dirtyTooltip } from '../src/components/canvas/CanvasNode';
import { useRunStore } from '../src/stores/run-store';
import { useUiStore } from '../src/stores/ui-store';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const set = (id: string, name: string, x: number, value: string): WorkflowNode => ({
  id,
  name,
  type: 'core.set',
  typeVersion: 1,
  position: [x, 0],
  parameters: {
    mode: 'manual',
    includeOtherFields: true,
    assignments: { assignments: [{ id: `${id}-1`, name: id, type: 'string', value }] },
  },
});

const nodes: WorkflowNode[] = [
  { id: 't', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
  set('a', 'A', 250, 'A'),
  set('b', 'B', 500, 'old'),
  set('c', 'C', 750, 'C'),
];
const connections = {
  Start: { main: [[{ node: 'A', type: 'main' as const, index: 0 }]] },
  A: { main: [[{ node: 'B', type: 'main' as const, index: 0 }]] },
  B: { main: [[{ node: 'C', type: 'main' as const, index: 0 }]] },
};

const CHANGED = dirtyTooltip('parameters');
const badge = (id: string) => document.querySelector(`[data-id="${id}"] [title="${CHANGED}"]`);
const setB = (value: string) =>
  act(() => useWorkflowStore.getState().setParameter('B', ['assignments', 'assignments', 0, 'value'], value));

describe('dirty nodes and partial runs (P3-06)', () => {
  let events: PushEvent[] = [];

  beforeEach(() => {
    signedIn();
    useRunStore.getState().reset();
    useUiStore.setState({ ndvNode: null, sidePanel: null, saveConflict: false });
    events = [];
    const original = backend().simulate;
    backend().simulate = (input) =>
      original({
        ...input,
        emit: (event) => {
          events.push(event);
          input.emit(event);
        },
      });
  });
  afterEach(() => {
    useRunStore.getState().reset();
  });

  async function openAndRun() {
    const user = userEvent.setup();
    const wf = backend().seedWorkflow({ name: 'Partial', nodes, connections });
    renderApp(`/workflow/${wf.id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 20_000 });
    await waitFor(() => expect(document.querySelector('[data-id="c"]')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Execute workflow' }));
    await waitFor(() => expect(useRunStore.getState().status).toBe('success'), { timeout: 5000 });
    expect(useRunStore.getState().ranDefinition?.nodes.map((n) => n.name)).toEqual(['Start', 'A', 'B', 'C']);
    return { user, wf };
  }

  it('marks an edited node, sends dirtyNodeNames on Execute step, reuses the nodes before it', async () => {
    const { user, wf } = await openAndRun();
    expect(badge('b')).toBeNull();

    setB('new');
    await waitFor(() => expect(badge('b')).toBeTruthy());
    expect(badge('a')).toBeNull();
    expect(badge('c')).toBeNull();

    events = [];
    await user.click(screen.getByRole('button', { name: 'Execute C' }));
    await waitFor(() => expect(useRunStore.getState().status).toBe('success'), { timeout: 5000 });

    const runs = backend().requests.filter(
      (r) => r.method === 'POST' && r.path === `/workflows/${wf.id}/run`,
    );
    const body = runs.at(-1)!.body as {
      destinationNode?: string;
      dirtyNodeNames?: string[];
      runData?: object;
    };
    expect(body.destinationNode).toBe('C');
    expect(body.dirtyNodeNames).toEqual(['B']);
    expect(Object.keys(body.runData ?? {}).sort()).toEqual(['A', 'B', 'C', 'Start']);

    const started = events.filter((e) => e.type === 'nodeExecuteBefore').map((e) => e.data.nodeName);
    expect(started).toEqual(['B', 'C']);
    const runData = useRunStore.getState().runData;
    expect(runData.A).toHaveLength(1);
    expect(runData.C[0].data?.main?.[0]?.[0]?.json).toMatchObject({ a: 'A', b: 'new', c: 'C' });
    // the run used the edited graph, so nothing is stale now
    await waitFor(() => expect(badge('b')).toBeNull());
  });

  it('shows the stale output banner for own parameter changes, and undo clears the mark', async () => {
    await openAndRun();
    setB('new');
    await waitFor(() => expect(badge('b')).toBeTruthy());
    act(() => useUiStore.setState({ ndvNode: 'B' }));
    expect(
      await screen.findByText('Node parameters have changed. Execute the step again to refresh the output.'),
    ).toBeTruthy();
    act(() => useUiStore.setState({ ndvNode: null }));

    act(() => useWorkflowStore.getState().undo());
    await waitFor(() => expect(badge('b')).toBeNull());
  });

  it('a full run (Execute workflow) sends no run data and no dirty nodes', async () => {
    const { user, wf } = await openAndRun();
    setB('new');
    await user.click(screen.getByRole('button', { name: 'Execute workflow' }));
    await waitFor(() => expect(useRunStore.getState().status).toBe('success'), { timeout: 5000 });
    const runs = backend().requests.filter(
      (r) => r.method === 'POST' && r.path === `/workflows/${wf.id}/run`,
    );
    expect(runs.at(-1)!.body).not.toHaveProperty('runData');
    expect(runs.at(-1)!.body).not.toHaveProperty('dirtyNodeNames');
  });
});
