import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { secretsApi } from '../src/api/endpoints';
import { REDACTED } from '../src/api/types';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

afterEach(() => setCurrentTenant(null));

async function seed(
  settings: Record<string, unknown> = { url: 'https://vault.example.com/v1/', token: 'tok-1' },
) {
  const mock = signedIn();
  setCurrentTenant(mock.session!.tenantId);
  await secretsApi.createConnection({ providerKey: 'vault', type: 'vault', settings });
  return mock;
}

describe('secrets settings page (P4-07)', () => {
  it('shows an empty state without connections', async () => {
    signedIn();
    renderApp('/settings/external-secrets');
    expect(await screen.findByText('No connections yet')).toBeTruthy();
  });

  it('adds a connection from the type form; it starts off and never shows the secret', async () => {
    const user = userEvent.setup();
    const mock = signedIn();
    renderApp('/settings/external-secrets');
    await user.click(await screen.findByRole('button', { name: 'Add connection' }));
    await user.type(await screen.findByLabelText('Connection name'), 'my vault');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Use letters and numbers only, starting with a letter')).toBeTruthy();
    await user.clear(screen.getByLabelText('Connection name'));
    await user.type(screen.getByLabelText('Connection name'), 'vault');
    await user.type(screen.getByLabelText(/Vault URL/), 'https://vault.example.com/v1/');
    await user.type(screen.getByLabelText(/^Token/), 'tok-secret');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const card = await screen.findByTestId('secret-card-vault');
    expect(within(card).getByTestId('secret-state').textContent).toBe('Off');
    const post = mock.requests.find((r) => r.method === 'POST' && r.path === '/secret-providers/connections');
    expect(post?.body).toMatchObject({ providerKey: 'vault', type: 'vault' });
    // the list answer blanks the token
    setCurrentTenant(mock.session!.tenantId);
    const list = await secretsApi.connections();
    expect(list[0].settings.token).toBe(REDACTED);
    expect(document.body.textContent).not.toContain('tok-secret');
  });

  it('turns a connection on and shows its state and secret count', async () => {
    const user = userEvent.setup();
    await seed();
    renderApp('/settings/external-secrets');
    const card = await screen.findByTestId('secret-card-vault');
    await user.click(within(card).getByRole('switch', { name: 'vault enabled' }));
    await waitFor(() => expect(within(card).getByTestId('secret-state').textContent).toBe('Connected'));
    expect(card.textContent).toContain('3 secrets');
  });

  it('shows the fixed error text of a failed connect, and a failed test', async () => {
    const user = userEvent.setup();
    await seed({ url: 'https://invalid.example.com', token: 'x' });
    renderApp('/settings/external-secrets');
    const card = await screen.findByTestId('secret-card-vault');
    await user.click(within(card).getByRole('switch', { name: 'vault enabled' }));
    expect(await within(card).findByText("Couldn't connect to the provider")).toBeTruthy();
    expect(within(card).getByTestId('secret-state').textContent).toBe('Error');
    await user.click(within(card).getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Connection failed')).toBeTruthy();
  });

  it('edits a connection and keeps the stored secret when it is left blank', async () => {
    const user = userEvent.setup();
    const mock = await seed();
    renderApp('/settings/external-secrets');
    const card = await screen.findByTestId('secret-card-vault');
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const url = await screen.findByLabelText(/Vault URL/);
    await user.clear(url);
    await user.type(url, 'https://other.example.com/v1/');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mock.requests.some((r) => r.method === 'PATCH')).toBe(true));
    const patch = mock.requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      settings: { url: 'https://other.example.com/v1/', token: REDACTED },
    });
    const stored = (backend().ext.secrets as { connections: Array<{ settings: Record<string, unknown> }> })
      .connections[0];
    expect(stored.settings.token).toBe('tok-1');
  });

  it('asks before deleting and names how many credentials use the connection', async () => {
    const user = userEvent.setup();
    const mock = await seed();
    const now = new Date().toISOString();
    mock.credentials.push({
      id: 'c1',
      tenantId: mock.session!.tenantId,
      name: 'Uses vault',
      type: 'httpHeaderAuth',
      data: { value: '={{ $secrets.vault.apiKey }}' },
      createdAt: now,
      updatedAt: now,
    });
    renderApp('/settings/external-secrets');
    const card = await screen.findByTestId('secret-card-vault');
    await user.click(within(card).getByRole('button', { name: 'Delete vault' }));
    expect(await screen.findByText(/1 credential uses this connection/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByTestId('secret-card-vault')).toBeNull());
    expect(await secretsApi.connections()).toEqual([]);
  });

  it('is for admins: an editor sees a notice and no request for connections', async () => {
    const mock = signedIn();
    mock.setDemoRole('editor');
    renderApp('/settings/external-secrets');
    expect(await screen.findByText('Only admins can manage external secrets.')).toBeTruthy();
    expect(mock.requests.some((r) => r.path === '/secret-providers/connections')).toBe(false);
  });
});
