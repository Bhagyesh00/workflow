/**
 * P5-18 MCP OAuth2 credential in the credential modal: with Register Client Automatically on (the default)
 * the fixed client fields (authorization and token URLs, client ID and secret) are hidden, because the
 * server finds them on Connect; turning it off shows them again. Stored values are still sent back.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCurrentTenant } from '../src/api/client';
import { CredentialModal, credentialTypeIsA } from '../src/components/credentials/CredentialModal';
import { demoCredentialTypes } from '../src/demo/fixtures';
import { signedIn } from './backend';
import { server } from './setup';
import { withProviders } from './utils';

const HIDDEN_LABELS = ['Client ID', 'Client Secret', 'Authorization URL'];

function seed(data: Record<string, unknown>, type = 'mcpOAuth2Api') {
  const mock = signedIn();
  const now = new Date().toISOString();
  mock.credentials.push({
    id: 'cred-mcp',
    tenantId: mock.session!.tenantId,
    name: 'MCP account',
    type,
    data,
    createdAt: now,
    updatedAt: now,
  });
  server.use(http.get('/rest/credential-types', () => HttpResponse.json({ data: demoCredentialTypes })));
  return mock;
}

afterEach(() => {
  vi.restoreAllMocks();
  setCurrentTenant(null);
});

describe('MCP OAuth2 credential form (P5-18)', () => {
  it('hides the fixed client fields while automatic registration is on, and shows them when it is off', async () => {
    const user = userEvent.setup();
    const mock = seed({
      useDynamicClientRegistration: true,
      resourceUrl: 'https://mcp.example.com/mcp',
      clientId: 'client-7',
      authUrl: 'https://login.example.com/authorize',
    });
    withProviders(<CredentialModal open credentialId="cred-mcp" onClose={() => undefined} />);
    await screen.findByDisplayValue('MCP account', {}, { timeout: 10_000 });
    expect(screen.getByText('Resource URL')).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Register Client Automatically' }).getAttribute('aria-checked'),
    ).toBe('true');
    for (const label of HIDDEN_LABELS) expect(screen.queryByText(label)).toBeNull();
    expect(screen.queryByDisplayValue('client-7')).toBeNull();

    // the values the server found are sent back unchanged on save
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mock.requests.some((r) => r.method === 'PATCH')).toBe(true));
    const patch = mock.requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      data: {
        clientId: 'client-7',
        resourceUrl: 'https://mcp.example.com/mcp',
        useDynamicClientRegistration: true,
      },
    });

    await user.click(screen.getByRole('switch', { name: 'Register Client Automatically' }));
    for (const label of HIDDEN_LABELS) expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.getByDisplayValue('client-7')).toBeTruthy();
  });

  it('hides them on a new credential, where automatic registration is the default', async () => {
    seed({});
    withProviders(<CredentialModal open type="mcpOAuth2Api" onClose={() => undefined} />);
    expect(await screen.findByText('Resource URL', {}, { timeout: 10_000 })).toBeTruthy();
    for (const label of HIDDEN_LABELS) expect(screen.queryByText(label)).toBeNull();
  });

  it('keeps the fields of an ordinary OAuth2 credential', async () => {
    seed({ clientId: 'plain-client', authUrl: 'https://auth.example.com' }, 'oAuth2Api');
    withProviders(<CredentialModal open credentialId="cred-mcp" onClose={() => undefined} />);
    await screen.findByDisplayValue('MCP account', {}, { timeout: 10_000 });
    expect(screen.getByText('Client ID')).toBeTruthy();
    expect(screen.getByDisplayValue('plain-client')).toBeTruthy();
    expect(screen.queryByText('Register Client Automatically')).toBeNull();
  });

  it('tells a type that extends the MCP type from one that does not', () => {
    const types = new Map(
      [
        ...demoCredentialTypes,
        {
          ...demoCredentialTypes.find((t) => t.name === 'mcpOAuth2Api')!,
          name: 'myMcp',
          extends: ['mcpOAuth2Api'],
        },
      ].map((t) => [t.name, t]),
    );
    const get = (name: string) => types.get(name);
    expect(credentialTypeIsA(get, 'mcpOAuth2Api', 'mcpOAuth2Api')).toBe(true);
    expect(credentialTypeIsA(get, 'myMcp', 'mcpOAuth2Api')).toBe(true);
    expect(credentialTypeIsA(get, 'oAuth2Api', 'mcpOAuth2Api')).toBe(false);
  });
});
