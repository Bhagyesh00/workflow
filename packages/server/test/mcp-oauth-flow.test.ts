/**
 * P5-14 done when: an MCP client registers, the user consents, and the client calls a tool. The real
 * `@modelcontextprotocol/sdk` 1.32.2 client runs the whole OAuth flow against `startMcpTestServer`
 * (RFC 9728 discovery from the 401, RFC 8414 metadata, RFC 7591 registration, PKCE S256, RFC 8707
 * resource) through its own `OAuthClientProvider`; a fake browser follows the authorize redirect to the
 * consent page and approves with the user's session.
 */
import { randomUUID } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as SdkStreamable } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { nodesAiPackage } from '@workflow/nodes-ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpOAuthIssuer, mcpServerUrl } from '../src/services/mcp/types';
import { createWorkflow, node, startMcpTestServer, TestClient, type TestServer } from './helpers';

let server: TestServer & { url: string; port: number };

beforeAll(async () => {
  server = await startMcpTestServer({ MCP_ACCESS_ENABLED: 'true' }, { nodePackages: [nodesAiPackage] });
});
afterAll(async () => {
  await server?.close();
});

const ip = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

async function signup() {
  const client = new TestClient(server.app, server.url, ip());
  const id = randomUUID().slice(0, 8);
  const res = await client.post('/rest/auth/signup', {
    email: `mcp-flow-${id}@example.com`,
    password: 'Passw0rd!',
    name: `Flow User ${id}`,
    workspaceName: `Flow ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as {
    user: { id: string; email: string };
    tenant: { id: string; slug: string };
  };
  return { client, ...data };
}

/** the sdk's provider as a desktop MCP client would write it; the "browser" only records the URL */
class FakeBrowserProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  authorizationUrl?: URL;
  readonly stateValue = randomUUID();
  constructor(readonly redirect = 'http://127.0.0.1:53682/callback') {}

  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Flow test client',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return this.stateValue;
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** the browser: authorize redirects to the consent page, the signed-in user approves */
async function consentInBrowser(provider: FakeBrowserProvider, user: TestClient) {
  expect(provider.authorizationUrl).toBeDefined();
  const authorize = await fetch(provider.authorizationUrl as URL, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const consentPage = new URL(authorize.headers.get('location') ?? '');
  expect(`${consentPage.origin}${consentPage.pathname}`).toBe(`${server.url}/oauth/consent`);
  const flow = consentPage.searchParams.get('flow') ?? '';
  const details = await user.data(user.get(`/rest/consent/details?flow=${encodeURIComponent(flow)}`));
  const { redirectUrl } = await user.data(user.post('/rest/consent/approve', { flow, approved: true }));
  const back = new URL(redirectUrl);
  return { details, back };
}

describe('MCP OAuth flow with the sdk client', () => {
  it('registers, the user consents, and the client calls a tool on the tenant server', async () => {
    const owner = await signup();
    await owner.client.data(
      owner.client.post('/rest/workflows', {
        name: 'Flow visible workflow',
        nodes: [node('Start', 'core.manualTrigger', {}, [0, 0])],
        connections: {},
        settings: { availableInMCP: true },
      }),
    );
    const url = mcpServerUrl(server.ctx.config, owner.tenant.slug);
    const provider = new FakeBrowserProvider();

    // 1. no token: the 401 starts discovery, registration and the authorize redirect
    const first = new SdkClient({ name: 'flow-test', version: '1.0.0' });
    await expect(
      first.connect(new SdkStreamable(new URL(url), { authProvider: provider })),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.info?.client_id).toBeTruthy();
    expect(await server.ctx.repos.mcpOAuth.countClients(owner.tenant.id)).toBe(1);
    const authorizeUrl = provider.authorizationUrl as URL;
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(
      `${mcpOAuthIssuer(server.ctx.config, owner.tenant.slug)}/authorize`,
    );
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('resource')).toBe(url);

    // 2. the fake browser: consent page, approve, back to the client's loopback redirect
    const { details, back } = await consentInBrowser(provider, owner.client);
    expect(details).toMatchObject({
      clientName: 'Flow test client',
      resource: url,
      redirectHost: '127.0.0.1:53682',
    });
    expect(details.scopes).toContain('workflow:read');
    expect(`${back.origin}${back.pathname}`).toBe(provider.redirect);
    expect(back.searchParams.get('state')).toBe(provider.stateValue);
    expect(back.searchParams.get('iss')).toBe(mcpOAuthIssuer(server.ctx.config, owner.tenant.slug));
    const code = back.searchParams.get('code') ?? '';
    expect(code).toBeTruthy();

    // 3. the client swaps the code (PKCE, resource) and calls a tool
    const transport = new SdkStreamable(new URL(url), { authProvider: provider });
    await transport.finishAuth(code);
    expect(provider.saved?.access_token.startsWith('wfo_at_')).toBe(true);
    expect(provider.saved?.refresh_token?.startsWith('wfo_rt_')).toBe(true);
    // stored as hashes only
    const raw = await server.ctx.database.pool.query(
      'SELECT count(*)::int AS n FROM oauth_access_tokens WHERE token_hash = $1',
      [provider.saved?.access_token],
    );
    expect(raw.rows[0].n).toBe(0);

    const mcp = new SdkClient({ name: 'flow-test', version: '1.0.0' });
    await mcp.connect(new SdkStreamable(new URL(url), { authProvider: provider }));
    try {
      const { tools } = await mcp.listTools();
      expect(tools.map((t) => t.name)).toContain('search_workflows');
      const result = await mcp.callTool({ name: 'search_workflows', arguments: {} });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('');
      expect(text).toContain('Flow visible workflow');
    } finally {
      await mcp.close();
    }

    // the audit row of the call names the OAuth client, never a token
    const audit = await server.ctx.database.pool.query(
      `SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'mcp.tool_called'`,
      [owner.tenant.id],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ via: 'oauth', clientId: provider.info?.client_id });
    expect(JSON.stringify(audit.rows)).not.toContain(provider.saved?.access_token as string);
  });

  it('signs in to an MCP Server Trigger with workspace sign-in and calls its tool', async () => {
    const owner = await signup();
    const path = `signin-${randomUUID().slice(0, 8)}`;
    const wf = await createWorkflow(owner.client, {
      name: 'Signed in trigger',
      nodes: [
        node('MCP Server Trigger', 'ai.mcpTrigger', { path, authentication: 'n8nOAuth2' }, [0, 0], {
          webhookId: randomUUID(),
        }),
        node('Calculator', 'ai.toolCalculator', {}, [0, 200]),
      ],
      connections: { Calculator: { ai_tool: [[{ node: 'MCP Server Trigger', type: 'ai_tool', index: 0 }]] } },
    });
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`));
    const url = `${server.url}/mcp/${owner.tenant.slug}/${path}`;
    const provider = new FakeBrowserProvider('http://localhost:53683/cb');

    const first = new SdkClient({ name: 'trigger-flow', version: '1.0.0' });
    await expect(
      first.connect(new SdkStreamable(new URL(url), { authProvider: provider })),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect((provider.authorizationUrl as URL).searchParams.get('resource')).toBe(url);
    const { details, back } = await consentInBrowser(provider, owner.client);
    expect(details.resource).toBe(url);
    const transport = new SdkStreamable(new URL(url), { authProvider: provider });
    await transport.finishAuth(back.searchParams.get('code') ?? '');

    const mcp = new SdkClient({ name: 'trigger-flow', version: '1.0.0' });
    await mcp.connect(new SdkStreamable(new URL(url), { authProvider: provider }));
    try {
      const result = await mcp.callTool({ name: 'Calculator', arguments: { input: '6 * 7' } });
      expect((result.content as Array<{ text?: string }>)[0]?.text).toBe('42');
    } finally {
      await mcp.close();
    }
  });
});
