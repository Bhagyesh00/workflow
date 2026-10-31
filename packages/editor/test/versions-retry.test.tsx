import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
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
const call: WorkflowNode = {
  id: 'c',
  name: 'Call',
  type: 'core.httpRequest',
  typeVersion: 1,
  position: [300, 0],
  parameters: { url: '' },
};
const wiring = { Start: { main: [[{ node: 'Call', type: 'main' as const, index: 0 }]] } };

async function failedExecution() {
  const wf = backend().seedWorkflow({ name: 'Caller', nodes: [trigger, call], connections: wiring });
  await backend().handle({ method: 'POST', path: `/workflows/${wf.id}/run`, body: {} });
  await waitFor(() => expect(backend().executions.filter((e) => e.status !== 'running')).toHaveLength(1));
  return { wf, execution: backend().executions[0] };
}

describe('execution detail retry', () => {
  it('shows the error code and hint and retries from the failed node on the original workflow', async () => {
    const user = userEvent.setup();
    signedIn();
    const { execution } = await failedExecution();
    execution.state.resultData.error = {
      name: 'NodeApiError',
      message: 'The service refused the request',
      node: 'Call',
      code: 'HTTP_401',
      hint: 'Check that the API key is still valid.',
    };
    renderApp(`/executions/${execution.id}`);
    expect(await screen.findByText('HTTP_401', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('Check that the API key is still valid.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Retry from failed node' }));
    await user.click(screen.getByRole('menuitem', { name: 'With the workflow as it ran' }));
    await waitFor(() => expect(backend().executions.filter((e) => e.mode === 'retry')).toHaveLength(1));
    const retried = backend().requests.filter((r) => r.path === `/executions/${execution.id}/retry`);
    expect(retried[0].body).toEqual({ useCurrentWorkflow: false });
  });

  it('offers Retry for a stopped execution that names no failed node', async () => {
    const user = userEvent.setup();
    signedIn();
    const { execution } = await failedExecution();
    execution.status = 'canceled';
    execution.errorMessage = null;
    execution.state.resultData.error = undefined;
    delete execution.state.executionData.failedExecuteData;
    renderApp(`/executions/${execution.id}`);
    await user.click(await screen.findByRole('button', { name: 'Retry' }, { timeout: 5000 }));
    expect(screen.getByRole('menuitem', { name: 'With the current saved workflow' })).toBeTruthy();
  });

  it('hides Retry for a successful execution', async () => {
    signedIn();
    const { execution } = await failedExecution();
    execution.status = 'success';
    renderApp(`/executions/${execution.id}`);
    await screen.findByText('Open workflow', {}, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: /^Retry/ })).toBeNull();
  });
});

describe('version history', () => {
  it('pages through every version, not only the newest 50', async () => {
    const user = userEvent.setup();
    signedIn();
    const wf = backend().seedWorkflow({ name: 'Busy', nodes: [trigger], connections: {} });
    const snapshot = { name: 'Busy', nodes: [trigger], connections: {}, settings: {} };
    backend().versions.length = 0;
    for (let i = 0; i < 120; i++) {
      backend().versions.push({
        versionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        workflowId: wf.id,
        authorName: `Author ${i}`,
        message: null,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 120 - i)).toISOString(),
        snapshot,
      });
    }
    renderApp(`/workflow/${wf.id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 5000 });
    await user.click(screen.getByRole('button', { name: 'Version history' }));
    const panel = await screen.findByRole('complementary', { name: 'Version history' });
    await within(panel).findByText('Author 0', {}, { timeout: 5000 });
    expect(within(panel).getAllByRole('listitem')).toHaveLength(50);
    expect(within(panel).queryByText('Author 50')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: 'Load more' }));
    await within(panel).findByText('Author 50');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(100);
    await user.click(within(panel).getByRole('button', { name: 'Load more' }));
    await within(panel).findByText('Author 119');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(120);
    expect(within(panel).queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('lists the restored version at once after a restore', async () => {
    const user = userEvent.setup();
    signedIn();
    const wf = backend().seedWorkflow({ name: 'Versioned', nodes: [trigger], connections: {} });
    await backend().handle({
      method: 'PATCH',
      path: `/workflows/${wf.id}`,
      body: { versionId: wf.versionId, nodes: [trigger, call], connections: wiring },
    });
    renderApp(`/workflow/${wf.id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 5000 });
    await user.click(screen.getByRole('button', { name: 'Version history' }));
    const panel = await screen.findByRole('complementary', { name: 'Version history' });
    const before = (await within(panel).findAllByRole('listitem')).length;
    const items = within(panel).getAllByRole('button', { name: /Demo user|Olive Owner/ });
    await user.click(items[items.length - 1]);
    const dialog = await screen.findByRole('dialog', { name: 'Version preview' });
    await user.click(await within(dialog).findByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(within(panel).getAllByRole('listitem')).toHaveLength(before + 1));
  });
});
