/**
 * P6-87: `/credential-connect/:id`: a signed-in user connects or disconnects their own account on a private
 * credential and returns to the form, chat or webhook they came from; `returnTo` is validated; no session and no
 * token is in the link. And `/form-auth` signs a visitor in for a Webhook with workspace sign-in too.
 */
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { credentialsApi, formAuthApi, privateCredentialsApi } from '../src/api/endpoints';
import { formReturn, isFormReturnPath, isWebhookReturnPath } from '../src/pages/auth/FormSignInPage';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const ID = '11111111-2222-3333-4444-555555555555';
const FORM = '/form/acme/survey';

let go: ReturnType<typeof vi.spyOn>;
let connect: ReturnType<typeof vi.spyOn>;
let disconnect: ReturnType<typeof vi.spyOn>;
let open: ReturnType<typeof vi.spyOn>;
let issueCode: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  go = vi.spyOn(formReturn, 'go').mockImplementation(() => {});
  connect = vi.spyOn(privateCredentialsApi, 'connect').mockResolvedValue({ url: 'https://provider.example/auth' });
  disconnect = vi.spyOn(privateCredentialsApi, 'disconnect').mockResolvedValue({ ok: true });
  vi.spyOn(credentialsApi, 'get').mockResolvedValue({ name: 'Calendar' } as never);
  open = vi.spyOn(window, 'open').mockReturnValue(window);
  issueCode = vi.spyOn(formAuthApi, 'issueCode').mockResolvedValue({ code: 'one-time-code' });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const pageOf = (returnTo: string, action = 'connect', id = ID) =>
  `/credential-connect/${id}?action=${action}&returnTo=${encodeURIComponent(returnTo)}`;

/** the OAuth callback page's message to its opener */
const providerSays = (data: unknown) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin: window.location.origin, source: window }));
  });

