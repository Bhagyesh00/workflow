/**
 * P6-12 (L10): Settings > LDAP. The page shows n8n's defaults, saves the connection (the bind password is
 * blank on read and kept on a blank save), warns about no security and unchecked certificates, tests the
 * connection, runs a dry run and a live sync and lists the history. The run buttons need `ldap:sync`; the demo
 * routes answer the server's codes and texts.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DEMO_LDAP_PEOPLE } from '../src/demo/mock-ldap';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

async function call(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown) {
  const res = await backend().handle({ method, path, body });
  return { status: res.status, body: res.body as { data?: any; error?: { code: string; message: string } } };
}

const CONFIG = {
  connectionUrl: 'ldap.example.com',
  baseDn: 'dc=example,dc=com',
  bindingAdminDn: 'cn=admin,dc=example,dc=com',
  bindingAdminPassword: 'admin-secret',
  emailAttribute: 'mail',
  loginIdAttribute: 'uid',
  ldapIdAttribute: 'entryUUID',
};

describe('LDAP settings page', () => {
  it('shows the defaults, warns about no security and lets nothing run before a connection is saved', async () => {
    signedIn();
    renderApp('/settings/ldap');
    expect(await screen.findByRole('heading', { name: 'LDAP sign-in' }, T)).toBeTruthy();
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('389');
    expect((screen.getByLabelText('Connection security') as HTMLSelectElement).value).toBe('none');
    expect((screen.getByLabelText('Sync interval (minutes)') as HTMLInputElement).value).toBe('60');
    expect((screen.getByLabelText('Search timeout (seconds)') as HTMLInputElement).value).toBe('60');
    expect(screen.getByText(/passwords cross the network in the clear/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Dry run' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(await screen.findByText('No syncs yet', undefined, T)).toBeTruthy();
  });

  it('saves the connection, blanks the password and keeps it on a later save', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/ldap');
    await screen.findByRole('heading', { name: 'LDAP sign-in' }, T);
    await user.type(screen.getByLabelText('Server address'), CONFIG.connectionUrl);
    await user.type(screen.getByLabelText('Base DN'), CONFIG.baseDn);
    await user.type(screen.getByLabelText('Admin DN'), CONFIG.bindingAdminDn);
    await user.type(screen.getByLabelText('Admin password'), CONFIG.bindingAdminPassword);
    await user.type(screen.getByLabelText('Login ID attribute'), CONFIG.loginIdAttribute);
    await user.type(screen.getByLabelText('LDAP ID attribute'), CONFIG.ldapIdAttribute);
    await user.type(screen.getByLabelText('Email attribute'), CONFIG.emailAttribute);
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(
      () => expect((screen.getByLabelText('Admin password') as HTMLInputElement).value).toBe(''),
      T,
    );
    const sent = backend()
      .requests.filter((r) => r.path === '/ldap/config' && r.method === 'PUT')
      .at(-1);
    expect(sent?.body).toMatchObject({
      connectionUrl: 'ldap.example.com',
      bindingAdminPassword: 'admin-secret',
    });
    expect((await call('GET', '/ldap/config')).body.data.bindingAdminPassword).toBe('');
    // a save without a new password does not send one
    await user.clear(screen.getByLabelText('Login button label'));
    await user.type(screen.getByLabelText('Login button label'), 'Directory');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => {
      const last = backend()
        .requests.filter((r) => r.path === '/ldap/config' && r.method === 'PUT')
        .at(-1);
      expect(last?.body).toMatchObject({ loginLabel: 'Directory' });
      expect(last?.body).not.toHaveProperty('bindingAdminPassword');
    }, T);
    expect((await call('GET', '/ldap/config')).body.data).toMatchObject({ loginLabel: 'Directory' });
  });

  it('follows the security choice with the usual port and warns about unchecked certificates', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/ldap');
    await screen.findByRole('heading', { name: 'LDAP sign-in' }, T);
    await user.selectOptions(screen.getByLabelText('Connection security'), 'tls');
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('636');
    expect(screen.queryByText(/passwords cross the network in the clear/)).toBeNull();
    await user.selectOptions(screen.getByLabelText('Connection security'), 'startTls');
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('389');
    expect(screen.queryByText(/certificate is not checked/)).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: "Allow certificates that can't be verified" }));
    expect(await screen.findByText(/certificate is not checked/)).toBeTruthy();
  });

  it('shows the server refusal on a bad save', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/ldap');
    await screen.findByRole('heading', { name: 'LDAP sign-in' }, T);
    await user.type(screen.getByLabelText('Server address'), 'ldap://ldap.example.com');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/Invalid LDAP settings: connectionUrl/, undefined, T)).toBeTruthy();
    expect((await call('GET', '/ldap/config')).body.data.connectionUrl).toBe('');
  });

  it('tests the connection, runs a dry run and a live sync, and lists the history newest first', async () => {
    const user = userEvent.setup();
    signedIn();
    expect((await call('PUT', '/ldap/config', CONFIG)).status).toBe(200);
    renderApp('/settings/ldap');
    await screen.findByRole('heading', { name: 'LDAP sign-in' }, T);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection works', undefined, T)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Dry run' }));
    const table = await screen.findByRole('table', undefined, T);
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2), T);
    expect(within(table).getByText('Dry run')).toBeTruthy();
    // a dry run created nobody: the live run still creates all of them
    await user.click(screen.getByRole('button', { name: 'Run sync' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3), T);
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]).getByText('Live')).toBeTruthy();
    expect(within(rows[1]).getAllByRole('cell')[4].textContent).toBe(String(DEMO_LDAP_PEOPLE.length));
    expect(within(rows[2]).getByText('Dry run')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Run sync' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4), T);
    expect(within(within(table).getAllByRole('row')[1]).getAllByRole('cell')[4].textContent).toBe('0');
  });

  it('shows a member who opens the LDAP page the no-access text and sends no config request (ui-5)', async () => {
    signedIn();
    backend().setDemoRole('member');
    renderApp('/settings/ldap');
    expect(await screen.findByText(/don't have access to the LDAP settings/, undefined, T)).toBeTruthy();
    expect(screen.queryByLabelText('Server address')).toBeNull();
    expect(screen.queryByText(/missing a scope/)).toBeNull();
    expect(backend().requests.some((r) => r.path === '/ldap/config')).toBe(false);
  });

  it('disables running and testing while there are unsaved changes', async () => {
    const user = userEvent.setup();
    signedIn();
    expect((await call('PUT', '/ldap/config', CONFIG)).status).toBe(200);
    renderApp('/settings/ldap');
    await screen.findByRole('heading', { name: 'LDAP sign-in' }, T);
    const dry = screen.getByRole('button', { name: 'Dry run' }) as HTMLButtonElement;
    expect(dry.disabled).toBe(false);
    await user.type(screen.getByLabelText('User filter'), '(objectClass=person)');
    expect(dry.disabled).toBe(true);
    expect(dry.title).toBe('Save your changes first.');
    expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(dry.disabled).toBe(false), T);
  });

  it('hides the history and the run buttons from a role without ldap:sync', async () => {
    signedIn();
    backend().setDemoRole('member');
    const denied = await call('GET', '/ldap/sync');
    expect(denied.status).toBe(403);
    expect((await call('GET', '/ldap/config')).status).toBe(403);
  });
});

describe('LDAP demo routes', () => {
  it('answer the server codes and texts', async () => {
    signedIn();
    expect((await call('POST', '/ldap/test-connection')).body.error?.code).toBe('ldap_config_missing');
    expect((await call('POST', '/ldap/sync', { type: 'dry' })).body.error?.code).toBe('ldap_config_missing');
    expect(
      (await call('PUT', '/ldap/config', { connectionUrl: 'dir.test', connectionPort: 70000 })).status,
    ).toBe(400);
    expect(
      (await call('PUT', '/ldap/config', { connectionUrl: 'dir.test', loginEnabled: true })).body.error
        ?.message,
    ).toContain('base DN');
    expect((await call('PUT', '/ldap/config', CONFIG)).status).toBe(200);
    expect((await call('PUT', '/ldap/config', { loginEnabled: true })).body.data.loginEnabled).toBe(true);
    expect((await call('POST', '/ldap/sync', { type: 'bogus' })).status).toBe(400);
    const run = await call('POST', '/ldap/sync', { type: 'live' });
    expect(run.body.data).toMatchObject({
      runMode: 'live',
      status: 'success',
      created: DEMO_LDAP_PEOPLE.length,
    });
  });
});
