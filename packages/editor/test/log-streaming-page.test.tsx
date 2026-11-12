/**
 * P6-64 (L8): Settings > Log streaming on the demo backend: the cards with their enable switch, "Add destination"
 * asking for the type, edit, delete with a confirm, a destination's last error, and a member who fetches nothing.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 20_000 };

type Answer = { data?: any; error?: { code: string; message: string } };

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  query?: Record<string, string>,
) {
  const res = await backend().handle({ method, path, body, query });
  return { status: res.status, body: res.body as Answer };
}

const webhookBody = (label: string, extra: Record<string, unknown> = {}) => ({
  type: 'webhook',
  label,
  enabled: false,
  subscribedEvents: ['workflow'],
  anonymizeAuditMessages: false,
  settings: {
    url: 'https://hooks.example.test/in',
    method: 'POST',
    sendQuery: false,
    queryParameters: [],
    sendHeaders: false,
    headerParameters: [],
    sendPayload: true,
    responseCodeMustMatch: false,
    expectedStatusCode: 200,
    options: {
      allowUnauthorizedCerts: false,
      queryParameterArrays: 'brackets',
      redirect: { followRedirects: false, maxRedirects: 21 },
      timeout: 5000,
    },
  },
  ...extra,
});

describe('Settings > Log streaming', () => {
  it('an admin with no destinations adds a syslog one from the type picker', async () => {
    signedIn();
    const user = userEvent.setup();
    renderApp('/settings/log-streaming');
    expect(await screen.findByRole('heading', { name: 'Log streaming' }, T)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add destination' }));
    await user.click(await screen.findByRole('button', { name: 'Syslog' }));
    const dialog = await screen.findByRole('dialog', {}, T);
    await user.type(within(dialog).getByLabelText('Label'), 'Audit syslog');
    await user.type(within(dialog).getByLabelText('Host'), 'logs.example.test');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Audit syslog', {}, T)).toBeTruthy();
    const list = await call('GET', '/eventbus/destination');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ type: 'syslog', label: 'Audit syslog', enabled: false });
  });

  it('lists a card per destination and the enable switch saves the new state', async () => {
    signedIn();
    await call('POST', '/eventbus/destination', webhookBody('Orders hook'));
    const user = userEvent.setup();
    renderApp('/settings/log-streaming');
    expect(await screen.findByText('Orders hook', {}, T)).toBeTruthy();
    const toggle = screen.getByRole('switch', { name: 'Enable Orders hook' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    await waitFor(
      () =>
        expect(screen.getByRole('switch', { name: 'Enable Orders hook' }).getAttribute('aria-checked')).toBe(
          'true',
        ),
      T,
    );
    const saved = (await call('GET', '/eventbus/destination')).body.data[0];
    expect(saved.enabled).toBe(true);
    expect(saved.subscribedEvents).toEqual(['workflow']);
  });

  it('shows the last error of a destination whose send failed', async () => {
    signedIn();
    const made = await call(
      'POST',
      '/eventbus/destination',
      webhookBody('Broken hook', {
        settings: { ...webhookBody('x').settings, url: 'https://down.invalid/in' },
      }),
    );
    await call('POST', '/eventbus/testmessage', undefined, { id: made.body.data.id });
    renderApp('/settings/log-streaming');
    expect(await screen.findByText('Broken hook', {}, T)).toBeTruthy();
    expect(await screen.findByText(/Could not reach down\.invalid/, {}, T)).toBeTruthy();
  });

  it('deletes a destination after a confirm and keeps it when the confirm is cancelled', async () => {
    signedIn();
    await call('POST', '/eventbus/destination', webhookBody('Old hook'));
    const user = userEvent.setup();
    renderApp('/settings/log-streaming');
    await screen.findByText('Old hook', {}, T);
    await user.click(screen.getByRole('button', { name: 'Delete Old hook' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }, T));
    expect((await call('GET', '/eventbus/destination')).body.data).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Delete Old hook' }));
    const confirm = await screen.findByRole('dialog', {}, T);
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('Old hook')).toBeNull(), T);
    expect((await call('GET', '/eventbus/destination')).body.data).toEqual([]);
  });

  it('Edit opens the modal on the destination', async () => {
    signedIn();
    await call('POST', '/eventbus/destination', webhookBody('Edit me'));
    const user = userEvent.setup();
    renderApp('/settings/log-streaming');
    await screen.findByText('Edit me', {}, T);
    await user.click(screen.getByRole('button', { name: 'Edit Edit me' }));
    const dialog = await screen.findByRole('dialog', {}, T);
    expect((within(dialog).getByLabelText('Label') as HTMLInputElement).value).toBe('Edit me');
    expect((within(dialog).getByLabelText('URL') as HTMLInputElement).value).toBe(
      'https://hooks.example.test/in',
    );
  });

  it('a member gets the admin-only notice and the page fetches nothing', async () => {
    signedIn().setDemoRole('member');
    renderApp('/settings/log-streaming');
    expect(await screen.findByText('Only admins can manage log streaming.', {}, T)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add destination' })).toBeNull();
    expect(backend().requests.some((r) => r.path.startsWith('/eventbus'))).toBe(false);
  });
});
