import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import type { CredentialTypeDescription } from '../src/api/types';
import { CredentialModal } from '../src/components/credentials/CredentialModal';
import { JweUriRow } from '../src/components/credentials/JweUriRow';
import { demoCredentialTypes } from '../src/demo/fixtures';
import { signedIn } from './backend';
import { server } from './setup';
import { withProviders } from './utils';

afterEach(() => {
  vi.restoreAllMocks();
  setCurrentTenant(null);
});

const URI = /\/\.well-known\/jwks\/[^/]+\.json$/;

describe('JweUriRow', () => {
  it('shows the key URL of the workspace when JWE is on', async () => {
    signedIn();
    withProviders(<JweUriRow typeName="oAuth2Api" jweEnabled />);
    const figure = await screen.findByRole('figure', { name: 'Public key URL' }, { timeout: 5000 });
    expect(figure.textContent).toMatch(URI);
    expect(figure.textContent).toContain(window.location.origin);
  });

  it('copies the URL and nothing else', async () => {
    const user = userEvent.setup();
    signedIn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    withProviders(<JweUriRow typeName="oAuth2Api" jweEnabled />);
    await user.click(await screen.findByRole('button', { name: 'Copy public key URL' }, { timeout: 5000 }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toMatch(URI);
    // copy only: no input to edit
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows nothing when JWE is off or for a child type', async () => {
    signedIn();
    const off = withProviders(<JweUriRow typeName="oAuth2Api" jweEnabled={false} />);
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByTestId('jwe-uri-row')).toBeNull();
    off.unmount();
    withProviders(<JweUriRow typeName="googleOAuth2Api" jweEnabled />);
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByTestId('jwe-uri-row')).toBeNull();
  });
});

describe('credential modal: JWE field', () => {
  const oauth2Type: CredentialTypeDescription = {
    name: 'oAuth2Api',
    displayName: 'OAuth2 API',
    icon: 'lucide:key-square',
    properties: [
      { displayName: 'Client ID', name: 'clientId', type: 'string', default: '' },
      { displayName: 'Encrypted Tokens (JWE)', name: 'jweEnabled', type: 'boolean', default: false },
      { displayName: 'OAuth Token Data', name: 'oauthTokenData', type: 'hidden', default: {} },
    ],
    hasAuthenticate: true,
    isOAuth2: true,
    isOAuth1: false,
  };

  it('shows the key URL after the switch is turned on', async () => {
    const user = userEvent.setup();
    signedIn();
    server.use(
      http.get('/rest/credential-types', () =>
        HttpResponse.json({
          data: [...demoCredentialTypes.filter((t) => t.name !== oauth2Type.name), oauth2Type],
        }),
      ),
    );
    withProviders(<CredentialModal open type="oAuth2Api" onClose={() => undefined} />);
    const toggle = await screen.findByRole('switch', { name: /Encrypted Tokens/ }, { timeout: 10_000 });
    expect(screen.queryByRole('figure', { name: 'Public key URL' })).toBeNull();
    await user.click(toggle);
    const figure = await screen.findByRole('figure', { name: 'Public key URL' }, { timeout: 5000 });
    expect(figure.textContent).toMatch(URI);
  });
});