describe('the connect page', () => {
  it('sends a signed-out visitor to sign-in with a way back to this page', async () => {
    const { router } = renderApp(pageOf(FORM));
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
    const redirect = new URLSearchParams(router.state.location.search).get('redirect');
    expect(redirect).toBe(pageOf(FORM));
    expect(connect).not.toHaveBeenCalled();
  });

  it('names the credential and connects the own account in the provider window, then returns', async () => {
    signedIn();
    renderApp(pageOf(FORM));
    expect(await screen.findByRole('heading', { name: 'Connect your account' })).toBeTruthy();
    expect(await screen.findByText(/"Calendar"/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(connect).toHaveBeenCalledWith(ID);
    expect(open.mock.calls[0][0]).toBe('https://provider.example/auth');
    expect(await screen.findByText('Finish signing in in the window that opened.')).toBeTruthy();

    await providerSays({ status: 'success' });
    expect(await screen.findByRole('heading', { name: 'Account connected' })).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Back to where you were' }));
    expect(go).toHaveBeenCalledWith(FORM);
  });

  it('shows the provider\'s refusal and lets the user try again', async () => {
    signedIn();
    renderApp(pageOf(FORM));
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await providerSays({ status: 'error', message: 'Access denied' });
    expect(await screen.findByText('Access denied')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
  });

  it('ignores a message from another origin or another window', async () => {
    signedIn();
    renderApp(pageOf(FORM));
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByText('Finish signing in in the window that opened.');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { status: 'success' }, origin: 'https://evil.example', source: window }),
      );
    });
    expect(screen.queryByRole('heading', { name: 'Account connected' })).toBeNull();
  });

  it('says so when the browser blocks the provider window', async () => {
    signedIn();
    open.mockReturnValue(null);
    renderApp(pageOf(FORM));
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/blocked the sign-in window/)).toBeTruthy();
  });

  it('refuses a provider address that is not http or https', async () => {
    signedIn();
    connect.mockResolvedValue({ url: 'javascript:alert(1)' });
    renderApp(pageOf(FORM));
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('Unsupported authorization URL')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it('shows the server\'s reason when it will not start the connection', async () => {
    signedIn();
    connect.mockRejectedValue(new ApiError(400, 'bad_request', 'This credential is not private'));
    renderApp(pageOf(FORM));
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('This credential is not private')).toBeTruthy();
  });

  it('disconnects the own account and returns', async () => {
    signedIn();
    renderApp(pageOf(FORM, 'disconnect'));
    expect(await screen.findByRole('heading', { name: 'Disconnect your account' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('heading', { name: 'Account disconnected' })).toBeTruthy();
    expect(disconnect).toHaveBeenCalledWith(ID);
    expect(connect).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Back to where you were' }));
    expect(go).toHaveBeenCalledWith(FORM);
  });

  it('goes back without a change when asked', async () => {
    signedIn();
    renderApp(pageOf('/webhook/acme/hook-1/chat'));
    await userEvent.click(await screen.findByRole('button', { name: 'Back without changes' }));
    expect(go).toHaveBeenCalledWith('/webhook/acme/hook-1/chat');
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it.each([
    ['a form', FORM],
    ['a test form', '/form-test/acme/survey'],
    ['a waiting form', '/form-waiting/e1/sig'],
    ['a chat', '/webhook/acme/hook-1/chat'],
    ['a webhook', '/webhook/acme/orders'],
    ['a test webhook with a query', '/webhook-test/acme/orders?ref=mail'],
  ])('returns to %s', async (_label, returnTo) => {
    signedIn();
    renderApp(pageOf(returnTo));
    await userEvent.click(await screen.findByRole('button', { name: 'Back without changes' }));
    expect(go).toHaveBeenCalledWith(returnTo);
  });

  it.each([
    ['another site', 'https://evil.example/form/acme/survey'],
    ['a protocol-relative URL', '//evil.example/form/acme/survey'],
    ['the REST API', '/rest/me'],
    ['the editor', '/settings/credentials'],
    ['a script address', 'javascript:alert(1)'],
    ['a way out of the path', '/form/acme/../../rest/me'],
    ['an encoded way out', '/webhook/acme/%2e%2e/rest'],
    ['a backslash', '/form/acme/a\\b'],
    ['a workspace with no path', '/webhook/acme'],
    ['a resume URL of a webhook', '/webhook-waiting/e1/chat'],
  ])('refuses a returnTo to %s: no page, no call', async (_label, returnTo) => {
    signedIn();
    renderApp(pageOf(returnTo));
    expect(await screen.findByText("This link isn't valid.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
  });

  it('refuses an unknown action, a missing returnTo and an odd credential id', async () => {
    signedIn();
    for (const path of [
      pageOf(FORM, 'steal'),
      `/credential-connect/${ID}?action=connect`,
      pageOf(FORM, 'connect', 'a%20b'),
    ]) {
      const { unmount } = renderApp(path);
      expect(await screen.findByText("This link isn't valid.")).toBeTruthy();
      unmount();
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('puts no session, token or secret in anything it sends or shows', async () => {
    signedIn();
    renderApp(pageOf(FORM));
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByText('Finish signing in in the window that opened.');
    // the only call is the credential id; the provider window gets the server's address as given
    expect(connect).toHaveBeenCalledWith(ID);
    expect(backend().requests.map((r) => r.path).join(' ')).not.toMatch(/token|session/i);
  });
});

describe('/form-auth for a webhook', () => {
  const WEBHOOK = '/webhook/acme/orders';
  const signInPage = (returnTo: string) => `/form-auth?redirect=${encodeURIComponent(returnTo)}`;

  it('asks for a code for the webhook path and returns to it with the code', async () => {
    signedIn();
    renderApp(signInPage(`${WEBHOOK}?ref=mail`));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(issueCode).toHaveBeenCalledWith(`${WEBHOOK}?ref=mail`);
    const target = new URL(String(go.mock.calls[0][0]), 'http://x');
    expect(target.pathname).toBe(WEBHOOK);
    expect(target.searchParams.get('ref')).toBe('mail');
    expect(target.searchParams.get('code')).toBe('one-time-code');
  });

  it('says "webhook" while it opens it and when the server refuses', async () => {
    signedIn();
    issueCode.mockRejectedValue(new ApiError(403, 'forbidden', 'You are not a member of this workspace'));
    renderApp(signInPage(WEBHOOK));
    expect(await screen.findByRole('heading', { name: "Couldn't open this webhook" })).toBeTruthy();
    expect(screen.getByText('You are not a member of this workspace')).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
  });

  it.each([
    ['another site', `https://evil.example${WEBHOOK}`],
    ['a protocol-relative URL', `//evil.example${WEBHOOK}`],
    ['a way out of the path', '/webhook/acme/../../rest/me'],
    ['an encoded way out', '/webhook/acme/%2e%2e/x'],
    ['a backslash', '/webhook/acme/a\\b'],
    ['a resume URL', '/webhook-waiting/e1/x'],
    ['no path', '/webhook/acme'],
  ])('%s asks for no code', async (_label, returnTo) => {
    signedIn();
    renderApp(signInPage(returnTo));
    expect(await screen.findByText("This sign-in link isn't valid.")).toBeTruthy();
    expect(issueCode).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
  });

  it('tells a webhook path from a form path', () => {
    expect(isWebhookReturnPath(WEBHOOK)).toBe(true);
    expect(isWebhookReturnPath('/webhook-test/acme/a/b?x=1')).toBe(true);
    expect(isWebhookReturnPath(FORM)).toBe(false);
    expect(isWebhookReturnPath(null)).toBe(false);
    // form and chat checks are unchanged
    expect(isFormReturnPath(WEBHOOK)).toBe(false);
    expect(isFormReturnPath('/webhook/acme/hook-1/chat')).toBe(true);
    expect(isFormReturnPath(FORM)).toBe(true);
  });
});
