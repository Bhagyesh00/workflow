/**
 * P5-15 Settings > MCP: an admin turns MCP on and flips workflows; a viewer sees no switch and uses the key;
 * the key is shown once and rotates after a confirm; clients revoke after a confirm and a client name with
 * markup stays text; callback URLs are checked; "Available in MCP" saves in the workflow settings.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { WorkflowSettingsModal } from '../src/components/workflow/WorkflowSettingsModal';
import { mcpDemoState } from '../src/demo/mock-mcp';
import { backend, signedIn } from './backend';
import { server } from './setup';
import { renderApp, withProviders } from './utils';

afterEach(() => setCurrentTenant(null));

function as(role: 'viewer' | 'editor' | 'admin') {
  const mock = signedIn();
  mock.memberships[0].role = role;
  return mock;
}

function sent(method: string, path: string) {
  return backend().requests.filter((r) => r.method === method && r.path.split('?')[0] === path);
}

describe('Settings > MCP (P5-15)', () => {
  it('an admin turns MCP access on', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/mcp');
    const status = await screen.findByRole('switch', { name: 'MCP access' });
    expect(status.getAttribute('aria-checked')).toBe('false');
    await user.click(status);
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'MCP access' }).getAttribute('aria-checked')).toBe('true'),
    );
    expect(sent('PATCH', '/mcp/settings')[0].body).toEqual({ mcpAccessEnabled: true });
    expect([...mcpDemoState(backend()).settings.values()][0].mcpAccessEnabled).toBe(true);
  });

  it('auto expose saves on its own', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/mcp');
    await user.click(await screen.findByRole('switch', { name: 'Make new workflows available' }));
    await waitFor(() => expect(sent('PATCH', '/mcp/settings')).toHaveLength(1));
    expect(sent('PATCH', '/mcp/settings')[0].body).toEqual({ autoExposeNewWorkflows: true });
  });

  it('shows the status read only when the server environment sets it', async () => {
    signedIn();
    const state = mcpDemoState(backend());
    state.managedByEnv = true;
    renderApp('/settings/mcp');
    await screen.findByTestId('mcp-status');
    expect(screen.queryByRole('switch', { name: 'MCP access' })).toBeNull();
    expect(screen.getByText(/set by the server environment/)).toBeTruthy();
  });

  it('a viewer sees no switch and no tables, and can use the key', async () => {
    const user = userEvent.setup();
    as('viewer');
    renderApp('/settings/mcp');
    const status = await screen.findByTestId('mcp-status');
    expect(status.textContent).toBe('Off');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Workflows' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Connected clients' })).toBeNull();
    expect(sent('GET', '/mcp/workflows')).toHaveLength(0);
    expect(sent('GET', '/mcp/oauth-clients')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Connect/ }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('tab', { name: 'Access token' }));
    const key = await screen.findByLabelText('MCP key');
    expect(key.textContent).toMatch(/^wfk_[0-9a-f]{8}_[0-9a-f]{48}$/);
    expect(screen.getByText('Copy this key now')).toBeTruthy();
  });

  it('shows the key once and rotates it after a confirm', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/mcp');
    await user.click(await screen.findByRole('button', { name: /Connect/ }));
    await user.click(await screen.findByRole('tab', { name: 'Access token' }));
    const first = (await screen.findByLabelText('MCP key')).textContent;

    await user.click(screen.getByRole('button', { name: 'Rotate key' }));
    const dialogs = await screen.findAllByRole('dialog');
    expect(sent('POST', '/mcp/api-key/rotate')).toHaveLength(0);
    await user.click(within(dialogs[dialogs.length - 1]).getByRole('button', { name: 'Rotate key' }));
    await waitFor(() => expect(sent('POST', '/mcp/api-key/rotate')).toHaveLength(1));
    await waitFor(() => expect(screen.getByLabelText('MCP key').textContent).not.toBe(first));

    // closed and opened again: only the start of the key
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: /Connect/ }));
    await user.click(await screen.findByRole('tab', { name: 'Access token' }));
    const masked = await screen.findByLabelText('MCP key');
    expect(masked.textContent).toMatch(/^wfk_[0-9a-f]{8}_\.\.\.$/);
    expect(screen.queryByText('Copy this key now')).toBeNull();
  });

  it('the connect dialog gives the OAuth URL of the workspace on the MCP base URL', async () => {
    const user = userEvent.setup();
    const mock = signedIn();
    // MCP_BASE_URL is another host than the editor's
    mcpDemoState(backend()).mcpBaseUrl = 'https://mcp.example.com';
    renderApp('/settings/mcp');
    await user.click(await screen.findByRole('button', { name: /Connect/ }));
    const url = await screen.findByLabelText('Server URL');
    expect(url.textContent).toBe(`https://mcp.example.com/mcp-server/${mock.tenants[0].slug}/http`);
  });

  it('an admin flips one workflow and then all of them', async () => {
    const user = userEvent.setup();
    const mock = signedIn();
    mock.seedWorkflow({ name: 'Sync orders' });
    mock.seedWorkflow({ name: 'Send digest', settings: { availableInMCP: true } });
    renderApp('/settings/mcp');
    const row = await screen.findByRole('switch', { name: 'Available in MCP: Sync orders' });
    expect(row.getAttribute('aria-checked')).toBe('false');
    expect(
      screen.getByRole('switch', { name: 'Available in MCP: Send digest' }).getAttribute('aria-checked'),
    ).toBe('true');

    await user.click(row);
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Available in MCP: Sync orders' }).getAttribute('aria-checked'),
      ).toBe('true'),
    );
    expect(sent('PATCH', '/mcp/workflows/toggle-access')[0].body).toEqual({
      availableInMCP: true,
      workflowIds: [mock.workflows[0].id],
    });

    await user.click(screen.getByRole('button', { name: 'Hide all' }));
    expect(sent('PATCH', '/mcp/workflows/toggle-access')).toHaveLength(1);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Hide all' }));
    await waitFor(() => expect(sent('PATCH', '/mcp/workflows/toggle-access')).toHaveLength(2));
    expect(sent('PATCH', '/mcp/workflows/toggle-access')[1].body).toEqual({
      availableInMCP: false,
      allWorkflows: true,
    });
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Available in MCP: Send digest' }).getAttribute('aria-checked'),
      ).toBe('false'),
    );
  });

  it('an editor sees the workflows without switches or bulk buttons', async () => {
    as('editor');
    backend().seedWorkflow({ name: 'Sync orders', settings: { availableInMCP: true } });
    renderApp('/settings/mcp');
    expect(await screen.findByText('Sync orders')).toBeTruthy();
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: /Available in MCP/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make all available' })).toBeNull();
    expect(screen.queryByText('Connected clients')).toBeNull();
    expect(sent('GET', '/mcp/oauth-clients')).toHaveLength(0);
  });

  it('says so when a list fails and when there are none', async () => {
    signedIn();
    server.use(
      http.get('/rest/mcp/workflows', () =>
        HttpResponse.json({ error: { code: 'internal', message: 'down' } }, { status: 500 }),
      ),
    );
    renderApp('/settings/mcp');
    expect(await screen.findByText("Couldn't load the workflows")).toBeTruthy();
    expect(await screen.findByText('No clients yet')).toBeTruthy();
  });

  it('revokes a client after a confirm and shows a name with markup as text', async () => {
    const user = userEvent.setup();
    signedIn();
    const state = mcpDemoState(backend());
    state.clients.push({
      id: 'client-1',
      name: '<img src=x onerror="alert(1)"> Evil client',
      redirectUris: ['https://client.example.com/callback'],
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    const { container } = renderApp('/settings/mcp');
    const label = '<img src=x onerror="alert(1)"> Evil client';
    expect(await screen.findByText(label)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('mcp-client-count').textContent).toBe('1 of 5000 registered');

    await user.click(screen.getByRole('button', { name: `Revoke ${label}` }));
    const dialog = await screen.findByRole('dialog');
    expect(sent('DELETE', '/mcp/oauth-clients/client-1')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke access' }));
    await waitFor(() => expect(sent('DELETE', '/mcp/oauth-clients/client-1')).toHaveLength(1));
    expect(await screen.findByText('No clients yet')).toBeTruthy();
    expect(state.clients).toHaveLength(0);
  });

  it('keeps a client when the revoke is cancelled', async () => {
    const user = userEvent.setup();
    signedIn();
    mcpDemoState(backend()).clients.push({
      id: 'c2',
      name: 'Keeper',
      redirectUris: [],
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    renderApp('/settings/mcp');
    await user.click(await screen.findByRole('button', { name: 'Revoke Keeper' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent('DELETE', '/mcp/oauth-clients/c2')).toHaveLength(0);
    expect(screen.getByText('Keeper')).toBeTruthy();
  });

  it('saves callback URLs and refuses a bad one before sending', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/mcp');
    const box = await screen.findByLabelText('Allowed callback URLs');
    const save = screen.getByRole('button', { name: 'Save callback URLs' });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await user.type(box, 'javascript:alert(1)');
    expect(screen.getByText(/This redirect URI scheme is not allowed/)).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(sent('PATCH', '/mcp/oauth/allowed-redirect-uris')).toHaveLength(0);

    await user.clear(box);
    await user.type(box, 'https://client.example.com/cb#frag');
    expect(screen.getByText(/must not have a fragment/)).toBeTruthy();

    await user.clear(box);
    await user.type(box, 'https://client.example.com/cb');
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(sent('PATCH', '/mcp/oauth/allowed-redirect-uris')).toHaveLength(1));
    expect(sent('PATCH', '/mcp/oauth/allowed-redirect-uris')[0].body).toEqual({
      allowedRedirectUris: ['https://client.example.com/cb'],
    });
    expect(mcpDemoState(backend()).allowedRedirectUris).toEqual(['https://client.example.com/cb']);
  });

  it('says why the page cannot load', async () => {
    signedIn();
    server.use(
      http.get('/rest/mcp/settings', () =>
        HttpResponse.json({ error: { code: 'internal', message: 'down' } }, { status: 500 }),
      ),
    );
    renderApp('/settings/mcp');
    expect(await screen.findByText("Couldn't load the MCP settings")).toBeTruthy();
  });
});

describe('Workflow settings: Available in MCP (P5-15)', () => {
  it('saves the flag with the other workflow settings', async () => {
    const user = userEvent.setup();
    signedIn();
    const onSave = vi.fn();
    withProviders(
      <WorkflowSettingsModal
        open
        onClose={() => undefined}
        value={{}}
        workflowId="w1"
        onSave={onSave}
        readOnly={false}
      />,
    );
    const toggle = await screen.findByRole('switch', { name: 'Available in MCP' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Apply settings' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ availableInMCP: true });
  });

  it('shows the saved flag and is locked when the workflow is read only', async () => {
    signedIn();
    withProviders(
      <WorkflowSettingsModal
        open
        onClose={() => undefined}
        value={{ availableInMCP: true }}
        workflowId="w1"
        onSave={() => undefined}
        readOnly
      />,
    );
    const toggle = (await screen.findByRole('switch', { name: 'Available in MCP' })) as HTMLButtonElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.disabled).toBe(true);
  });
});
