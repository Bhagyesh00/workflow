/** Executions page: the start time range, and stop or delete of many runs (P6-85). */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { StoredExecution } from '../src/demo/mock-backend';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const LONG = { timeout: 10_000 };

/** a run of the first workflow of the signed-in workspace, written straight into the demo's store */
function addRun(
  name: string,
  fields: { status?: string; mode?: string; startedAt?: string; workflowId?: string } = {},
): string {
  const b = backend();
  const tenantId = b.session!.tenantId;
  const wf = b.workflows.find((w) => w.tenantId === tenantId) ?? b.seedWorkflow({ name: 'Orders' });
  const id = crypto.randomUUID();
  const run = {
    id,
    tenantId,
    workflowId: fields.workflowId ?? wf.id,
    workflowName: name,
    mode: fields.mode ?? 'manual',
    status: fields.status ?? 'success',
    startedAt: fields.startedAt ?? new Date().toISOString(),
    stoppedAt: null,
    durationMs: null,
    errorMessage: null,
    customData: null,
    workflowVersionId: null,
    annotation: null,
    workflowData: { id: wf.id, name, nodes: [], connections: {} },
    state: null,
  } as unknown as StoredExecution;
  b.executions.push(run);
  return id;
}

const statusOf = (id: string) => backend().executions.find((e) => e.id === id)?.status;

/** records the GET /executions queries */
function watchList(): Array<Record<string, string>> {
  const requests: Array<Record<string, string>> = [];
  const original = backend().handle.bind(backend());
  backend().handle = (async (req: Parameters<typeof original>[0]) => {
    if (req.method === 'GET' && req.path === '/executions') {
      const query: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query ?? {}))
        if (v !== undefined && v !== null) query[k] = String(v);
      requests.push(query);
    }
    return original(req);
  }) as typeof original;
  return requests;
}

describe('Executions page start time range', () => {
  it('sends startedAfter and startedBefore and narrows the list', async () => {
    signedIn();
    addRun('Run old', { startedAt: '2026-01-01T12:00:00.000Z' });
    addRun('Run new', { startedAt: '2026-06-01T12:00:00.000Z' });
    const requests = watchList();
    const user = userEvent.setup();
    renderApp('/executions');
    await screen.findByRole('link', { name: 'Run old' }, LONG);
    expect(requests.at(-1)?.startedAfter).toBeUndefined();

    const after = screen.getByLabelText('Started after');
    await user.type(after, '2026-03-01T00:00');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Run old' })).toBeNull(), LONG);
    expect(screen.getByRole('link', { name: 'Run new' })).toBeTruthy();
    expect(requests.at(-1)?.startedAfter).toBe(new Date('2026-03-01T00:00').toISOString());

    await user.type(screen.getByLabelText('Started before'), '2026-04-01T00:00');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Run new' })).toBeNull(), LONG);
    expect(requests.at(-1)?.startedBefore).toBe(new Date('2026-04-01T00:00').toISOString());
  });

  it('warns when the start is after the end', async () => {
    signedIn();
    addRun('Run one');
    const user = userEvent.setup();
    renderApp('/executions?startedAfter=2026-06-01T00:00:00.000Z&startedBefore=2026-01-01T00:00:00.000Z');
    await screen.findByRole('alert', undefined, LONG);
    expect(screen.getByRole('alert').textContent).toMatch(/start is after the end/i);
    await user.clear(screen.getByLabelText('Started after'));
    await waitFor(() => expect(screen.queryByText(/start is after the end/i)).toBeNull(), LONG);
  });
});

