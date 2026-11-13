/**
 * P6-64 (L8): the destination modal on the demo backend: each type's fields, the Events tab (a group, a single
 * name, everything, anonymize), saved secrets blank with a hint, Send test event with its result, and Delete.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { LogDestination, LogDestinationType } from '../src/api/types';
import { DestinationModal } from '../src/components/log-streaming/DestinationModal';
import { EventTree } from '../src/components/log-streaming/EventTree';
import { backend, signedIn } from './backend';
import { withProviders } from './utils';

const T = { timeout: 20_000 };

type Answer = { data?: any; error?: { code: string; message: string } };

async function call(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>) {
  const res = await backend().handle({ method, path, body, query });
  return { status: res.status, body: res.body as Answer };
}

const lastSave = () =>
  backend()
    .requests.filter((r) => r.method === 'POST' && r.path === '/eventbus/destination')
    .at(-1)?.body as any;

function open(type: LogDestinationType, destination: LogDestination | null = null, onClose = vi.fn()) {
  withProviders(<DestinationModal open type={type} destination={destination} onClose={onClose} />);
  return onClose;
}

const webhookSettings = (url: string, extra: Record<string, unknown> = {}) => ({
  url,
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
  ...extra,
});

async function saved(label: string, settings: Record<string, unknown>): Promise<LogDestination> {
  const res = await call('POST', '/eventbus/destination', {
    type: 'webhook',
    label,
    enabled: true,
    subscribedEvents: ['audit'],
    anonymizeAuditMessages: false,
    settings,
  });
  expect(res.status).toBe(200);
  return (await call('GET', '/eventbus/destination', undefined, { id: res.body.data.id })).body.data;
}

const secretHook = () =>
  saved(
    'Secret hook',
    webhookSettings('https://hooks.example.test/in?token=fake-token-1', {
      sendQuery: true,
      queryParameters: [{ name: 'k', value: 'fake-query-1' }],
      sendHeaders: true,
      headerParameters: [{ name: 'X-Key', value: 'fake-header-1' }],
    }),
  );

describe('DestinationModal', () => {
  it('creates a webhook with its fields, headers and breaker', async () => {
    signedIn();
    const user = userEvent.setup();
    open('webhook');
    const dialog = await screen.findByRole('dialog', {}, T);
    await user.type(within(dialog).getByLabelText('Label'), 'New hook');
    await user.type(within(dialog).getByLabelText('URL'), 'https://hooks.example.test/in');
    await user.selectOptions(within(dialog).getByLabelText('Method'), 'PUT');
    await user.click(within(dialog).getByRole('switch', { name: 'Send headers' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add header' }));
    await user.type(within(dialog).getByLabelText('Header name 1'), 'X-Key');
    await user.type(within(dialog).getByLabelText('Header value 1'), 'fake-header-1');
    await user.clear(within(dialog).getByLabelText('Max failures'));
    await user.type(within(dialog).getByLabelText('Max failures'), '3');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lastSave()?.label).toBe('New hook'), T);
    expect(lastSave()).toMatchObject({
      type: 'webhook',
      settings: { url: 'https://hooks.example.test/in', method: 'PUT', sendHeaders: true },
      circuitBreaker: { maxFailures: 3, failureWindowMs: 60_000 },
    });
    expect(lastSave().settings.headerParameters).toEqual([{ name: 'X-Key', value: 'fake-header-1' }]);
    const list = (await call('GET', '/eventbus/destination')).body.data;
    expect(list).toHaveLength(1);
    // the answer carries no secret value
    expect(list[0].settings.headerParameters).toEqual([{ name: 'X-Key', value: '' }]);
  });

  it('creates a syslog destination over TLS with a CA and a facility', async () => {
    signedIn();
    const user = userEvent.setup();
    open('syslog');
    const dialog = await screen.findByRole('dialog', {}, T);
    expect(within(dialog).queryByLabelText('CA certificate')).toBeNull();
    await user.type(within(dialog).getByLabelText('Label'), 'Syslog TLS');
    await user.type(within(dialog).getByLabelText('Host'), 'logs.example.test');
    await user.selectOptions(within(dialog).getByLabelText('Protocol'), 'tls');
    await user.type(within(dialog).getByLabelText('CA certificate'), 'fake-pem');
    await user.selectOptions(within(dialog).getByLabelText('Facility'), '23');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lastSave()?.label).toBe('Syslog TLS'), T);
    expect(lastSave().settings).toMatchObject({
      host: 'logs.example.test',
      port: 514,
      protocol: 'tls',
      tlsCa: 'fake-pem',
      facility: 23,
    });
  });

  it('the webhook credential picker lists the five generic HTTP auth types the server accepts', async () => {
    signedIn();
    const types = ['httpBasicAuth', 'httpDigestAuth', 'httpHeaderAuth', 'httpQueryAuth', 'httpCustomAuth'];
    for (const type of [...types, 'httpTemplatedCustomAuth', 'crmApi']) {
      await call('POST', '/credentials', { name: `Cred ${type}`, type, data: {} });
    }
    open('webhook');
    const dialog = await screen.findByRole('dialog', {}, T);
    const picker = within(dialog).getByLabelText('Credential');
    await waitFor(() => expect(within(picker).getAllByRole('option').length).toBeGreaterThan(1), T);
    const names = within(picker)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toEqual(['None', ...types.map((t) => `Cred ${t}`)]);
  });

  it('a syslog destination over TLS needs a CA before Save sends, and the End of line labels are plain', async () => {
    signedIn();
    const user = userEvent.setup();
    open('syslog');
    const dialog = await screen.findByRole('dialog', {}, T);
    const eol = within(dialog).getByLabelText('End of line');
    expect(
      within(eol)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['LF', 'CRLF']);
    await user.type(within(dialog).getByLabelText('Label'), 'No CA');
    await user.type(within(dialog).getByLabelText('Host'), 'logs.example.test');
    await user.selectOptions(within(dialog).getByLabelText('Protocol'), 'tls');
    expect(within(dialog).getByText(/Required for TLS/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Paste the CA certificate for TLS.', {}, T)).toBeTruthy();
    expect(lastSave()).toBeUndefined();
  });

  it('the demo backend refuses TLS without a CA, as the server does', async () => {
    signedIn();
    const res = await call('POST', '/eventbus/destination', {
      type: 'syslog',
      label: 'Raw TLS',
      enabled: true,
      subscribedEvents: [],
      anonymizeAuditMessages: false,
      settings: {
        host: 'logs.example.test',
        port: 6514,
        protocol: 'tls',
        facility: 16,
        app_name: 'w',
        eol: '\n',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toBe('A CA certificate is required for TLS');
  });

  it('the demo backend blanks the password of a webhook URL and keeps it on a blank save', async () => {
    signedIn();
    const dest = await saved('Userinfo hook', webhookSettings('https://bob:s3cret@hooks.example.test/x'));
    expect(JSON.stringify(dest)).not.toContain('s3cret');
    expect((dest.settings as { url: string }).url).not.toContain('s3cret');
    const again = await call('POST', '/eventbus/destination', {
      id: dest.id,
      type: 'webhook',
      label: 'Userinfo hook',
      enabled: true,
      subscribedEvents: ['audit'],
      anonymizeAuditMessages: false,
      settings: webhookSettings((dest.settings as { url: string }).url),
    });
    expect(again.status).toBe(200);
    expect(JSON.stringify(again.body)).not.toContain('s3cret');
  });

  it('creates a Sentry destination and hides the key of a saved DSN', async () => {
    signedIn();
    const user = userEvent.setup();
    open('sentry');
    const dialog = await screen.findByRole('dialog', {}, T);
    await user.type(within(dialog).getByLabelText('Label'), 'Sentry');
    await user.type(within(dialog).getByLabelText('DSN'), 'https://fakekey1@sentry.example.test/42');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lastSave()?.label).toBe('Sentry'), T);
    expect(lastSave().settings.dsn).toBe('https://fakekey1@sentry.example.test/42');
    const stored = (await call('GET', '/eventbus/destination')).body.data[0];
    expect(stored.settings.dsn).not.toContain('fakekey1');
    expect(stored.settings.dsn).toContain('sentry.example.test/42');
  });

  it('checks a missing label and URL before it sends anything', async () => {
    signedIn();
    const user = userEvent.setup();
    open('webhook');
    const dialog = await screen.findByRole('dialog', {}, T);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Give the destination a label.')).toBeTruthy();
    expect(within(dialog).getByText('Enter the URL to send to.')).toBeTruthy();
    expect(backend().requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('shows saved secrets blank with a hint and a blank save keeps them', async () => {
    signedIn();
    const hook = await secretHook();
    const user = userEvent.setup();
    open('webhook', hook);
    const dialog = await screen.findByRole('dialog', {}, T);
    const value = within(dialog).getByLabelText('Header value 1') as HTMLInputElement;
    expect(value.value).toBe('');
    expect(value.type).toBe('password');
    expect(within(dialog).getAllByText(/saved value is kept/i).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('fake-header-1');
    await user.clear(within(dialog).getByLabelText('Label'));
    await user.type(within(dialog).getByLabelText('Label'), 'Renamed hook');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lastSave()?.label).toBe('Renamed hook'), T);
    expect(lastSave().id).toBe(hook.id);
    expect(lastSave().settings.headerParameters).toEqual([{ name: 'X-Key', value: '' }]);
    expect((await call('POST', '/eventbus/testmessage', undefined, { id: hook.id })).status).toBe(200);
  });

  it('the Events tab saves a whole group, a single name and the anonymize switch', async () => {
    signedIn();
    const user = userEvent.setup();
    open('webhook');
    const dialog = await screen.findByRole('dialog', {}, T);
    await user.type(within(dialog).getByLabelText('Label'), 'Events hook');
    await user.type(within(dialog).getByLabelText('URL'), 'https://hooks.example.test/in');
    await user.click(within(dialog).getByRole('tab', { name: 'Events' }));
    await user.click(await within(dialog).findByLabelText('All audit events', {}, T));
    await user.click(within(dialog).getByLabelText('workflow.started'));
    await user.click(within(dialog).getByRole('switch', { name: 'Anonymize audit messages' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(lastSave()?.label).toBe('Events hook'), T);
    expect([...lastSave().subscribedEvents].sort()).toEqual(['audit', 'workflow.started']);
    expect(lastSave().anonymizeAuditMessages).toBe(true);
  });

  it('Send test event shows that the destination received it', async () => {
    signedIn();
    const hook = await saved('Reachable', webhookSettings('https://hooks.example.test/in'));
    const user = userEvent.setup();
    open('webhook', hook);
    const dialog = await screen.findByRole('dialog', {}, T);
    await user.click(within(dialog).getByRole('button', { name: 'Send test event' }));
    expect(await within(dialog).findByText('Test event delivered.', {}, T)).toBeTruthy();
    expect(backend().requests.some((r) => r.path === '/eventbus/testmessage')).toBe(true);
  });

  it('Send test event reports the error text', async () => {
    signedIn();
    const hook = await saved('Unreachable', webhookSettings('https://down.invalid/in'));
    const user = userEvent.setup();
    open('webhook', hook);
    const dialog = await screen.findByRole('dialog', {}, T);
    await user.click(within(dialog).getByRole('button', { name: 'Send test event' }));
    expect(
      await within(dialog).findByText(/Test event failed: Could not reach down\.invalid/, {}, T),
    ).toBeTruthy();
  });

  it('a new destination cannot send a test or be deleted before it is saved', async () => {
    signedIn();
    open('syslog');
    const dialog = await screen.findByRole('dialog', {}, T);
    const test = within(dialog).getByRole('button', { name: 'Send test event' }) as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    expect(within(dialog).queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('Delete asks to confirm, removes the destination and closes the modal', async () => {
    signedIn();
    const hook = await saved('Delete me', webhookSettings('https://hooks.example.test/in'));
    const user = userEvent.setup();
    const onClose = open('webhook', hook);
    const dialog = await screen.findByRole('dialog', {}, T);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const confirm = (await screen.findAllByRole('dialog', {}, T)).at(-1) as HTMLElement;
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled(), T);
    expect((await call('GET', '/eventbus/destination')).body.data).toEqual([]);
  });
});

const names = [
  'workflow.started',
  'workflow.success',
  'node.started',
  'node.finished',
  'audit.user.login.success',
  'audit.user.login.failed',
];

function Harness({ start, onValue }: { start: string[]; onValue: (v: string[]) => void }) {
  const [value, setValue] = useState(start);
  const [anon, setAnon] = useState(false);
  return (
    <EventTree
      eventNames={names}
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
      anonymizeAuditMessages={anon}
      onAnonymizeChange={setAnon}
    />
  );
}

describe('EventTree', () => {
  it('shows the groups in order, checks a whole group by its prefix and a name by itself', async () => {
    const user = userEvent.setup();
    const seen: string[][] = [];
    withProviders(<Harness start={[]} onValue={(v) => seen.push(v)} />);
    const groups = screen.getAllByText(/^All (audit|workflow|node) events$/).map((el) => el.textContent);
    expect(groups).toEqual(['All audit events', 'All workflow events', 'All node events']);
    await user.click(screen.getByLabelText('All workflow events'));
    expect(seen.at(-1)).toEqual(['workflow']);
    await user.click(screen.getByLabelText('node.started'));
    expect([...(seen.at(-1) ?? [])].sort()).toEqual(['node.started', 'workflow']);
    // a name of a checked group is checked; clearing it leaves the rest of the group
    expect((screen.getByLabelText('workflow.success') as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByLabelText('workflow.success'));
    expect([...(seen.at(-1) ?? [])].sort()).toEqual(['node.started', 'workflow.started']);
  });

  it('All events saves *, and a value of * shows every box checked', async () => {
    const user = userEvent.setup();
    const seen: string[][] = [];
    withProviders(<Harness start={['*']} onValue={(v) => seen.push(v)} />);
    expect((screen.getByLabelText('audit.user.login.failed') as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByLabelText('All events'));
    expect(seen.at(-1)).toEqual([]);
    await user.click(screen.getByLabelText('All events'));
    expect(seen.at(-1)).toEqual(['*']);
  });

  it('keeps a subscription it does not know and shows the anonymize switch in the audit group', async () => {
    const user = userEvent.setup();
    const seen: string[][] = [];
    withProviders(<Harness start={['legacy.event']} onValue={(v) => seen.push(v)} />);
    await user.click(screen.getByLabelText('All node events'));
    expect([...(seen.at(-1) ?? [])].sort()).toEqual(['legacy.event', 'node']);
    expect(screen.getByRole('switch', { name: 'Anonymize audit messages' })).toBeTruthy();
  });
});
