import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../src/api/types';
import { ErrorPanel } from '../src/components/ndv/DataPanes';
import { useWorkflowStore } from '../src/stores/workflow-store';
import { backend, signedIn } from './backend';
import { renderApp, withProviders } from './utils';

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

async function waitForExecutions(count: number) {
  await waitFor(() => expect(backend().executions.filter((e) => e.status !== 'running')).toHaveLength(count));
}

describe('credentials', () => {
  it('creates a credential from the type picker', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/credentials');
    await user.click(await screen.findByRole('button', { name: 'Add credential' }, { timeout: 5000 }));
    await user.click(await screen.findByRole('button', { name: /Acme CRM API/ }));
    const dialog = await screen.findByRole('dialog', { name: /New Acme CRM API/ });
    await user.type(within(dialog).getByLabelText('API key'), 'secret-123');
    await user.click(within(dialog).getByRole('button', { name: 'Test connection' }));
    expect(await within(dialog).findByText('Connection works')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(backend().credentials).toHaveLength(1));
    expect(backend().credentials[0]).toMatchObject({
      type: 'crmApi',
      data: { apiKey: 'secret-123', region: 'eu' },
    });
    expect((await screen.findAllByText('Acme CRM API account')).length).toBeGreaterThan(0);
  });

  it('keeps a stored secret when the redacted field is left alone', async () => {
    const user = userEvent.setup();
    signedIn();
    const tenantId = backend().session!.tenantId;
    backend().credentials.push({
      id: 'cred-1',
      tenantId,
      name: 'Prod CRM',
      type: 'crmApi',
      data: { apiKey: 'top-secret', region: 'us' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    renderApp('/credentials');
    await user.click(await screen.findByRole('button', { name: /^Prod CRM/ }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit credential' });
    const secret = await within(dialog).findByLabelText('API key');
    expect((secret as HTMLInputElement).value).toBe('');
    expect(secret.getAttribute('placeholder')).toBe('Saved. Type to replace it.');
    expect(document.body.textContent).not.toContain('top-secret');
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Production CRM');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(backend().credentials[0].name).toBe('Production CRM'));
    const patch = backend().requests.find((r) => r.method === 'PATCH' && r.path === '/credentials/cred-1')!;
    expect((patch.body as { data: Record<string, unknown> }).data.apiKey).toBe(REDACTED);
    expect(backend().credentials[0].data.apiKey).toBe('top-secret');
  });
});

describe('settings', () => {
  it('shows a new API key exactly once', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/api-keys');
    await user.type(await screen.findByLabelText('New key name', {}, { timeout: 5000 }), 'CI');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    const key = await screen.findByTestId('new-api-key');
    expect(key.textContent).toMatch(/^wfk_[0-9a-f]{8}_[0-9a-f]+$/);
    await user.click(screen.getByRole('button', { name: 'I copied it' }));
    await waitFor(() => expect(screen.queryByTestId('new-api-key')).toBeNull());
    expect(await screen.findByText('CI')).toBeTruthy();
    expect(document.body.textContent).not.toContain(key.textContent ?? '');
  });

  it('creates variables and invites members', async () => {
    const user = userEvent.setup();
    signedIn();
    const { router } = renderApp('/settings/variables');
    await user.type(await screen.findByLabelText('Key', {}, { timeout: 5000 }), 'region');
    await user.type(screen.getByLabelText('Value'), 'eu');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(backend().variables.map((v) => [v.key, v.value])).toEqual([['region', 'eu']]));

    await act(async () => {
      await router.navigate('/settings/members');
    });
    await user.click(await screen.findByRole('button', { name: 'Invite' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a member' });
    await user.type(within(dialog).getByLabelText('Email'), 'new@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }));
    expect(await within(dialog).findByText(/\/invitation\//)).toBeTruthy();
    expect(backend().invitations[0]).toMatchObject({ email: 'new@example.com', role: 'member' });
  });
});

describe('executions', () => {
  it('lists runs, shows a failed run read-only with its error and retries it', async () => {
    const user = userEvent.setup();
    signedIn();
    const wf = backend().seedWorkflow({
      name: 'Caller',
      nodes: [trigger, call],
      connections: { Start: { main: [[{ node: 'Call', type: 'main', index: 0 }]] } },
    });
    await backend().handle({ method: 'POST', path: `/workflows/${wf.id}/run`, body: {} });
    await waitForExecutions(1);

    const { router } = renderApp('/executions');
    const link = await screen.findByRole('link', { name: 'Caller' }, { timeout: 5000 });
    expect(within(screen.getByRole('table')).getByText('Failed')).toBeTruthy();
    await user.click(link);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/executions\/./));
    expect(await screen.findByText('Call: The URL parameter is empty', {}, { timeout: 5000 })).toBeTruthy();
    expect(useWorkflowStore.getState().readOnly).toBe(true);
    await waitFor(() => expect(document.querySelector('[data-id="c"] [title="Failed"]')).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Retry from failed node' }));
    await user.click(screen.getByRole('menuitem', { name: 'With the current saved workflow' }));
    await waitFor(() => expect(backend().executions.filter((e) => e.mode === 'retry')).toHaveLength(1));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/executions/${backend().executions[0].id}`),
    );
  });

  it('opens failed node details with the structured error', () => {
    // the app always has a QueryClient; the error panel reads the builder feature and the role (P5-65)
    withProviders(
      <ErrorPanel
        error={{
          name: 'NodeApiError',
          message: 'The service refused the request',
          code: 'HTTP_401',
          hint: 'Check that the API key is still valid.',
          itemIndex: 2,
          parameter: 'url',
          request: { method: 'GET', url: 'https://api.example.com/orders' },
          response: { statusCode: 401, body: '{"error":"unauthorized"}' },
        }}
      />,
    );
    expect(screen.getByText('HTTP_401')).toBeTruthy();
    expect(screen.getByText('Check that the API key is still valid.')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('GET https://api.example.com/orders')).toBeTruthy();
    expect(screen.getByText('401')).toBeTruthy();
  });
});

describe('version history', () => {
  it('previews what a restore changes and restores it', async () => {
    const user = userEvent.setup();
    signedIn();
    const wf = backend().seedWorkflow({ name: 'Versioned', nodes: [trigger], connections: {} });
    // a later save adds a node
    await backend().handle({
      method: 'PATCH',
      path: `/workflows/${wf.id}`,
      body: { versionId: wf.versionId, nodes: [trigger, call], connections: {} },
    });
    renderApp(`/workflow/${wf.id}`);
    await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 5000 });
    await user.click(screen.getByRole('button', { name: 'Version history' }));
    const versions = await screen.findAllByRole('button', { name: /Demo user|Olive Owner/ });
    await user.click(versions[versions.length - 1]);
    const dialog = await screen.findByRole('dialog', { name: 'Version preview' });
    const changes = await within(dialog).findByRole('list', { name: 'Changes if restored' });
    expect(changes.textContent).toContain('Removes Call');
    await user.click(within(dialog).getByRole('button', { name: 'Restore this version' }));
    await waitFor(() => expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['Start']));
  });
});

describe('roles', () => {
  it('opens workflows read-only for viewers', async () => {
    signedIn();
    const wf = backend().seedWorkflow({ name: 'Look only', nodes: [trigger], connections: {} });
    backend().setDemoRole('viewer');
    renderApp(`/workflow/${wf.id}`);
    const name = await screen.findByRole('textbox', { name: 'Workflow name' }, { timeout: 5000 });
    await waitFor(() => expect(useWorkflowStore.getState().readOnly).toBe(true));
    expect(name.hasAttribute('readonly')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add node' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(useWorkflowStore.getState().nodes).toHaveLength(1);
  });
});
