/** P6-21 (L5): the API keys page: expiry on create, edit, rotate, revoke, and the All keys tab. */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const T = { timeout: 5000 };
const DAY = 86_400;

function seedKey(owner: string, name: string, extra: Record<string, unknown> = {}) {
  const demo = backend();
  const id = `k-${name}`;
  demo.apiKeys.push({
    id,
    name,
    prefix: name.slice(0, 4).toLowerCase(),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    scopes: [],
    tenantId: demo.session!.tenantId,
    userId: owner,
    ...extra,
  });
  return id;
}

function addSam(role: string): string {
  const demo = backend();
  demo.users.push({ id: 'u-sam', email: 'sam@example.com', name: 'Sam Shaw', password: 'x' });
  demo.memberships.push({ tenantId: demo.session!.tenantId, userId: 'u-sam', role });
  return 'u-sam';
}

describe('API keys page (P6-21)', () => {
  it('sends the picked expiry in unix seconds, and nothing for no expiration', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/api-keys');
    await user.type(await screen.findByLabelText('New key name', {}, T), 'CI');
    await user.selectOptions(screen.getByLabelText('Expiration'), '30');
    const before = Math.floor(Date.now() / 1000);
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    await screen.findByTestId('new-api-key', {}, T);
    const post = backend().requests.find((r) => r.method === 'POST' && r.path === '/api-keys');
    const sent = (post?.body as { expiresAt: number } | undefined)?.expiresAt;
    expect(sent).toBeGreaterThanOrEqual(before + 30 * DAY - 5);
    expect(sent).toBeLessThanOrEqual(before + 30 * DAY + 60);
    expect(await screen.findByText(/· expires /, {}, T)).toBeTruthy();
  });

  it('the new key leaves the mutation cache when its dialog closes', async () => {
    const user = userEvent.setup();
    signedIn();
    const { queryClient } = renderApp('/settings/api-keys');
    await user.type(await screen.findByLabelText('New key name', {}, T), 'Cache');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    const key = (await screen.findByTestId('new-api-key', {}, T)).textContent ?? '';
    expect(key.length).toBeGreaterThan(10);
    const cached = () =>
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state.data),
      );
    expect(cached()).toContain(key);
    await user.click(screen.getByRole('button', { name: 'I copied it' }));
    await waitFor(() => expect(cached()).not.toContain(key), T);
  });

  it('a custom date in the past keeps Create disabled', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp('/settings/api-keys');
    await user.type(await screen.findByLabelText('New key name', {}, T), 'CI');
    await user.selectOptions(screen.getByLabelText('Expiration'), 'custom');
    const create = screen.getByRole('button', { name: 'Create key' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await user.type(screen.getByLabelText('Expires on'), '2099-01-01');
    expect(create.disabled).toBe(false);
  });

  it('edits the name and scopes of a key', async () => {
    const user = userEvent.setup();
    const demo = signedIn();
    seedKey(demo.session!.userId, 'Deploy');
    renderApp('/settings/api-keys');
    await user.click(await screen.findByRole('button', { name: 'Edit Deploy' }, T));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Key name');
    await user.clear(input);
    await user.type(input, 'Release');
    await user.click(within(dialog).getByRole('radio', { name: 'Only the scopes I pick' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'tag:list' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Release', {}, T);
    const patch = backend().requests.find((r) => r.method === 'PATCH' && r.path === '/api-keys/k-Deploy');
    expect(patch?.body).toEqual({ name: 'Release', scopes: ['tag:list'] });
  });

  it('rotates after a confirm and shows the new secret once; an expired key cannot rotate', async () => {
    const user = userEvent.setup();
    const demo = signedIn();
    seedKey(demo.session!.userId, 'Live');
    seedKey(demo.session!.userId, 'Old', { expiresAt: Math.floor(Date.now() / 1000) - DAY });
    renderApp('/settings/api-keys');
    expect(
      (await screen.findByRole('button', { name: 'Rotate Old' }, T)) as HTMLButtonElement,
    ).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Rotate Live' }));
    await user.click(await screen.findByRole('button', { name: 'Rotate key' }));
    expect((await screen.findByTestId('new-api-key', {}, T)).textContent).toMatch(/^wfk_/);
    expect(backend().requests.some((r) => r.method === 'POST' && r.path === '/api-keys/k-Live/rotate')).toBe(
      true,
    );
  });

  it('a member without apiKey:manage has no All keys tab', async () => {
    const demo = signedIn();
    addSam('member');
    demo.signIn('sam@example.com');
    renderApp('/settings/api-keys');
    await screen.findByLabelText('New key name', {}, T);
    expect(screen.queryByRole('tab', { name: 'All keys' })).toBeNull();
  });

  it('the All keys tab lists every key with its owner, filters by label and revokes with a confirm', async () => {
    const user = userEvent.setup();
    const demo = signedIn();
    const sam = addSam('member');
    seedKey(demo.session!.userId, 'Mine');
    seedKey(sam, 'Sams');
    renderApp('/settings/api-keys');
    await user.click(await screen.findByRole('tab', { name: 'All keys' }, T));
    const row = (await screen.findByText('Sams', {}, T)).closest('li') as HTMLElement;
    expect(within(row).getByText(/Sam Shaw/)).toBeTruthy();
    expect(screen.getByText('Mine')).toBeTruthy();
    await user.type(screen.getByLabelText('Label'), 'Sam');
    await waitFor(() => expect(screen.queryByText('Mine')).toBeNull(), T);
    const get = backend().requests.filter((r) => r.method === 'GET' && r.path === '/api-keys');
    expect(get.some((r) => (r.query as { label?: string } | undefined)?.label === 'Sam')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Delete Sams' }));
    await user.click(await screen.findByRole('button', { name: 'Delete key' }));
    await waitFor(() => expect(backend().apiKeys.some((k) => k.id === 'k-Sams')).toBe(false), T);
  });

  it('shows a page state, not the create, edit and rotate controls, when the public API is off', async () => {
    const demo = signedIn();
    seedKey(demo.session!.userId, 'Old');
    const handle = demo.handle.bind(demo);
    demo.handle = async (request) => {
      const response = await handle(request);
      if (request.method === 'GET' && request.path === '/settings') {
        const body = response.body as { data: { features: Record<string, unknown> } };
        body.data.features.publicApi = false;
      }
      return response;
    };
    renderApp('/settings/api-keys');
    expect(await screen.findByText(/public API is turned off on this workspace/, {}, T)).toBeTruthy();
    expect(await screen.findByText('Old', {}, T)).toBeTruthy();
    expect(screen.queryByLabelText('New key name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create key' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Old' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotate Old' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete Old' })).toBeTruthy();
  });
});
