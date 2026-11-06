import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { secretsApi } from '../src/api/endpoints';
import { type CompletionData, completeExpression } from '../src/components/code/completions';
import { CredentialModal } from '../src/components/credentials/CredentialModal';
import { signedIn } from './backend';
import { withProviders } from './utils';

afterEach(() => setCurrentTenant(null));

const withSecrets: CompletionData = {
  inputFields: () => [],
  nodeNames: [],
  nodeFields: () => [],
  variables: [],
  secrets: { vault: ['apiKey', 'db-password'], aws: ['token'] },
};
const without: CompletionData = { ...withSecrets, secrets: undefined };

async function withConnection() {
  const mock = signedIn();
  setCurrentTenant(mock.session!.tenantId);
  await secretsApi.createConnection({
    providerKey: 'vault',
    type: 'vault',
    settings: { url: 'https://v', token: 't' },
  });
  await secretsApi.updateConnection('vault', { isEnabled: true });
  return mock;
}

/** the `value` field of the credential the modal created */
function postedValue(mock: ReturnType<typeof signedIn>): string | undefined {
  const post = mock.requests.find((r) => r.method === 'POST' && r.path === '/credentials');
  return (post?.body as { data?: { value?: string } } | undefined)?.data?.value;
}

const labels = (before: string, data: CompletionData) =>
  completeExpression(before, data)?.options.map((o) => o.label) ?? [];

describe('$secrets completions (P4-07)', () => {
  it('offers $secrets only when the form can read secrets', () => {
    expect(labels('$sec', withSecrets)).toEqual(['$secrets']);
    expect(labels('$sec', without)).toEqual([]);
  });

  it('lists connection keys, then the secret names of one', () => {
    expect(labels('$secrets.', withSecrets)).toEqual(['vault', 'aws']);
    expect(labels('$secrets.vault.', withSecrets)).toEqual(['apiKey', 'db-password']);
    expect(completeExpression('$secrets.vault.d', withSecrets)?.options.map((o) => o.apply)).toEqual([
      '["db-password"]',
    ]);
    expect(completeExpression('$secrets.nope.', withSecrets)).toBeNull();
    expect(completeExpression('$secrets.vault.apiKey.', withSecrets)).toBeNull();
  });

  it('answers nothing for $secrets in a form without secrets', () => {
    expect(completeExpression('$secrets.', without)).toBeNull();
  });
});

describe('credential modal: expression toggle (P4-07)', () => {
  it('has no toggle without a connection', async () => {
    signedIn();
    withProviders(<CredentialModal open type="httpHeaderAuth" onClose={() => undefined} />);
    await screen.findByDisplayValue(/account/);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('group', { name: /value mode/ })).toBeNull();
  });

  it('shows the toggle once a connection exists and saves a visible secret expression', async () => {
    const user = userEvent.setup();
    const mock = await withConnection();
    withProviders(<CredentialModal open type="httpHeaderAuth" onClose={() => undefined} />);
    const groups = await screen.findAllByRole('group', { name: /value mode/ });
    // only text fields offer it
    expect(groups.length).toBeGreaterThan(0);
    const valueGroup = groups.find((g) => g.getAttribute('aria-label') === 'Value value mode');
    await user.click(valueGroup!.querySelectorAll('button')[1]);
    // the field is now an expression editor, not a masked input
    expect(await screen.findByTestId('code-editor-expression')).toBeTruthy();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.requests.some((r) => r.method === 'POST' && r.path === '/credentials')).toBe(true),
    );
    expect(postedValue(mock)).toBe('=');
  });

  it('typing {{ in a password field makes it a visible expression that is saved as typed', async () => {
    const user = userEvent.setup();
    const mock = await withConnection();
    withProviders(<CredentialModal open type="httpHeaderAuth" onClose={() => undefined} />);
    const input = await waitFor(() => {
      const el = document.querySelector('input[type="password"]');
      if (!el) throw new Error('no password field');
      return el;
    });
    fireEvent.change(input, { target: { value: '{{ $secrets.vault.apiKey }}' } });
    await waitFor(() => expect(document.querySelector('input[type="password"]')).toBeNull());
    expect((await screen.findByTestId('code-editor-expression')).textContent).toContain(
      '$secrets.vault.apiKey',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mock.requests.some((r) => r.method === 'POST' && r.path === '/credentials')).toBe(true),
    );
    const post = mock.requests.find((r) => r.method === 'POST' && r.path === '/credentials');
    expect((post?.body as { data: { value: string } } | undefined)?.data.value).toBe(
      '={{ $secrets.vault.apiKey }}',
    );
  });

  it('a password with {{ further on stays masked and is saved as typed', async () => {
    const user = userEvent.setup();
    const mock = await withConnection();
    withProviders(<CredentialModal open type="httpHeaderAuth" onClose={() => undefined} />);
    const input = await waitFor(() => {
      const el = document.querySelector('input[type="password"]');
      if (!el) throw new Error('no password field');
      return el;
    });
    fireEvent.change(input, { target: { value: 'aB{{9x' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
    expect(screen.queryByTestId('code-editor-expression')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(postedValue(mock)).toBe('aB{{9x'));
  });

  it.each([
    ['={{ $secrets.vault.apiKey }}'],
    ['  ={{ $secrets.vault.apiKey }}'],
    ['  {{ $secrets.vault.apiKey }}'],
  ])('pasting %j saves one = and no leading spaces', async (pasted) => {
    const user = userEvent.setup();
    const mock = await withConnection();
    withProviders(<CredentialModal open type="httpHeaderAuth" onClose={() => undefined} />);
    const input = await waitFor(() => {
      const el = document.querySelector('input[type="password"]');
      if (!el) throw new Error('no password field');
      return el;
    });
    fireEvent.change(input, { target: { value: pasted } });
    await screen.findByTestId('code-editor-expression');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(postedValue(mock)).toBe('={{ $secrets.vault.apiKey }}'));
  });

  it('the demo backend keeps a saved expression visible and masks a password with braces', async () => {
    const mock = await withConnection();
    const now = new Date().toISOString();
    const add = (id: string, value: string) =>
      mock.credentials.push({
        id,
        tenantId: mock.session!.tenantId,
        name: id,
        type: 'httpHeaderAuth',
        data: { name: 'X-Key', value },
        createdAt: now,
        updatedAt: now,
      });
    add('expr', '={{ $secrets.vault.apiKey }}');
    add('braces', '=aB{{9x');
    add('plain', 'hunter2');
    const value = async (id: string) =>
      (await fetch(`/rest/credentials/${id}`).then((r) => r.json())).data.data.value as string;
    expect(await value('expr')).toBe('={{ $secrets.vault.apiKey }}');
    expect(await value('braces')).toBe('__REDACTED__');
    expect(await value('plain')).toBe('__REDACTED__');
  });

  it('keeps a saved expression visible in a password field', async () => {
    const mock = await withConnection();
    const now = new Date().toISOString();
    mock.credentials.push({
      id: 'cx',
      tenantId: mock.session!.tenantId,
      name: 'Expr',
      type: 'httpHeaderAuth',
      data: { name: 'X-Key', value: '={{ $secrets.vault.apiKey }}' },
      createdAt: now,
      updatedAt: now,
    });
    withProviders(<CredentialModal open credentialId="cx" onClose={() => undefined} />);
    await screen.findByDisplayValue('Expr', {}, { timeout: 10_000 });
    expect((await screen.findByTestId('code-editor-expression')).textContent).toContain(
      '$secrets.vault.apiKey',
    );
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
});
