import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import type { CredentialTypeDescription } from '../src/api/types';
import { CredentialModal, OAUTH2_CHANNEL } from '../src/components/credentials/CredentialModal';
import { CredentialTypePicker } from '../src/components/credentials/CredentialTypePicker';
import { demoCredentialTypes } from '../src/demo/fixtures';
import { signedIn } from './backend';
import { server } from './setup';
import { withProviders } from './utils';

const oauth1Type: CredentialTypeDescription = {
  name: 'oAuth1Api',
  displayName: 'OAuth1 API',
  icon: 'lucide:key-round',
  properties: [
    { displayName: 'Consumer Key', name: 'consumerKey', type: 'string', default: '' },
    { displayName: 'OAuth Token Data', name: 'oauthTokenData', type: 'hidden', default: {} },
  ],
  hasAuthenticate: true,
  isOAuth2: false,
  isOAuth1: true,
};

function seed() {
  const mock = signedIn();
  const now = new Date().toISOString();
  mock.credentials.push({
    id: 'cred-oauth1',
    tenantId: mock.session!.tenantId,
    name: 'Provider account',
    type: 'oAuth1Api',
    data: { consumerKey: 'ck' },
    createdAt: now,
    updatedAt: now,
  });
  server.use(
    http.get('/rest/credential-types', () =>
      HttpResponse.json({
        data: [...demoCredentialTypes.filter((t) => t.name !== oauth1Type.name), oauth1Type],
      }),
    ),
  );
  return mock;
}

afterEach(() => {
  vi.restoreAllMocks();
  setCurrentTenant(null);
});

describe('credential modal: OAuth1', () => {
  it('shows Connect account, calls /oauth1/authorize and shows the announced result', async () => {
    const user = userEvent.setup();
    seed();
    let oauth2Called = false;
    let oauth1Query = '';
    server.use(
      http.get('/rest/oauth2/authorize', () => {
        oauth2Called = true;
        return HttpResponse.json({ data: { url: 'https://x.example.com' } });
      }),
      http.get('/rest/oauth1/authorize', ({ request }) => {
        oauth1Query = new URL(request.url).search;
        return HttpResponse.json({ data: { url: 'https://auth.example.com/authorize?oauth_token=rt' } });
      }),
    );
    const popup = { closed: false };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    withProviders(<CredentialModal open credentialId="cred-oauth1" onClose={() => undefined} />);
    await screen.findByDisplayValue('Provider account', {}, { timeout: 10_000 });
    await user.click(screen.getByRole('button', { name: 'Connect account' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    expect(oauth1Query).toContain('credentialId=cred-oauth1');
    expect(oauth2Called).toBe(false);

    const channel = new BroadcastChannel(OAUTH2_CHANNEL);
    channel.postMessage({ type: 'oauth2-callback', status: 'success', credentialId: 'cred-oauth1' });
    channel.close();
    expect(await screen.findByText('Account connected.', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('asks to save first for a new OAuth1 credential and does not close after saving', async () => {
    const user = userEvent.setup();
    signedIn();
    server.use(
      http.get('/rest/credential-types', () =>
        HttpResponse.json({
          data: [...demoCredentialTypes.filter((t) => t.name !== oauth1Type.name), oauth1Type],
        }),
      ),
    );
    const onClose = vi.fn();
    withProviders(<CredentialModal open type="oAuth1Api" onClose={onClose} />);
    expect(await screen.findByText('Save the credential first, then connect your account.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Connect account' }, { timeout: 5000 })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('labels the type OAuth1 sign-in in the picker', async () => {
    signedIn();
    server.use(
      http.get('/rest/credential-types', () =>
        HttpResponse.json({
          data: [...demoCredentialTypes.filter((t) => t.name !== oauth1Type.name), oauth1Type],
        }),
      ),
    );
    withProviders(<CredentialTypePicker open onClose={() => undefined} onPick={() => undefined} />);
    expect(await screen.findByText('OAuth1 sign-in', {}, { timeout: 5000 })).toBeTruthy();
  });
});
