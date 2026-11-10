/**
 * P6-10 (oidc-1): Sign out of an OIDC session goes through the OIDC logout route and follows the identity
 * provider's end session URL when the answer holds one; any other session still posts /auth/logout.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authApi, ssoApi } from '../src/api/endpoints';
import type { Me } from '../src/api/types';
import { ssoNavigation } from '../src/pages/auth/SsoSignIn';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

afterEach(() => {
  vi.restoreAllMocks();
});

async function signOut(authMethod: Me['authMethod']) {
  const user = userEvent.setup();
  signedIn();
  const realMe = authApi.me.bind(authApi);
  vi.spyOn(authApi, 'me').mockImplementation(async () => ({ ...(await realMe()), authMethod }));
  const go = vi.spyOn(ssoNavigation, 'go').mockImplementation(() => {});
  const { router } = renderApp('/workflows');
  await user.click(await screen.findByRole('button', { name: /Olive Owner/ }));
  await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
  return { go, router };
}

const asked = (path: string) => (r: { path: string }) => r.path === path;

describe('Sign out', () => {
  it('goes to the identity provider when an OIDC session gets its end session URL', async () => {
    const url = 'https://idp.example.com/logout?id_token_hint=abc';
    const oidc = vi.spyOn(ssoApi, 'oidcLogout').mockResolvedValue({ url });
    const { go } = await signOut('oidc');
    await waitFor(() => expect(go).toHaveBeenCalledWith(url));
    expect(oidc).toHaveBeenCalledTimes(1);
  });

  it('signs an OIDC session out here when the workspace does not sign out of the provider', async () => {
    vi.spyOn(ssoApi, 'oidcLogout').mockResolvedValue({ url: null });
    const { go, router } = await signOut('oidc');
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
    expect(go).not.toHaveBeenCalled();
  });

  it('falls back to the plain sign out when the OIDC route fails', async () => {
    vi.spyOn(ssoApi, 'oidcLogout').mockRejectedValue(new Error('down'));
    const { go, router } = await signOut('oidc');
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
    expect(go).not.toHaveBeenCalled();
  });

  it('posts /auth/logout for a password session', async () => {
    const oidc = vi.spyOn(ssoApi, 'oidcLogout');
    const { router } = await signOut('password');
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
    expect(oidc).not.toHaveBeenCalled();
    expect(backend().requests.some(asked('/auth/logout'))).toBe(true);
  });
});
