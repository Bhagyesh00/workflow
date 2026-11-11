/**
 * P6-76 (L6): Settings > Environments (Classic) and the sidebar's Git block, on the demo backend: connect over
 * HTTPS and SSH, the connected block (branch, protected switch, colour, Save, Disconnect with a confirm), a
 * member who sees no Environments link, the protected switch reaching `useProtectedWorkspace`, and the sidebar
 * buttons with n8n's disable rules.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../src/api/queries';
import { SidebarSourceControl } from '../src/components/source-control/SidebarSourceControl';
import { useProtectedWorkspace } from '../src/lib/protected';
import { backend, signedIn } from './backend';
import { renderApp, testQueryClient, withProviders } from './utils';

const T = { timeout: 20_000 };
const URL_HTTPS = 'https://git.example.test/team/flows.git';

type Answer = { data?: any; error?: { code: string; message: string } };

async function call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) {
  const res = await backend().handle({ method, path, body });
  return { status: res.status, body: res.body as Answer };
}

async function connectHttps() {
  const res = await call('POST', '/source-control/preferences', {
    connectionType: 'https',
    repositoryUrl: URL_HTTPS,
    httpsUsername: 'bot',
    httpsPassword: 'tok-secret-1',
  });
  expect(res.status).toBe(200);
}

function Probe() {
  return <p>{useProtectedWorkspace() ? 'protected' : 'writable'}</p>;
}

afterEach(() => vi.restoreAllMocks());

describe('Settings > Environments (Classic)', () => {
  it('an admin connects over HTTPS with a write-only token and sees the connected block', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/environments');
    expect(await screen.findByRole('heading', { name: 'Environments (Classic)' }, T)).toBeTruthy();
    await user.selectOptions(await screen.findByLabelText('Connection type', {}, T), 'https');
    await user.type(screen.getByLabelText('Repository URL'), URL_HTTPS);
    await user.type(screen.getByLabelText('Username'), 'bot');
    const token = screen.getByLabelText('Access token') as HTMLInputElement;
    expect(token.type).toBe('password');
    await user.type(token, 'tok-secret-1');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    // connected: the branch picker lists the remote's branches, the token is gone from the page
    const branch = (await screen.findByLabelText('Branch', {}, T)) as HTMLSelectElement;
    expect(within(branch).getByRole('option', { name: 'production' })).toBeTruthy();
    expect(screen.queryByLabelText('Access token')).toBeNull();
    expect(document.body.textContent).not.toContain('tok-secret-1');
    const sent = backend().requests.find(
      (r) => r.method === 'POST' && r.path === '/source-control/preferences',
    );
    expect(sent?.body).toMatchObject({
      connectionType: 'https',
      repositoryUrl: URL_HTTPS,
      httpsPassword: 'tok-secret-1',
    });
    expect((await call('GET', '/source-control/preferences')).body.data.connected).toBe(true);
  });

  it('a plain http:// remote connects without a token and the token is never sent there', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/environments');
    await user.selectOptions(await screen.findByLabelText('Connection type', {}, T), 'https');
    await user.type(screen.getByLabelText('Repository URL'), 'http://127.0.0.1:9418/repo.git');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByLabelText('Branch', {}, T)).toBeTruthy();
    const sent = backend().requests.find(
      (r) => r.method === 'POST' && r.path === '/source-control/preferences',
    );
    expect(sent?.body).not.toHaveProperty('httpsPassword');
    // with a token typed, the server refuses plain http
    await call('POST', '/source-control/disconnect', {});
    const refused = await call('POST', '/source-control/preferences', {
      connectionType: 'https',
      repositoryUrl: 'http://127.0.0.1:9418/repo.git',
      httpsPassword: 'tok-secret-1',
    });
    expect(refused.status).toBe(400);
  });

  it('SSH shows the public key with Copy and Regenerate (a confirm first)', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/environments');
    const key = (await screen.findByLabelText('Public key', {}, T)) as HTMLTextAreaElement;
    const before = key.value;
    expect(before).toMatch(/^ssh-/);
    expect(screen.getByRole('button', { name: 'Copy public key' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Regenerate key' }));
    await user.click(await screen.findByRole('button', { name: 'Regenerate' }));
    await waitFor(
      () => expect((screen.getByLabelText('Public key') as HTMLTextAreaElement).value).not.toBe(before),
      T,
    );
  });

  it('a bad repository URL shows the server error and stays on the form', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/environments');
    await user.type(await screen.findByLabelText('Repository URL', {}, T), 'ext::sh -c evil');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert', {}, T)).toBeTruthy();
    expect(screen.queryByLabelText('Branch')).toBeNull();
  });

  it('Save sends the branch, colour and protected switch; the switch makes useProtectedWorkspace true', async () => {
    signedIn();
    await connectHttps();
    const user = userEvent.setup();
    const { queryClient } = renderApp('/settings/environments');
    await user.selectOptions(await screen.findByLabelText('Branch', {}, T), 'production');
    await user.click(screen.getByRole('switch', { name: 'Protected workspace' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(backend().isDemoProtected()).toBe(true), T);
    const patch = backend().requests.find(
      (r) => r.method === 'PATCH' && r.path === '/source-control/preferences',
    );
    expect(patch?.body).toMatchObject({ branchName: 'production', branchReadOnly: true });
    // the settings refetch makes the hook true and the sidebar's Push button disabled
    const probe = withProviders(<Probe />, queryClient);
    expect(await screen.findByText('protected', {}, T)).toBeTruthy();
    probe.unmount();
    const push = await screen.findByRole('button', { name: 'Push' }, T);
    await waitFor(() => expect((push as HTMLButtonElement).disabled).toBe(true), T);
  });

  it('Disconnect asks first, then the form is back and the protected switch is cleared', async () => {
    signedIn();
    await connectHttps();
    await call('PATCH', '/source-control/preferences', { branchReadOnly: true });
    expect(backend().isDemoProtected()).toBe(true);
    const user = userEvent.setup();
    renderApp('/settings/environments');
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }, T));
    // nothing sent before the confirm
    expect(backend().requests.some((r) => r.path === '/source-control/disconnect')).toBe(false);
    const confirm = await screen.findByRole('dialog', { name: /Disconnect/ }, T);
    await user.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('button', { name: 'Connect' }, T)).toBeTruthy();
    expect(backend().isDemoProtected()).toBe(false);
  });

  it('a member sees no Environments link and the page says who can use it', async () => {
    signedIn().setDemoRole('member');
    renderApp('/settings/environments');
    await screen.findByRole('link', { name: 'API keys' }, T);
    expect(screen.queryByRole('link', { name: 'Environments' })).toBeNull();
    expect(await screen.findByText(/Only admins can manage environments/, {}, T)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });
});

describe('sidebar Git block', () => {
  it('is hidden while the workspace is not connected', async () => {
    signedIn();
    withProviders(<SidebarSourceControl collapsed={false} />);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('button', { name: 'Pull' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Push' })).toBeNull();
  });

  it('shows the branch with Pull and Push; Push is off on a protected workspace, Pull stays', async () => {
    const demo = signedIn();
    await connectHttps();
    const queryClient = testQueryClient();
    withProviders(<SidebarSourceControl collapsed={false} />, queryClient);
    expect(await screen.findByText('main', {}, T)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Push' }) as HTMLButtonElement).disabled).toBe(false);
    demo.setDemoProtected(true);
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.settings }));
    await waitFor(
      () => expect((screen.getByRole('button', { name: 'Push' }) as HTMLButtonElement).disabled).toBe(true),
      T,
    );
    expect((screen.getByRole('button', { name: 'Pull' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('collapsed to icons, the buttons keep their names', async () => {
    signedIn();
    await connectHttps();
    withProviders(<SidebarSourceControl collapsed />);
    expect(await screen.findByRole('button', { name: 'Pull' }, T)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Push' })).toBeTruthy();
  });

  it('opens the Push modal from the sidebar', async () => {
    signedIn();
    await connectHttps();
    const user = userEvent.setup();
    withProviders(<SidebarSourceControl collapsed={false} />);
    await user.click(await screen.findByRole('button', { name: 'Push' }, T));
    expect(await screen.findByRole('dialog', { name: 'Push to Git' }, T)).toBeTruthy();
  });
});
