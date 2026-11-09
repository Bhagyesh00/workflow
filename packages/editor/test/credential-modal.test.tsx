import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { setPushConnector } from '../src/api/push';
import type { CredentialTypeDescription } from '../src/api/types';
import { CredentialModal, OAUTH2_CHANNEL } from '../src/components/credentials/CredentialModal';
import { demoCredentialTypes } from '../src/demo/fixtures';
import { signedIn } from './backend';
import { server } from './setup';
import { renderApp, withProviders } from './utils';

/** the server's OAuth2 type carries its token data as a hidden property */
const oauthTypes: CredentialTypeDescription[] = demoCredentialTypes.map((t) =>
  t.name === 'oAuth2Api'
    ? {
        ...t,
        properties: [
          ...t.properties,
          { displayName: 'OAuth Token Data', name: 'oauthTokenData', type: 'hidden', default: {} },
        ],
      }
    : t,
);

function seedOAuthCredential() {
  const mock = signedIn();
  const now = new Date().toISOString();
  mock.credentials.push({
    id: 'cred-oauth',
    tenantId: mock.session!.tenantId,
    name: 'Provider account',
    type: 'oAuth2Api',
    data: {
      clientId: 'client-1',
      clientSecret: 'secret',
      authUrl: 'https://auth.example.com',
      scope: 'read',
    },
    createdAt: now,
    updatedAt: now,
  });
  server.use(http.get('/rest/credential-types', () => HttpResponse.json({ data: oauthTypes })));
  return mock;
}

afterEach(() => {
  vi.restoreAllMocks();
  setCurrentTenant(null);
});

describe('credential modal: OAuth2 token data (R16)', () => {
  it('never sends the hidden token data when saving or testing', async () => {
    const user = userEvent.setup();
    const mock = seedOAuthCredential();
    withProviders(<CredentialModal open credentialId="cred-oauth" onClose={() => undefined} />);
    await screen.findByDisplayValue('Provider account', {}, { timeout: 10_000 });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mock.requests.some((r) => r.method === 'PATCH')).toBe(true));
    const patch = mock.requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toMatchObject({ data: { clientId: 'client-1', scope: 'read' } });
    expect((patch?.body as { data: object } | undefined)?.data).not.toHaveProperty('oauthTokenData');
  });
});

describe('credential modal: OAuth2 popup without an opener (R10)', () => {
  async function connect() {
    const user = userEvent.setup();
    const mock = seedOAuthCredential();
    server.use(
      http.get('/rest/oauth2/authorize', () =>
        HttpResponse.json({ data: { url: 'https://auth.example.com/authorize?state=x' } }),
      ),
    );
    const popup = { closed: false };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    withProviders(<CredentialModal open credentialId="cred-oauth" onClose={() => undefined} />);
    await screen.findByDisplayValue('Provider account');
    await user.click(screen.getByRole('button', { name: 'Connect account' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    return { mock, popup };
  }

  /** what the callback page sends besides postMessage: it shares the editor's origin */
  function announce(message: Record<string, unknown>) {
    const channel = new BroadcastChannel(OAUTH2_CHANNEL);
    channel.postMessage({ type: 'oauth2-callback', ...message });
    channel.close();
  }

  it('keeps waiting when the provider page cuts the popup off, and shows the result the callback announces', async () => {
    const { mock, popup } = await connect();
    // a provider page with its own opener policy: the popup reads as closed while the user still signs in
    popup.closed = true;
    expect(await screen.findByRole('button', { name: 'Connect account' }, { timeout: 3000 })).toBeTruthy();
    announce({ status: 'success', credentialId: 'cred-oauth' });
    expect(await screen.findByText('Account connected.', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText('Connection failed')).toBeNull();
    expect(mock.requests.some((r) => r.path === '/credentials/test')).toBe(false);
  });

  it('treats a closed popup as a cancel: no error', async () => {
    const { popup } = await connect();
    popup.closed = true;
    expect(await screen.findByRole('button', { name: 'Connect account' }, { timeout: 3000 })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByText('Connection failed')).toBeNull();
    expect(screen.queryByText('Account connected.')).toBeNull();
  });

  it('ignores results announced for another credential', async () => {
    const { popup } = await connect();
    popup.closed = true;
    announce({ status: 'success', credentialId: 'cred-other' });
    announce({ status: 'error', message: 'Denied' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByText('Account connected.')).toBeNull();
    expect(screen.queryByText('Connection failed')).toBeNull();
  });
});

describe('workspace binding per tab (R11)', () => {
  it('names the workspace on every request and follows a switch made in another tab', async () => {
    const mock = signedIn();
    const home = mock.session!.tenantId;
    const other = { id: 'tenant-b', name: 'Second Space', slug: 'second-space' };
    mock.tenants.push(other);
    mock.memberships.push({ tenantId: other.id, userId: mock.session!.userId, role: 'owner' });
    let connections = 0;
    setPushConnector((onEvent, onStatus) => {
      connections++;
      onStatus('open');
      return { close: mock.subscribe(onEvent) };
    });
    const seen: Array<{ path: string; tenant: string | null }> = [];
    server.use(
      http.all(/\/rest\/.*/, ({ request }) => {
        const path = new URL(request.url).pathname;
        const tenant = request.headers.get('x-tenant-id');
        seen.push({ path, tenant });
        // the real server's check: the session moved on while this tab still names the old workspace
        if (tenant && !path.startsWith('/rest/auth/') && tenant !== mock.session?.tenantId) {
          return HttpResponse.json(
            { error: { code: 'tenant_changed', message: 'The workspace was switched in another tab' } },
            { status: 409 },
          );
        }
        return undefined;
      }),
    );

    const { router } = renderApp('/executions');
    expect(await screen.findByRole('heading', { name: 'Executions' })).toBeTruthy();
    await waitFor(() =>
      expect(seen.some((r) => r.path === '/rest/executions' && r.tenant === home)).toBe(true),
    );
    expect(seen.find((r) => r.path === '/rest/auth/me')?.tenant).toBeNull();
    const before = connections;

    // another tab switches the shared session
    mock.session = { ...mock.session!, tenantId: other.id };
    await router.navigate('/credentials');

    expect(
      await screen.findByText('Workspace switched in another tab', {}, { timeout: 10_000 }),
    ).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe('/home/workflows'));
    expect((await screen.findAllByText('Second Space')).length).toBeGreaterThan(0);
    await waitFor(() => expect(connections).toBeGreaterThan(before));
    await waitFor(() =>
      expect(seen.some((r) => r.path === '/rest/workflows' && r.tenant === other.id)).toBe(true),
    );
  });
});

describe('invitation links (R13, R40)', () => {
  it('opens the accept page for /invitations/:token links', async () => {
    const mock = signedIn();
    mock.session = null;
    mock.invitations.push({
      token: 'invite-token-123456',
      tenantId: mock.tenants[0].id,
      email: 'new@example.com',
      role: 'member',
    });
    const { router } = renderApp('/invitations/invite-token-123456');
    expect(await screen.findByRole('button', { name: 'Accept invitation' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/invitations/invite-token-123456');
  });
});
