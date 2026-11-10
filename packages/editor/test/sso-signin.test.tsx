/**
 * P6-01 (L6): the sign-in page's SSO part. The workspace field (from `?workspace=` or typed) goes into the
 * login body and asks the workspace's options; SAML and OIDC show the provider's button with its start URL;
 * with `redirect` on and the workspace in the link the page goes straight to the provider, unless
 * `?ssoError=` or the owner fallback `?password=1` is there; `?ssoError=` shows our text for its code only.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SSO_ERROR_FALLBACK,
  SSO_ERROR_TEXTS,
  ssoErrorText,
  ssoNavigation,
} from '../src/pages/auth/SsoSignIn';
import { backend } from './backend';
import { renderApp } from './utils';

afterEach(() => {
  vi.restoreAllMocks();
});

function account() {
  return backend().createAccount({
    email: 'ada@example.com',
    password: 'analytical-1',
    name: 'Ada',
    workspaceName: 'Engines',
  });
}

const optionsAsked = () => backend().requests.filter((r) => r.path === '/auth/sso-options');

describe('sign-in page: workspace and SSO', () => {
  it('prefills the workspace from the link and sends it with the login', async () => {
    const user = userEvent.setup();
    account();
    renderApp('/signin?workspace=engines');
    expect(((await screen.findByLabelText('Workspace')) as HTMLInputElement).value).toBe('engines');
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'analytical-1');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(backend().requests.some((r) => r.path === '/auth/login')).toBe(true));
    const login = backend().requests.find((r) => r.path === '/auth/login');
    expect(login?.body).toEqual({ email: 'ada@example.com', password: 'analytical-1', workspace: 'engines' });
    expect(optionsAsked()[0]?.query).toMatchObject({ workspace: 'engines' });
  });

  it('asks the options only once a workspace is typed, then shows its SSO button without redirecting', async () => {
    const user = userEvent.setup();
    const go = vi.spyOn(ssoNavigation, 'go').mockImplementation(() => {});
    backend().setDemoSso({ method: 'oidc', redirect: true });
    renderApp('/signin');
    await screen.findByLabelText('Email');
    expect(optionsAsked()).toHaveLength(0);
    await user.type(screen.getByLabelText('Workspace'), 'engines');
    // the field settles 400 ms after the last key, then asks the options: a loaded run needs more time
    const button = await screen.findByRole('link', { name: 'Continue with SSO' }, { timeout: 5000 });
    expect(button.getAttribute('href')).toBe('/sso/oidc/engines/login?redirect=%2Fworkflows');
    expect(optionsAsked().map((r) => r.query?.workspace)).toEqual(['engines']);
    // typed by hand: the button, not a jump away
    expect(go).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('shows the SAML button with its label and the return path, beside the password form', async () => {
    backend().setDemoSso({ method: 'saml', label: 'Okta', redirect: false });
    renderApp('/signin?workspace=engines&redirect=%2Fexecutions');
    const button = await screen.findByRole('link', { name: 'Continue with Okta' });
    expect(button.getAttribute('href')).toBe('/sso/saml/engines/initsso?redirect=%2Fexecutions');
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.getByText(/works for owners and for members an admin allows/)).toBeTruthy();
  });

  it('goes straight to the identity provider when redirect is on, with a password link for the owner', async () => {
    const user = userEvent.setup();
    const go = vi.spyOn(ssoNavigation, 'go').mockImplementation(() => {});
    backend().setDemoSso({ method: 'saml', redirect: true });
    const { router } = renderApp('/signin?workspace=engines');
    await waitFor(() => expect(go).toHaveBeenCalledWith('/sso/saml/engines/initsso?redirect=%2Fworkflows'));
    expect(screen.getByRole('status').textContent).toMatch(/identity provider/);
    expect(screen.queryByLabelText('Password')).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Sign in with a password instead' }));
    await waitFor(() => expect(router.state.location.search).toContain('password=1'));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Continue with SSO' })).toBeTruthy();
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('shows ?ssoError= with our own text for its code, and does not send the browser back', async () => {
    const go = vi.spyOn(ssoNavigation, 'go').mockImplementation(() => {});
    backend().setDemoSso({ method: 'oidc', redirect: true });
    renderApp('/signin?workspace=engines&ssoError=sso_invite_required');
    expect(await screen.findByText(SSO_ERROR_TEXTS.sso_invite_required)).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Continue with SSO' })).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
  });

  it('has its own text for the OIDC and SAML refusal codes', async () => {
    for (const code of [
      'sso_state_invalid',
      'sso_login_failed',
      'saml_response_invalid',
      'saml_response_replayed',
      'saml_attributes_missing',
      'saml_config_invalid',
      'saml_metadata_invalid',
      'not_found',
    ]) {
      expect(ssoErrorText(code)).toBe(SSO_ERROR_TEXTS[code]);
      expect(SSO_ERROR_TEXTS[code]).not.toBe(SSO_ERROR_FALLBACK);
    }
    renderApp('/signin?workspace=acme&ssoError=saml_attributes_missing');
    expect(await screen.findByText(SSO_ERROR_TEXTS.saml_attributes_missing)).toBeTruthy();
  });

  it('never shows the text of an unknown ?ssoError=', async () => {
    renderApp('/signin?ssoError=Call%20support%20at%20555');
    expect(await screen.findByText(SSO_ERROR_FALLBACK)).toBeTruthy();
    expect(screen.queryByText(/555/)).toBeNull();
  });

  it('shows no SSO button for a workspace that signs in by email', async () => {
    renderApp('/signin?workspace=engines');
    await waitFor(() => expect(optionsAsked()).toHaveLength(1));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Continue with/ })).toBeNull();
  });
});