describe('Executions page bulk actions', () => {
  it('shows no bar until a run is picked, then stops the picked runs after a confirm', async () => {
    signedIn();
    const one = addRun('Run one', { status: 'waiting' });
    const two = addRun('Run two', { status: 'waiting' });
    const three = addRun('Run three', { status: 'waiting' });
    const user = userEvent.setup();
    renderApp('/executions');
    await screen.findByRole('link', { name: 'Run one' }, LONG);
    expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Select Run one' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Run two' }));
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();

    await user.click(within(bar).getByRole('button', { name: 'Stop' }));
    const confirm = await screen.findByRole('dialog', undefined, LONG);
    await user.click(within(confirm).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(statusOf(one)).toBe('canceled'), LONG);
    expect(statusOf(two)).toBe('canceled');
    expect(statusOf(three)).toBe('waiting');
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull(), LONG);
  });

  it('deletes the picked runs after a confirm, and cancel leaves them', async () => {
    signedIn();
    const keep = addRun('Run keep');
    const gone = addRun('Run gone');
    const user = userEvent.setup();
    renderApp('/executions');
    await screen.findByRole('link', { name: 'Run gone' }, LONG);
    await user.click(screen.getByRole('checkbox', { name: 'Select Run gone' }));
    await user.click(
      within(screen.getByRole('toolbar', { name: 'Bulk actions' })).getByRole('button', { name: 'Delete' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Cancel' }, LONG));
    expect(backend().executions.some((e) => e.id === gone)).toBe(true);

    await user.click(
      within(screen.getByRole('toolbar', { name: 'Bulk actions' })).getByRole('button', { name: 'Delete' }),
    );
    const confirm = await screen.findByRole('dialog', undefined, LONG);
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(backend().executions.some((e) => e.id === gone)).toBe(false), LONG);
    expect(backend().executions.some((e) => e.id === keep)).toBe(true);
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Run gone' })).toBeNull(), LONG);
  });

  it('offers every run matching the filters when the page is picked, and sends the filter', async () => {
    signedIn();
    // more than one page of 50, two modes through the start time range
    for (let i = 0; i < 55; i++)
      addRun(`Old ${i}`, { status: 'success', startedAt: '2026-01-01T00:00:00.000Z' });
    const recent = addRun('Recent run', { status: 'success', startedAt: '2026-06-01T00:00:00.000Z' });
    const seen: Array<Record<string, unknown>> = [];
    const original = backend().handle.bind(backend());
    backend().handle = (async (req: Parameters<typeof original>[0]) => {
      if (req.method === 'POST' && req.path === '/executions/delete')
        seen.push(req.body as Record<string, unknown>);
      return original(req);
    }) as typeof original;
    const user = userEvent.setup();
    renderApp('/executions?startedBefore=2026-02-01T00:00:00.000Z');
    await screen.findByRole('link', { name: 'Old 0' }, LONG);
    await user.click(screen.getByRole('checkbox', { name: 'Select all runs on this page' }));
    await user.click(
      await screen.findByRole('button', { name: /Select every run matching the filters/ }, LONG),
    );
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('All matching runs')).toBeTruthy();

    await user.click(within(bar).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', undefined, LONG);
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(backend().executions.length).toBe(1), LONG);
    expect(backend().executions[0].id).toBe(recent);
    // bounded as n8n does: only runs up to the newest listed run's start, never one that started after the list
    expect(seen[0]).toMatchObject({
      filters: { startedBefore: '2026-02-01T00:00:00.000Z' },
      deleteBefore: '2026-01-01T00:00:00.000Z',
    });
    expect(seen[0].ids).toBeUndefined();
  });

  it('a viewer cannot stop or delete: the buttons are disabled', async () => {
    const b = signedIn();
    addRun('Run one', { status: 'waiting' });
    b.setDemoRole('viewer');
    const user = userEvent.setup();
    renderApp(`/projects/${b.oldestTeamProject(b.session!.tenantId).id}/executions`);
    await screen.findByRole('link', { name: 'Run one' }, LONG);
    await user.click(screen.getByRole('checkbox', { name: 'Select Run one' }));
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    await waitFor(
      () =>
        expect((within(bar).getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(true),
      LONG,
    );
    expect((within(bar).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
