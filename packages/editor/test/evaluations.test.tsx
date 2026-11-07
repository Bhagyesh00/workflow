/**
 * P5-11: the Evaluations page and the test run page on the demo backend (mock-evaluations): setup guide,
 * runs table, metrics chart, Run with "run in parallel", Stop test, delete, cases table, cancel of a pending
 * case, error texts, polling, and the read-only view of a viewer.
 */
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type Connections,
  EVALUATION_NODE_TYPE,
  EVALUATION_TRIGGER_TYPE,
  TEST_CASE_ERROR_TEXTS,
  TEST_RUN_ERROR_HINTS,
  TEST_RUN_ERROR_TEXTS,
  type WorkflowNode,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { runStatusLabel } from '../src/components/evaluations/RunStatusPill';
import { setupSteps } from '../src/components/evaluations/SetupGuide';
import { seedTestRun, updateTestRun } from '../src/demo/mock-evaluations';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

configure({ asyncUtilTimeout: 20_000 });

const node = (name: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({
  id: name,
  name,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters,
});

const FULL_NODES = [
  node('Dataset', EVALUATION_TRIGGER_TYPE, { source: 'dataTable' }),
  node('Outputs', EVALUATION_NODE_TYPE, { operation: 'setOutputs' }),
  node('Score', EVALUATION_NODE_TYPE, { operation: 'setMetrics', metric: 'customMetrics' }),
];
const FULL_CONNECTIONS = {
  Dataset: { main: [[{ node: 'Outputs', type: 'main' as const, index: 0 }]] },
  Outputs: { main: [[{ node: 'Score', type: 'main' as const, index: 0 }]] },
};

function seedWorkflow(nodes: WorkflowNode[] = FULL_NODES, connections: Connections = FULL_CONNECTIONS) {
  return backend().seedWorkflow({ name: 'Support bot', nodes, connections });
}

async function openList(workflowId: string) {
  const utils = renderApp(`/workflow/${workflowId}/evaluations`);
  await screen.findByRole('heading', { name: 'Evaluations' });
  return utils;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function seedCompleted(
  workflowId: string,
  metrics: Record<string, number>,
  ago: number,
  finalResult = 'success',
) {
  return seedTestRun(backend(), workflowId, {
    status: 'completed',
    metrics,
    finalResult: finalResult as 'success' | 'error',
    createdAt: minutesAgo(ago),
    runAt: minutesAgo(ago),
    completedAt: minutesAgo(ago - 1),
    caseCounts: { new: 0, running: 0, success: 3, error: 0, cancelled: 0, total: 3 },
  });
}

beforeEach(() => void signedIn());

describe('setup guide', () => {
  it('shows every step open on a workflow without an Evaluation Trigger and blocks Run', async () => {
    const wf = seedWorkflow([node('Manual', 'core.manualTrigger')], {});
    await openList(wf.id);
    const guide = await screen.findByRole('region', { name: 'Set up evaluations' });
    const steps = within(guide).getAllByRole('listitem');
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.getAttribute('data-done') === 'false')).toBe(true);
    expect((screen.getByRole('button', { name: 'Run test' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('run-controls-reason').textContent).toContain('Add an Evaluation Trigger');
  });

  it('checks the steps from the definition and keeps the guide until a run exists', async () => {
    const wf = seedWorkflow();
    await openList(wf.id);
    const guide = await screen.findByRole('region', { name: 'Set up evaluations' });
    const done = within(guide)
      .getAllByRole('listitem')
      .map((s) => s.getAttribute('data-done'));
    expect(done).toEqual(['true', 'true', 'true', 'false']);
    expect((screen.getByRole('button', { name: 'Run test' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('reads the steps from the nodes', () => {
    expect(setupSteps([], false)).toEqual({ trigger: false, outputs: false, metrics: false, ran: false });
    expect(setupSteps(FULL_NODES, true)).toEqual({ trigger: true, outputs: true, metrics: true, ran: true });
    const disabled = FULL_NODES.map((n) => ({ ...n, disabled: true }));
    expect(setupSteps(disabled, false)).toMatchObject({ trigger: true, outputs: false, metrics: false });
    // a Set Outputs node with no operation set uses the default
    expect(setupSteps([node('E', EVALUATION_NODE_TYPE)], false).outputs).toBe(true);
  });
});

describe('runs list', () => {
  it('lists the runs with a column for each metric and the status', async () => {
    const wf = seedWorkflow();
    seedCompleted(wf.id, { correctness: 0.8, helpfulness: 1 }, 30);
    seedCompleted(wf.id, { correctness: 0.9, helpfulness: 0.5 }, 10, 'error');
    seedTestRun(backend(), wf.id, {
      status: 'error',
      errorCode: 'TEST_CASES_NOT_FOUND',
      completedAt: minutesAgo(1),
    });
    await openList(wf.id);
    const table = await screen.findByRole('table', { name: 'Test runs' });
    expect(within(table).getByRole('columnheader', { name: 'correctness' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: 'helpfulness' })).toBeTruthy();
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('Finished with errors')).toBeTruthy();
    expect(within(table).getByText('Completed')).toBeTruthy();
    expect(within(table).getByText('0.90')).toBeTruthy();
    expect(within(table).getByText('0.80')).toBeTruthy();
    // the guide is gone once the workflow has a trigger and a run
    expect(screen.queryByRole('region', { name: 'Set up evaluations' })).toBeNull();
  });

  it('shows the error text and hint of a failed run', async () => {
    const wf = seedWorkflow();
    seedTestRun(backend(), wf.id, { status: 'error', errorCode: 'TEST_CASES_NOT_FOUND' });
    await openList(wf.id);
    expect(await screen.findByText(TEST_RUN_ERROR_TEXTS.TEST_CASES_NOT_FOUND)).toBeTruthy();
    expect(screen.getByText(TEST_RUN_ERROR_HINTS.TEST_CASES_NOT_FOUND as string)).toBeTruthy();
  });

  it('labels the statuses', () => {
    expect(runStatusLabel('completed', 'success')).toBe('Completed');
    expect(runStatusLabel('completed', 'error')).toBe('Finished with errors');
    expect(runStatusLabel('cancelled')).toBe('Stopped');
    expect(runStatusLabel('new')).toBe('Pending');
  });
});

describe('metrics chart', () => {
  it('draws one path per metric and a text summary', async () => {
    const wf = seedWorkflow();
    seedCompleted(wf.id, { correctness: 0.8, helpfulness: 1, executionTime: 120 }, 30);
    seedCompleted(wf.id, { correctness: 0.9, helpfulness: 0.5, executionTime: 90 }, 10);
    await openList(wf.id);
    const chart = await screen.findByRole('img', { name: /Line chart of 2 metrics over 2 runs/ });
    // the workflow's own metrics are drawn; the predefined ones start hidden
    expect(chart.querySelectorAll('path')).toHaveLength(2);
    expect(chart.getAttribute('aria-label')).toContain(
      'correctness: 0.80 in the first run, 0.90 in the last.',
    );
    expect(within(chart as unknown as HTMLElement).getByText('Run, oldest to newest')).toBeTruthy();
    expect(within(chart as unknown as HTMLElement).getByText('Mean value')).toBeTruthy();
    // a metric can be added
    await userEvent.click(screen.getByRole('checkbox', { name: 'executionTime' }));
    const wider = await screen.findByRole('img', { name: /Line chart of 3 metrics over 2 runs/ });
    expect(wider.querySelectorAll('path')).toHaveLength(3);
    // colours come from the tokens
    for (const path of wider.querySelectorAll('path'))
      expect(path.getAttribute('stroke')).toMatch(/^var\(--color-/);
  });

  it('has the same numbers as a table', async () => {
    const wf = seedWorkflow();
    seedCompleted(wf.id, { correctness: 0.8 }, 30);
    await openList(wf.id);
    const table = await screen.findByRole('table', { name: 'Metrics over runs, as a table' });
    expect(within(table).getByRole('columnheader', { name: 'correctness' })).toBeTruthy();
    expect(within(table).getByText('0.80')).toBeTruthy();
  });

  it('draws nothing while no run has metrics', async () => {
    const wf = seedWorkflow();
    seedTestRun(backend(), wf.id, { status: 'running', completedAt: null });
    await openList(wf.id);
    await screen.findByRole('table', { name: 'Test runs' });
    expect(screen.queryByRole('img', { name: /Line chart/ })).toBeNull();
  });
});

describe('run, parallel and stop', () => {
  it('starts a run on the demo, polls it to the end and shows the scores', async () => {
    const wf = seedWorkflow();
    await openList(wf.id);
    await userEvent.click(await screen.findByRole('button', { name: 'Run test' }));
    const table = await screen.findByRole('table', { name: 'Test runs' });
    await waitFor(() => expect(within(table).getByText('Completed')).toBeTruthy());
    const start = backend().requests.find((r) => r.path.endsWith('/test-runs/new'));
    expect(start?.body).toEqual({});
    expect(within(table).getByRole('columnheader', { name: 'score' })).toBeTruthy();
    expect(within(table).getByText('3 of 3')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Set up evaluations' })).toBeNull();
  });

  it('sends the parallel count above 1 and leaves it out at 1', async () => {
    const wf = seedWorkflow();
    await openList(wf.id);
    const slider = await screen.findByRole('slider', { name: 'Run in parallel' });
    expect(slider.getAttribute('max')).toBe('10');
    expect(screen.getByText('One at a time')).toBeTruthy();
    fireEvent.change(slider, { target: { value: '3' } });
    expect(screen.getByText('3 at once')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Run test' }));
    const stop = await screen.findByRole('button', { name: 'Stop test' });
    const start = backend().requests.find((r) => r.path.endsWith('/test-runs/new'));
    expect(start?.body).toEqual({ concurrency: 3 });
    // the slider is locked while a run goes
    expect((screen.getByRole('slider', { name: 'Run in parallel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.click(stop);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run test' })).toBeTruthy());
    expect(backend().requests.some((r) => /test-runs\/[^/]+\/cancel$/.test(r.path))).toBe(true);
  });

  it('stops a running run', async () => {
    const wf = seedWorkflow();
    const run = seedTestRun(
      backend(),
      wf.id,
      {
        status: 'running',
        completedAt: null,
        caseCounts: { new: 1, running: 1, success: 0, error: 0, cancelled: 0, total: 2 },
      },
      [
        { status: 'running', runIndex: 0 },
        { status: 'new', runIndex: 1, runAt: null, completedAt: null },
      ],
    );
    await openList(wf.id);
    await userEvent.click(await screen.findByRole('button', { name: 'Stop test' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run test' })).toBeTruthy());
    const table = screen.getByRole('table', { name: 'Test runs' });
    expect(within(table).getByText('Stopped')).toBeTruthy();
    const reply = await backend().handle({ method: 'GET', path: `/workflows/${wf.id}/test-runs/${run.id}` });
    expect((reply.body as { data: { status: string } }).data.status).toBe('cancelled');
  });

  it('shows the server text when the start fails', async () => {
    const wf = seedWorkflow([node('Manual', 'core.manualTrigger')], {});
    // the page blocks Run, so call the route the way a stale tab would
    const reply = await backend().handle({
      method: 'POST',
      path: `/workflows/${wf.id}/test-runs/new`,
      body: {},
    });
    expect(reply.status).toBe(409);
    expect((reply.body as { error: { message: string } }).error.message).toBe(
      'Workflow has no evaluation trigger',
    );
  });

  it('polls while a run goes', async () => {
    const wf = seedWorkflow();
    const run = seedTestRun(backend(), wf.id, {
      status: 'running',
      completedAt: null,
      caseCounts: { new: 0, running: 1, success: 0, error: 0, cancelled: 0, total: 1 },
    });
    await openList(wf.id);
    const table = await screen.findByRole('table', { name: 'Test runs' });
    expect(within(table).getByText('Running')).toBeTruthy();
    act(() =>
      updateTestRun(backend(), run.id, {
        status: 'completed',
        finalResult: 'success',
        metrics: { score: 1 },
      }),
    );
    await waitFor(() => expect(within(table).getByText('Completed')).toBeTruthy());
    expect(within(table).getByRole('columnheader', { name: 'score' })).toBeTruthy();
  });

  it('deletes a finished run after a confirmation and refuses a running one', async () => {
    const wf = seedWorkflow();
    const done = seedCompleted(wf.id, { score: 1 }, 5);
    await openList(wf.id);
    await userEvent.click(await screen.findByRole('button', { name: /^Delete run / }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete test run' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('table', { name: 'Test runs' })).toBeNull());
    expect(backend().requests.some((r) => r.method === 'DELETE' && r.path.endsWith(done.id))).toBe(true);

    const running = seedTestRun(backend(), wf.id, { status: 'running', completedAt: null });
    const reply = await backend().handle({
      method: 'DELETE',
      path: `/workflows/${wf.id}/test-runs/${running.id}`,
    });
    expect(reply.status).toBe(409);
  });
});

describe('run page', () => {
  const cases = [
    {
      status: 'success' as const,
      runIndex: 0,
      executionId: 'exec-1',
      inputs: { question: 'What is a webhook?' },
      outputs: { answer: 'A URL that receives events' },
      metrics: { correctness: 1 },
    },
    {
      status: 'error' as const,
      runIndex: 1,
      errorCode: 'NO_METRICS_COLLECTED' as const,
      inputs: { question: 'What is a trigger?' },
    },
    {
      status: 'error' as const,
      runIndex: 2,
      errorCode: 'INVALID_METRICS' as const,
      errorDetails: { message: 'score is not a number' },
    },
    {
      status: 'new' as const,
      runIndex: 3,
      runAt: null,
      completedAt: null,
      inputs: { question: 'What is a node?' },
    },
  ];

  function seedRunWithCases(status: 'running' | 'completed' = 'running') {
    const wf = seedWorkflow();
    const run = seedTestRun(
      backend(),
      wf.id,
      {
        status,
        completedAt: status === 'running' ? null : minutesAgo(1),
        finalResult: status === 'completed' ? 'error' : null,
        metrics: status === 'completed' ? { correctness: 1 } : null,
        concurrency: 2,
      },
      cases,
    );
    return { wf, run };
  }

  it('shows the totals, the cases, the execution link and the error texts', async () => {
    const { wf, run } = seedRunWithCases('completed');
    renderApp(`/workflow/${wf.id}/evaluations/${run.id}`);
    expect(await screen.findByRole('heading', { name: 'Evaluations' })).toBeTruthy();
    const totals = await screen.findByRole('region', { name: 'Totals' });
    const stat = (label: string) => within(totals).getByText(label).nextElementSibling?.textContent;
    expect(stat('Cases')).toBe('4');
    expect(stat('Succeeded')).toBe('1');
    expect(stat('Failed')).toBe('2');
    expect(stat('At once')).toBe('2 cases');
    expect(stat('correctness')).toBe('1');

    const table = await screen.findByRole('table', { name: 'Test cases' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).getByText('What is a webhook?')).toBeTruthy();
    expect(within(table).getByText('A URL that receives events')).toBeTruthy();
    expect(
      within(table).getByRole('link', { name: 'Open the execution of row 1' }).getAttribute('href'),
    ).toBe('/executions/exec-1');
    expect(within(table).getByText(TEST_CASE_ERROR_TEXTS.NO_METRICS_COLLECTED)).toBeTruthy();
    expect(within(table).getByText(TEST_CASE_ERROR_TEXTS.INVALID_METRICS)).toBeTruthy();
    expect(within(table).getByText('score is not a number')).toBeTruthy();
  });

  it('shows the error text of a run that failed as a whole', async () => {
    const wf = seedWorkflow();
    const run = seedTestRun(backend(), wf.id, { status: 'error', errorCode: 'SET_METRICS_NODE_NOT_FOUND' });
    renderApp(`/workflow/${wf.id}/evaluations/${run.id}`);
    expect(await screen.findByText(TEST_RUN_ERROR_TEXTS.SET_METRICS_NODE_NOT_FOUND)).toBeTruthy();
  });

  it('cancels a pending case and stops the run', async () => {
    const { wf, run } = seedRunWithCases('running');
    renderApp(`/workflow/${wf.id}/evaluations/${run.id}`);
    const table = await screen.findByRole('table', { name: 'Test cases' });
    // only the case that has not started can be cancelled
    expect(within(table).getAllByRole('button', { name: /^Cancel row / })).toHaveLength(1);
    await userEvent.click(within(table).getByRole('button', { name: 'Cancel row 4' }));
    await waitFor(() => expect(within(table).queryByRole('button', { name: /^Cancel row / })).toBeNull());
    expect(within(table).getAllByText('Stopped')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Stop test' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop test' })).toBeNull());
  });

  it('polls the run and its cases while it goes', async () => {
    const { wf, run } = seedRunWithCases('running');
    renderApp(`/workflow/${wf.id}/evaluations/${run.id}`);
    const table = await screen.findByRole('table', { name: 'Test cases' });
    expect(within(table).getByText('Pending')).toBeTruthy();
    act(() =>
      updateTestRun(
        backend(),
        run.id,
        { status: 'completed', finalResult: 'error' },
        { from: 'new', to: 'success' },
      ),
    );
    await waitFor(() => expect(screen.getByText('Finished with errors')).toBeTruthy());
    await waitFor(() => expect(within(table).queryByText('Pending')).toBeNull());
  });

  it('says so when the run does not exist', async () => {
    const wf = seedWorkflow();
    renderApp(`/workflow/${wf.id}/evaluations/missing-run`);
    expect(await screen.findByText("Couldn't load the test run")).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Evaluations' })).toBeTruthy();
  });
});

describe('viewer', () => {
  beforeEach(() => {
    for (const m of backend().memberships) m.role = 'viewer';
  });

  it('reads the list and cannot run, stop or delete', async () => {
    const wf = seedWorkflow();
    seedCompleted(wf.id, { score: 1 }, 5);
    await openList(wf.id);
    expect(await screen.findByRole('table', { name: 'Test runs' })).toBeTruthy();
    const reason = await screen.findByTestId('run-controls-reason');
    expect(reason.textContent).toContain('Viewers can read test runs');
    expect((screen.getByRole('button', { name: 'Run test' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('slider', { name: 'Run in parallel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: /^Delete run / })).toBeNull();
  });

  it('reads a run and cannot cancel a case', async () => {
    const wf = seedWorkflow();
    const run = seedTestRun(backend(), wf.id, { status: 'running', completedAt: null }, [
      { status: 'new', runIndex: 0, runAt: null, completedAt: null },
    ]);
    renderApp(`/workflow/${wf.id}/evaluations/${run.id}`);
    expect(await screen.findByRole('table', { name: 'Test cases' })).toBeTruthy();
    expect((await screen.findByTestId('run-read-only')).textContent).toContain('Viewers can read test runs');
    expect(screen.queryByRole('button', { name: /^Cancel row / })).toBeNull();
    expect((screen.getByRole('button', { name: 'Stop test' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('is refused by the routes too', async () => {
    const wf = seedWorkflow();
    const reply = await backend().handle({
      method: 'POST',
      path: `/workflows/${wf.id}/test-runs/new`,
      body: {},
    });
    expect(reply.status).toBe(403);
  });
});
