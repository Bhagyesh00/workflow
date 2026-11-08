/**
 * P5-15 OAuth consent page: signed out goes to sign-in and back; a user approves a client and the page leaves
 * for the redirect; an unsafe or foreign redirect in the reply is not followed; a client name with markup is
 * text; deny; the scope picker; a bad flow says "Couldn't load this request".
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { consentNavigation, consentRedirectProblem } from '../src/pages/OAuthConsentPage';
import { DEMO_CONSENT_FLOW, mcpDemoState } from '../src/demo/mock-mcp';
import { backend, signedIn } from './backend';
import { renderApp } from './utils';

const go = vi.spyOn(consentNavigation, 'go');

beforeEach(() => go.mockImplementation(() => undefined));
afterEach(() => {
  go.mockReset();
  setCurrentTenant(null);
});

const PAGE = `/oauth/consent?flow=${DEMO_CONSENT_FLOW}`;

function sent(path: string) {
  return backend().requests.filter((r) => r.method === 'POST' && r.path === path);
}

describe('OAuth consent page (P5-15)', () => {
  it('sends a signed-out visitor to sign-in with a way back', async () => {
    const { router } = renderApp(PAGE);
    await waitFor(() => expect(router.state.location.pathname).toBe('/signin'));
    const redirect = new URLSearchParams(router.state.location.search).get('redirect');
    expect(redirect).toBe(`/oauth/consent?flow=${DEMO_CONSENT_FLOW}`);
    expect(go).not.toHaveBeenCalled();
  });

  it('shows the client, the host, the workspace and what each scope allows', async () => {
    signedIn();
    renderApp(PAGE);
    expect((await screen.findByTestId('consent-client')).textContent).toBe('Claude Desktop');
    expect(screen.getByText('Test Space')).toBeTruthy();
    expect(screen.getByTestId('consent-host').textContent).toBe('127.0.0.1:33418');
    expect(screen.getByText('Run workflows')).toBeTruthy();
    expect(screen.getByText(/Start workflows that are available to MCP/)).toBeTruthy();
  });

  it('approves and leaves for the redirect', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp(PAGE);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    const target = new URL(go.mock.calls[0][0]);
    expect(target.origin).toBe('http://127.0.0.1:33418');
    expect(target.pathname).toBe('/callback');
    expect(target.searchParams.get('code')).toMatch(/^demo-code-/);
    expect(sent('/consent/approve')[0].body).toMatchObject({ flow: DEMO_CONSENT_FLOW, approved: true });
    expect(await screen.findByText(/Returning to 127\.0\.0\.1:33418/)).toBeTruthy();
  });

  it('sends only the scopes that stay checked', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp(PAGE);
    await user.click(await screen.findByLabelText('Run workflows'));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(sent('/consent/approve')[0].body).toEqual({
      flow: DEMO_CONSENT_FLOW,
      approved: true,
      scopes: ['workflow:read', 'workflow:write', 'execution:read'],
    });
  });

  it('cannot approve with no scope left', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp(PAGE);
    for (const name of ['Read workflows', 'Change workflows', 'Run workflows', 'Read executions']) {
      await user.click(await screen.findByLabelText(name));
    }
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('denies and goes back with an error', async () => {
    const user = userEvent.setup();
    signedIn();
    renderApp(PAGE);
    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(new URL(go.mock.calls[0][0]).searchParams.get('error')).toBe('access_denied');
    expect(sent('/consent/approve')[0].body).toEqual({ flow: DEMO_CONSENT_FLOW, approved: false });
  });

  it.each([
    ['javascript:alert(document.cookie)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)'],
    ['file:///etc/passwd'],
    ['http://127.0.0.1:33418/callback?code=x#token'],
    ['https://evil.example/callback'],
    ['/relative/path'],
  ])('does not follow %s in the approve reply', async (redirectUrl) => {
    const user = userEvent.setup();
    signedIn();
    mcpDemoState(backend()).forcedRedirectUrl = redirectUrl;
    renderApp(PAGE);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText("Couldn't return to the client")).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not follow a bad reply to Deny either', async () => {
    const user = userEvent.setup();
    signedIn();
    mcpDemoState(backend()).forcedRedirectUrl = 'javascript:alert(1)';
    renderApp(PAGE);
    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(await screen.findByText("Couldn't return to the client")).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
  });

  it('shows a client name with markup as text', async () => {
    signedIn();
    const name = '<img src=x onerror="alert(1)"><b>Evil</b>';
    mcpDemoState(backend()).flows.set('markup', {
      clientName: name,
      scopes: ['workflow:read'],
      redirectUri: 'https://client.example.com/cb',
    });
    const { container } = renderApp('/oauth/consent?flow=markup');
    expect((await screen.findByTestId('consent-client')).textContent).toBe(name);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('says it could not load a request with a bad flow', async () => {
    signedIn();
    renderApp('/oauth/consent?flow=forged');
    expect(await screen.findByText("Couldn't load this request")).toBeTruthy();
    expect(screen.getByText(/expired or is not valid/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('says it could not load a link with no flow', async () => {
    signedIn();
    renderApp('/oauth/consent');
    expect(await screen.findByText("Couldn't load this request")).toBeTruthy();
    expect(backend().requests.filter((r) => r.path === '/consent/details')).toHaveLength(0);
  });
});

describe('consentRedirectProblem', () => {
  it('accepts an address on the shown host and refuses the rest', () => {
    expect(consentRedirectProblem('https://client.example.com/cb?code=1', 'client.example.com')).toBeNull();
    expect(consentRedirectProblem('cursor://anysphere.cursor-mcp/oauth/callback?code=1', 'anysphere.cursor-mcp')).toBeNull();
    expect(consentRedirectProblem('http://localhost:8080/cb', 'localhost:8080')).toBeNull();
    expect(consentRedirectProblem('http://client.example.com/cb', 'client.example.com')).not.toBeNull();
    expect(consentRedirectProblem('https://client.example.com/cb', 'other.example.com')).not.toBeNull();
    expect(consentRedirectProblem('', 'x')).not.toBeNull();
  });
});
