/** P4-16: /form-auth asks for the one-time code with the session and goes back to the form. */
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { formAuthApi } from '../src/api/endpoints';
import { formReturn, isFormReturnPath } from '../src/pages/auth/FormSignInPage';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

let go: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  go = vi.spyOn(formReturn, 'go').mockImplementation(() => {});
});
afterEach(() => {
  go.mockRestore();
});

const pageOf = (returnTo: string) => `/form-auth?redirect=${encodeURIComponent(returnTo)}`;

describe('with a session', () => {
  it('posts for a code and returns to the form with it', async () => {
    signedIn();
    renderApp(pageOf('/form/acme/survey'));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    const target = new URL(String(go.mock.calls[0][0]), 'http://x');
    expect(target.pathname).toBe('/form/acme/survey');
    expect(target.searchParams.get('code')).toBeTruthy();
    const sent = backend().requests.filter((r) => r.path === '/form-auth/code');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ returnTo: '/form/acme/survey' });
  });

  it('keeps the query of the form', async () => {
    signedIn();
    renderApp(pageOf('/form-waiting/e1/sig?ref=mail'));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    const target = new URL(String(go.mock.calls[0][0]), 'http://x');
    expect(target.pathname).toBe('/form-waiting/e1/sig');
    expect(target.searchParams.get('ref')).toBe('mail');
    expect(target.searchParams.get('code')).toBeTruthy();
  });

  it('shows the reason when the server refuses, and asks for no second code', async () => {
    signedIn();
    const issueCode = vi
      .spyOn(formAuthApi, 'issueCode')
      .mockRejectedValue(new ApiError(403, 'forbidden', 'You are not a member of this workspace'));
    renderApp(pageOf('/form/other/survey'));
    expect(await screen.findByRole('heading', { name: "Couldn't open this form" })).toBeTruthy();
    expect(screen.getByText('You are not a member of this workspace')).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
    expect(issueCode).toHaveBeenCalledTimes(1);
    issueCode.mockRestore();
    expect(screen.getByRole('link', { name: 'Sign in with another account' }).getAttribute('href')).toContain(
      '/signin?redirect=',
    );
  });
});

describe('signed out', () => {
  it('goes to sign-in and keeps the way back to this page', async () => {
    backend().session = null;
    const { router } = renderApp(pageOf('/form/acme/survey'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
    const redirect = new URLSearchParams(router.state.location.search).get('redirect');
    expect(redirect).toBe(pageOf('/form/acme/survey'));
    expect(go).not.toHaveBeenCalled();
  });
});

describe('a bad link', () => {
  it.each([
    ['nothing', '/form-auth'],
    ['another site', pageOf('https://evil.example/form/x')],
    ['a protocol-relative URL', pageOf('//evil.example/form/x')],
    ['another path', pageOf('/rest/me')],
    ['a look-alike path', pageOf('/formx/a')],
    ['a way out of the form path', pageOf('/form/../rest/me')],
    ['a backslash', pageOf('/form/a\\..\\b')],
  ])('%s asks for no code and goes nowhere', async (_label, path) => {
    signedIn();
    renderApp(path);
    expect(await screen.findByRole('heading', { name: "Couldn't open this form" })).toBeTruthy();
    expect(screen.getByText("This sign-in link isn't valid.")).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
    expect(backend().requests.some((r) => r.path === '/form-auth/code')).toBe(false);
  });
});

describe('isFormReturnPath', () => {
  it.each(['/form/a/b', '/form-test/a/b?x=1', '/form-waiting/e1/sig', '/form-waiting/e1/sig?a=%2F'])(
    'takes %s',
    (path) => {
      expect(isFormReturnPath(path)).toBe(true);
    },
  );

  it.each(['', '/form', '/form/%2e%2e/x', '/form/a/%2E%2e/x', '/form/a b', 'form/a', '/signin'])(
    'refuses %j',
    (path) => {
      expect(isFormReturnPath(path)).toBe(false);
    },
  );
});

describe('the demo route', () => {
  it('answers a code to a session, 401 to none, 400 to a bad path', async () => {
    signedIn();
    const ok = await backend().handle({
      method: 'POST',
      path: '/form-auth/code',
      body: { returnTo: '/form/acme/survey' },
    });
    expect(ok.status).toBe(200);
    const bad = await backend().handle({
      method: 'POST',
      path: '/form-auth/code',
      body: { returnTo: '/rest/me' },
    });
    expect(bad.status).toBe(400);
    backend().session = null;
    const none = await backend().handle({
      method: 'POST',
      path: '/form-auth/code',
      body: { returnTo: '/form/acme/survey' },
    });
    expect(none.status).toBe(401);
  });
});
