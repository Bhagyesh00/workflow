/** P5-57: /form-auth also signs a visitor in for a Chat Trigger (a chat path ending in /chat). */
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { formAuthApi } from '../src/api/endpoints';
import { formReturn, isChatPath, isFormReturnPath } from '../src/pages/auth/FormSignInPage';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

let go: ReturnType<typeof vi.spyOn>;
let issueCode: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  go = vi.spyOn(formReturn, 'go').mockImplementation(() => {});
  issueCode = vi.spyOn(formAuthApi, 'issueCode').mockResolvedValue({ code: 'one-time-code' });
});
afterEach(() => {
  go.mockRestore();
  issueCode.mockRestore();
});

const pageOf = (returnTo: string) => `/form-auth?redirect=${encodeURIComponent(returnTo)}`;
const CHAT = '/webhook/acme/hook-1/chat';

describe('with a session', () => {
  it('asks for a code for the chat path and returns to the chat with it', async () => {
    signedIn();
    renderApp(pageOf(CHAT));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(issueCode).toHaveBeenCalledWith(CHAT);
    const target = new URL(String(go.mock.calls[0][0]), 'http://x');
    expect(target.pathname).toBe(CHAT);
    expect(target.searchParams.get('code')).toBe('one-time-code');
  });

  it('works for a test chat and keeps the query of the page', async () => {
    signedIn();
    renderApp(pageOf('/webhook-test/acme/hook-1/chat?ref=mail'));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    const target = new URL(String(go.mock.calls[0][0]), 'http://x');
    expect(target.pathname).toBe('/webhook-test/acme/hook-1/chat');
    expect(target.searchParams.get('ref')).toBe('mail');
    expect(target.searchParams.get('code')).toBe('one-time-code');
  });

  it('says "chat" while it opens it', async () => {
    signedIn();
    issueCode.mockReturnValue(new Promise(() => {}));
    renderApp(pageOf(CHAT));
    expect(await screen.findByText('Opening the chat')).toBeTruthy();
  });

  it('says "chat" when the server refuses, shows the reason and asks for no second code', async () => {
    signedIn();
    issueCode.mockRejectedValue(new ApiError(403, 'forbidden', 'You are not a member of this workspace'));
    renderApp(pageOf(CHAT));
    expect(await screen.findByRole('heading', { name: "Couldn't open this chat" })).toBeTruthy();
    expect(screen.getByText('You are not a member of this workspace')).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
    expect(issueCode).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Sign in with another account' }).getAttribute('href')).toContain(
      '/signin?redirect=',
    );
  });

  it('still says "form" for a form path', async () => {
    signedIn();
    issueCode.mockRejectedValue(new ApiError(403, 'forbidden', 'No'));
    renderApp(pageOf('/form/acme/survey'));
    expect(await screen.findByRole('heading', { name: "Couldn't open this form" })).toBeTruthy();
  });
});

describe('signed out', () => {
  it('goes to sign-in and keeps the way back to the chat', async () => {
    backend().session = null;
    issueCode.mockRestore();
    const { router } = renderApp(pageOf(CHAT));
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
    const redirect = new URLSearchParams(router.state.location.search).get('redirect');
    expect(redirect).toBe(pageOf(CHAT));
    expect(go).not.toHaveBeenCalled();
  });
});

describe('a bad chat link', () => {
  it.each([
    ['another site', pageOf(`https://evil.example${CHAT}`)],
    ['a protocol-relative URL', pageOf(`//evil.example${CHAT}`)],
    ['a protocol-relative webhook URL', pageOf('//evil.example/webhook/acme/hook-1')],
    ['a webhook path with no workspace', pageOf('/webhook//evil.example/x')],
    ['a resume URL', pageOf('/webhook-waiting/e1/chat')],
    ['a way out of the path', pageOf('/webhook/acme/../../rest/chat')],
    ['an encoded way out', pageOf('/webhook/acme/%2e%2e/chat')],
    ['a backslash', pageOf('/webhook/acme/a\\b/chat')],
  ])('%s asks for no code and goes nowhere', async (_label, path) => {
    signedIn();
    renderApp(path);
    expect(await screen.findByText("This sign-in link isn't valid.")).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
    expect(issueCode).not.toHaveBeenCalled();
  });
});

// P6-87: a webhook path is a return target too; the server decides whether it is a chat or a signed-in webhook
describe('a webhook path that is no chat', () => {
  it.each([
    ['a path not ending in /chat', '/webhook/acme/hook-1/chat/more'],
    ['a look-alike ending', '/webhook/acme/hook-1/notchat'],
  ])('%s asks the server for a code and shows its refusal', async (_label, path) => {
    signedIn();
    issueCode.mockRejectedValue(
      new ApiError(403, 'forbidden', "You aren't a member of the workspace this form belongs to"),
    );
    renderApp(pageOf(path));
    expect(await screen.findByRole('heading', { name: "Couldn't open this webhook" })).toBeTruthy();
    expect(issueCode).toHaveBeenCalledWith(path);
    expect(go).not.toHaveBeenCalled();
  });
});

describe('isChatPath and isFormReturnPath', () => {
  it.each([CHAT, '/webhook-test/acme/a/b/chat', `${CHAT}?ref=1`])('takes the chat path %s', (path) => {
    expect(isChatPath(path)).toBe(true);
    expect(isFormReturnPath(path)).toBe(true);
  });

  it.each(['/webhook/acme/chat', '/webhook/acme/a/chat/x', '/webhook-waiting/e/a/chat', '/form/a/chat', ''])(
    'does not take %j as a chat path',
    (path) => {
      expect(isChatPath(path)).toBe(false);
    },
  );

  it('keeps the form paths', () => {
    expect(isFormReturnPath('/form/a/b')).toBe(true);
    expect(isFormReturnPath('/form-waiting/e1/sig')).toBe(true);
    expect(isFormReturnPath('/webhook/acme/a/b')).toBe(false);
  });
});

describe('the demo route', () => {
  const ask = (returnTo: string) =>
    backend().handle({ method: 'POST', path: '/form-auth/code', body: { returnTo } });

  it('answers a code for a chat path, as the server', async () => {
    signedIn();
    for (const path of [CHAT, '/webhook-test/acme/a/b/chat', `${CHAT}?ref=1`, '/form/acme/survey']) {
      expect((await ask(path)).status).toBe(200);
    }
  });

  it('answers 400 to a path the server refuses', async () => {
    signedIn();
    for (const path of [
      '/webhook/acme/chat',
      '/webhook-waiting/e1/a/chat',
      '/webhook/acme/../../rest/chat',
      '/rest/me',
    ]) {
      expect((await ask(path)).status).toBe(400);
    }
  });
});
