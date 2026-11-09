/**
 * P5-14 MCP OAuth server, the rules one by one against the real app on a free port: registration limits
 * and redirect schemes, the redirect check before any redirect, PKCE S256 only, resource binding (server
 * and trigger), consent scopes and membership, code and refresh token rules, revoke, removed users,
 * tenant isolation, the sweep, Host, CORS, the admin routes and the rate limits.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { nodesAiPackage } from '@workflow/nodes-ai';
import type { DataObject } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticateMcpBearer } from '../src/services/mcp/auth';
import { MCP_OAUTH_FLOW_KIND } from '../src/services/mcp/oauth/authorize';
import { redirectUriProblem } from '../src/services/mcp/oauth/clients';
import { verifyMcpOAuthToken } from '../src/services/mcp/oauth/tokens';
import { MCP_SCOPES, mcpOAuthIssuer, mcpServerUrl } from '../src/services/mcp/types';
import {
  createTestServer,
  createWorkflow,
  node,
  startMcpTestServer,
  TestClient,
  type TestServer,
} from './helpers';

type Server = TestServer & { url: string; port: number };
let server: Server;

const HIGH = '1000';
beforeAll(async () => {
  server = await startMcpTestServer(
    {
      MCP_ACCESS_ENABLED: 'true',
      MCP_MAX_REGISTERED_CLIENTS: '3',
      OAUTH_SERVER_REGISTER_RATE_LIMIT: HIGH,
      OAUTH_SERVER_AUTHORIZE_RATE_LIMIT: HIGH,
      OAUTH_SERVER_TOKEN_RATE_LIMIT: HIGH,
      OAUTH_SERVER_REVOKE_RATE_LIMIT: HIGH,
      OAUTH_SERVER_WELL_KNOWN_RATE_LIMIT: HIGH,
    },
    { nodePackages: [nodesAiPackage] },
  );
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
    email: `mcp-oauth-${id}@example.com`,
    password: 'Passw0rd!',
    name: `OAuth User ${id}`,
    workspaceName: `OAuth ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as { user: { id: string }; tenant: { id: string; slug: string } };
  return { client, ...data, issuer: mcpOAuthIssuer(server.ctx.config, data.tenant.slug) };
}
type User = Awaited<ReturnType<typeof signup>>;

/** another user who is also an editor of `owner`'s workspace (their session stays on their own one) */
async function memberOf(owner: User, role: 'editor' | 'viewer' | 'member' = 'editor') {
  const other = await signup();
  await server.ctx.repos.memberships.add(owner.tenant.id, other.user.id, role);
  await server.ctx.repos.projects.ensurePersonal(
    owner.tenant.id,
    (await server.ctx.repos.users.get(other.user.id))!,
  );
  return other;
}

interface JsonBody {
  error: string;
  error_description: string;
  client_id: string;
  client_secret: string;
  token_endpoint_auth_method: string;
  code_challenge_methods_supported: string[];
  resource: string;
}
const jsonOf = async (res: Response) => (await res.json()) as JsonBody;

const register = (slug: string, body: unknown) =>
  fetch(`${server.url}/mcp-oauth/${slug}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
}

async function newClient(
  slug: string,
  redirectUris = ['http://127.0.0.1:7777/cb'],
  method: 'none' | 'client_secret_basic' | 'client_secret_post' = 'none',
): Promise<RegisteredClient> {
  const res = await register(slug, {
    client_name: 'Test client',
    redirect_uris: redirectUris,
    token_endpoint_auth_method: method,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as RegisteredClient;
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const authorize = (slug: string, params: Record<string, string>) =>
  fetch(`${server.url}/mcp-oauth/${slug}/authorize?${new URLSearchParams(params)}`, { redirect: 'manual' });

const flowOf = (res: Response) => {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '');
  expect(`${location.origin}${location.pathname}`).toBe(`${server.url}/oauth/consent`);
  return location.searchParams.get('flow') ?? '';
};

/** authorize, consent, and the code of the redirect back */
async function codeFor(
  user: User,
  client: RegisteredClient,
  options: {
    resource?: string;
    scope?: string;
    approveScopes?: string[];
    redirectUri?: string;
    slug?: string;
  } = {},
) {
  const { verifier, challenge } = pkce();
  const redirectUri = options.redirectUri ?? client.redirect_uris[0];
  const res = await authorize(options.slug ?? user.tenant.slug, {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    ...(options.resource ? { resource: options.resource } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
  });
  const flow = flowOf(res);
  const { redirectUrl } = await user.client.data(
    user.client.post('/rest/consent/approve', {
      flow,
      approved: true,
      ...(options.approveScopes ? { scopes: options.approveScopes } : {}),
    }),
  );
  const back = new URL(redirectUrl);
  expect(back.searchParams.get('state')).toBe('st-1');
  return { code: back.searchParams.get('code') ?? '', verifier, redirectUri, back };
}

const token = async (slug: string, values: Record<string, string>, headers: Record<string, string> = {}) => {
  const res = await fetch(`${server.url}/mcp-oauth/${slug}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(values).toString(),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, string> };
};

const revoke = async (slug: string, values: Record<string, string>) => {
  const res = await fetch(`${server.url}/mcp-oauth/${slug}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString(),
  });
  return res.status;
};

/** a token pair for the client (public client unless `secret` is given) */
async function grant(user: User, client: RegisteredClient, options: Parameters<typeof codeFor>[2] = {}) {
  const { code, verifier, redirectUri } = await codeFor(user, client, options);
  const res = await token(options.slug ?? user.tenant.slug, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    ...(options.resource ? { resource: options.resource } : {}),
  });
  expect(res.status).toBe(200);
  return res.body as { access_token: string; refresh_token: string; scope: string };
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } },
};

/** the status of an `initialize` at an MCP URL with this Bearer token */
const mcpStatus = async (url: string, accessToken: string) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(INIT),
  });
  await res.body?.cancel();
  return res.status;
};

/** an active MCP Server Trigger; with workspace sign-in (the default) its URL is a resource of the tenant */
async function signedInTrigger(user: User, authentication = 'n8nOAuth2') {
  const path = `oauth-${randomUUID().slice(0, 8)}`;
  const wf = await createWorkflow(user.client, {
    name: `Trigger ${path}`,
    nodes: [
      node('MCP Server Trigger', 'ai.mcpTrigger', { path, authentication }, [0, 0], {
        webhookId: randomUUID(),
      }),
      node('Calculator', 'ai.toolCalculator', {}, [0, 200]),
    ],
    connections: { Calculator: { ai_tool: [[{ node: 'MCP Server Trigger', type: 'ai_tool', index: 0 }]] } },
  });
  await user.client.data(user.client.post(`/rest/workflows/${wf.id}/activate`));
  return { ...wf, url: `${server.url}/mcp/${user.tenant.slug}/${path}` };
}

describe('registration (RFC 7591)', () => {
  it('holds the limits on redirect URIs and names, and caps clients per workspace', async () => {
    const owner = await signup();
    const slug = owner.tenant.slug;
    const many = Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${9000 + i}/cb`);
    const tooMany = await register(slug, { redirect_uris: many, token_endpoint_auth_method: 'none' });
    expect(tooMany.status).toBe(400);
    expect((await jsonOf(tooMany)).error).toBe('invalid_redirect_uri');
    const long = await register(slug, {
      redirect_uris: [`https://app.example.com/${'a'.repeat(2049 - 'https://app.example.com/'.length)}`],
    });
    expect(long.status).toBe(400);
    const name = await register(slug, {
      client_name: 'n'.repeat(256),
      redirect_uris: ['https://app.example.com/cb'],
    });
    expect(name.status).toBe(400);
    expect((await jsonOf(name)).error).toBe('invalid_client_metadata');
    const none = await register(slug, { redirect_uris: [] });
    expect(none.status).toBe(400);

    // the longest name, ten URIs of 2048 characters; a confidential client by default (RFC 7591)
    const ok = await register(slug, {
      client_name: 'n'.repeat(255),
      redirect_uris: Array.from(
        { length: 10 },
        (_, i) => `https://app${i}.example.com/${'b'.repeat(2048 - 'https://appX.example.com/'.length)}`,
      ),
    });
    expect(ok.status).toBe(201);
    const body = await jsonOf(ok);
    expect(body.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(body.client_secret).toMatch(/^wfocs_/);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    // only the hash is stored
    const row = await server.ctx.repos.mcpOAuth.getClient(owner.tenant.id, body.client_id);
    expect(row?.clientSecretHash).toBe(createHash('sha256').update(body.client_secret).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(body.client_secret);

    await newClient(slug);
    await newClient(slug);
    const capped = await register(slug, {
      redirect_uris: ['http://localhost/cb'],
      token_endpoint_auth_method: 'none',
    });
    expect(capped.status).toBe(400);
    expect((await jsonOf(capped)).error_description).toContain('limit of 3');
    expect(await owner.client.data(owner.client.get('/rest/mcp/instance-stats'))).toEqual({
      registeredClients: 3,
      maxRegisteredClients: 3,
    });
    // the cap is per workspace
    const other = await signup();
    await newClient(other.tenant.slug);
  });

  it('refuses each unsafe redirect scheme, a fragment and http on a public host', async () => {
    const owner = await signup();
    const refused = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,hi',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'https://app.example.com/cb#frag',
      'http://app.example.com/cb',
      'http://user:pw@127.0.0.1/cb',
    ];
    for (const uri of refused) {
      expect(redirectUriProblem(uri), uri).not.toBeNull();
      const res = await register(owner.tenant.slug, {
        redirect_uris: [uri],
        token_endpoint_auth_method: 'none',
      });
      expect(res.status, uri).toBe(400);
      expect((await jsonOf(res)).error, uri).toBe('invalid_redirect_uri');
    }
    for (const uri of [
      'http://127.0.0.1:9/cb',
      'http://localhost/cb',
      'http://[::1]:8080/cb',
      'https://app.example.com/cb',
      'cursor://anysphere.cursor-retrieval/oauth/callback',
    ]) {
      expect(redirectUriProblem(uri), uri).toBeNull();
    }
    expect(await server.ctx.repos.mcpOAuth.countClients(owner.tenant.id)).toBe(0);
  });
});

describe('authorize', () => {
  it('gives no redirect for a redirect URI the client did not register (checked first)', async () => {
    const owner = await signup();
    const client = await newClient(owner.tenant.slug, [
      'http://127.0.0.1:7777/cb',
      'http://127.0.0.1:7777/other',
    ]);
    const { challenge } = pkce();
    const base = {
      response_type: 'code',
      client_id: client.client_id,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    const res = await authorize(owner.tenant.slug, {
      ...base,
      redirect_uri: 'https://attacker.example/cb',
      // also wrong: the redirect is still checked before anything else
      resource: 'https://evil.example/mcp',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    expect((await jsonOf(res)).error).toBe('invalid_request');
    // several registered URIs and none named: no redirect either
    const unnamed = await authorize(owner.tenant.slug, base);
    expect(unnamed.status).toBe(400);
    expect(unnamed.headers.get('location')).toBeNull();
    // an unknown client
    const unknown = await authorize(owner.tenant.slug, { ...base, client_id: randomUUID() });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('location')).toBeNull();
  });

  it("checks the workspace's allowed list: exact, loopback on any port, empty adds no rule", async () => {
    const owner = await signup();
    const client = await newClient(owner.tenant.slug, [
      'https://app.example.com/cb',
      'https://other.example.com/cb',
      'http://127.0.0.1:5555/cb',
    ]);
    const { challenge } = pkce();
    const go = (redirect: string) =>
      authorize(owner.tenant.slug, {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
    // empty list: every registered URI passes
    expect((await go('https://other.example.com/cb')).status).toBe(302);

    const patch = await owner.client.patch('/rest/mcp/oauth/allowed-redirect-uris', {
      allowedRedirectUris: ['https://app.example.com/cb', 'http://127.0.0.1/cb'],
    });
    expect(patch.statusCode).toBe(200);
    expect(await owner.client.data(owner.client.get('/rest/mcp/oauth/allowed-redirect-uris'))).toEqual({
      allowedRedirectUris: ['https://app.example.com/cb', 'http://127.0.0.1/cb'],
    });
    const blocked = await go('https://other.example.com/cb');
    expect(blocked.status).toBe(400);
    expect(blocked.headers.get('location')).toBeNull();
    flowOf(await go('https://app.example.com/cb'));
    flowOf(await go('http://127.0.0.1:5555/cb'));

    // http on a public host is refused in the list too; editors may not change it
    const bad = await owner.client.patch('/rest/mcp/oauth/allowed-redirect-uris', {
      allowedRedirectUris: ['http://public.example.com/cb'],
    });
    expect(bad.statusCode).toBe(400);
    const editor = await memberOf(owner);
    await editor.client.data(editor.client.post('/rest/auth/switch-tenant', { tenantId: owner.tenant.id }));
    expect((await editor.client.get('/rest/mcp/oauth/allowed-redirect-uris')).statusCode).toBe(403);
    expect(
      (await editor.client.patch('/rest/mcp/oauth/allowed-redirect-uris', { allowedRedirectUris: [] }))
        .statusCode,
    ).toBe(403);
  });

  it('requires PKCE S256: plain and a missing challenge go back to the client as invalid_request', async () => {
    const owner = await signup();
    const client = await newClient(owner.tenant.slug);
    const { challenge } = pkce();
    const variants: Record<string, string>[] = [
      { code_challenge: challenge, code_challenge_method: 'plain' },
      { code_challenge: challenge },
      { code_challenge_method: 'S256' },
    ];
    for (const params of variants) {
      const res = await authorize(owner.tenant.slug, {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        state: 'abc',
        ...params,
      });
      expect(res.status).toBe(302);
      const back = new URL(res.headers.get('location') ?? '');
      expect(`${back.origin}${back.pathname}`).toBe(client.redirect_uris[0]);
      expect(back.searchParams.get('error')).toBe('invalid_request');
      expect(back.searchParams.get('state')).toBe('abc');
      expect(back.searchParams.get('iss')).toBe(owner.issuer);
      expect(back.searchParams.get('code')).toBeNull();
    }
    const meta = await jsonOf(
      await fetch(`${server.url}/.well-known/oauth-authorization-server/mcp-oauth/${owner.tenant.slug}`),
    );
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('refuses an unknown resource with invalid_target, a long state, and drops unknown scopes', async () => {
    const owner = await signup();
    const client = await newClient(owner.tenant.slug);
    const { challenge } = pkce();
    const base = {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    const other = await signup();
    for (const resource of [
      'https://evil.example/mcp',
      mcpServerUrl(server.ctx.config, other.tenant.slug),
      `${server.url}/mcp/${owner.tenant.slug}/no-such-trigger`,
    ]) {
      const res = await authorize(owner.tenant.slug, { ...base, resource });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_target');
    }
    const long = await authorize(owner.tenant.slug, { ...base, state: 's'.repeat(1025) });
    expect(new URL(long.headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_request');
    const flow = flowOf(
      await authorize(owner.tenant.slug, {
        ...base,
        scope: 'workflow:read bogus:scope tag:read',
        state: 's'.repeat(1024),
      }),
    );
    const details = await owner.client.data(
      owner.client.get(`/rest/consent/details?flow=${encodeURIComponent(flow)}`),
    );
    expect(details).toMatchObject({
      clientName: 'Test client',
      resource: mcpServerUrl(server.ctx.config, owner.tenant.slug),
      scopes: ['workflow:read', 'tag:read'],
      redirectHost: '127.0.0.1:7777',
    });
  });
});

describe('consent', () => {
  it('is 403 for a non-member, and a form token of another feature is not a flow', async () => {
    const owner = await signup();
    const client = await newClient(owner.tenant.slug);
    const { challenge } = pkce();
    const flow = flowOf(
      await authorize(owner.tenant.slug, {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    );
    const stranger = await signup();
    const q = `/rest/consent/details?flow=${encodeURIComponent(flow)}`;
    expect((await stranger.client.get(q)).statusCode).toBe(403);
    expect((await stranger.client.post('/rest/consent/approve', { flow, approved: true })).statusCode).toBe(
      403,
    );
    // no session: 401
    expect((await new TestClient(server.app, server.url).get(q)).statusCode).toBe(401);

    const payload: DataObject = server.ctx.formTokens.verify(flow) ?? {};
    const forged = server.ctx.formTokens.sign({ ...payload, kind: 'form-user' }, 300);
    const forgedRes = await owner.client.get(`/rest/consent/details?flow=${encodeURIComponent(forged)}`);
    expect(forgedRes.statusCode).toBe(400);
    expect(payload.kind).toBe(MCP_OAUTH_FLOW_KIND);
    // a member whose session is on another workspace may consent for the flow's one
    const member = await memberOf(owner, 'viewer');
    expect((await member.client.get(q)).statusCode).toBe(200);
  });

  it('keeps only the scopes of the flow token, and deny gives access_denied', async () => {
    const owner = await signup();
    const client = await newClient(owner.tenant.slug);
    const tokens = await grant(owner, client, {
      scope: 'workflow:read tag:read',
      approveScopes: ['workflow:read', 'credential:read', 'workflow:write'],
    });
    expect(tokens.scope).toBe('workflow:read');
    const consent = await server.ctx.repos.mcpOAuth.getConsent(
      owner.tenant.id,
      owner.user.id,
      client.client_id,
    );
    expect(consent?.scope).toEqual(['workflow:read']);
    const caller = await authenticateMcpBearer(
      server.ctx,
      owner.tenant.slug,
      `Bearer ${tokens.access_token}`,
      mcpServerUrl(server.ctx.config, owner.tenant.slug),
    );
    expect(caller).toMatchObject({ via: 'oauth', scopes: ['workflow:read'], role: 'owner' });

    const { challenge } = pkce();
    const flow = flowOf(
      await authorize(owner.tenant.slug, {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'deny-me',
      }),
    );
    const outside = await owner.client.post('/rest/consent/approve', {
      flow,
      approved: true,
      scopes: ['nope'],
    });
    expect(outside.statusCode).toBe(400);
    const { redirectUrl } = await owner.client.data(
      owner.client.post('/rest/consent/approve', { flow, approved: false }),
    );
    const back = new URL(redirectUrl);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('deny-me');
    expect(back.searchParams.get('code')).toBeNull();
  });
});

describe('token endpoint', () => {
  it('refuses code reuse, another client, another redirect_uri and a wrong verifier', async () => {
    const owner = await signup();
    const slug = owner.tenant.slug;
    const client = await newClient(slug, ['http://127.0.0.1:7777/cb', 'http://127.0.0.1:7777/two']);
    const otherClient = await newClient(slug);
    const swap = (code: string, verifier: string, redirectUri: string, clientId = client.client_id) =>
      token(slug, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
      });

    const a = await codeFor(owner, client);
    const first = await swap(a.code, a.verifier, a.redirectUri);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(first.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect((await swap(a.code, a.verifier, a.redirectUri)).body.error).toBe('invalid_grant');

    const b = await codeFor(owner, client);
    expect((await swap(b.code, b.verifier, b.redirectUri, otherClient.client_id)).body.error).toBe(
      'invalid_grant',
    );
    // the code was spent by that attempt
    expect((await swap(b.code, b.verifier, b.redirectUri)).body.error).toBe('invalid_grant');

    const c = await codeFor(owner, client);
    expect((await swap(c.code, c.verifier, 'http://127.0.0.1:7777/two')).body.error).toBe('invalid_grant');

    const d = await codeFor(owner, client);
    expect((await swap(d.code, pkce().verifier, d.redirectUri)).body.error).toBe('invalid_grant');

    const e = await codeFor(owner, client);
    const wrongResource = await token(slug, {
      grant_type: 'authorization_code',
      code: e.code,
      code_verifier: e.verifier,
      redirect_uri: e.redirectUri,
      client_id: client.client_id,
      resource: `${server.url}/mcp/${slug}/x`,
    });
    expect(wrongResource.body.error).toBe('invalid_target');

    expect((await token(slug, { grant_type: 'password', client_id: client.client_id })).body.error).toBe(
      'unsupported_grant_type',
    );
    // a repeated parameter is refused
    const repeated = await fetch(`${server.url}/mcp-oauth/${slug}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&code=a&code=b&client_id=${client.client_id}`,
    });
    expect(repeated.status).toBe(400);
  });

  it('authenticates confidential clients: a wrong secret is invalid_client', async () => {
    const owner = await signup();
    const slug = owner.tenant.slug;
    const basicClient = await newClient(slug, ['https://app.example.com/cb'], 'client_secret_basic');
    const postClient = await newClient(slug, ['https://app.example.com/cb'], 'client_secret_post');
    const basic = (id: string, secret: string) =>
      `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

    const a = await codeFor(owner, basicClient);
    const wrong = await token(
      slug,
      {
        grant_type: 'authorization_code',
        code: a.code,
        code_verifier: a.verifier,
        redirect_uri: a.redirectUri,
      },
      { authorization: basic(basicClient.client_id, 'wfocs_wrong') },
    );
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_client');
    expect(wrong.headers.get('www-authenticate')).toContain('Basic');
    // no secret at all
    const missing = await token(slug, {
      grant_type: 'authorization_code',
      code: a.code,
      code_verifier: a.verifier,
      redirect_uri: a.redirectUri,
      client_id: basicClient.client_id,
    });
    expect(missing.body.error).toBe('invalid_client');
    const b = await codeFor(owner, basicClient);
    const right = await token(
      slug,
      {
        grant_type: 'authorization_code',
        code: b.code,
        code_verifier: b.verifier,
        redirect_uri: b.redirectUri,
      },
      { authorization: basic(basicClient.client_id, basicClient.client_secret as string) },
    );
    expect(right.status).toBe(200);

    const c = await codeFor(owner, postClient);
    const post = (secret: string) =>
      token(slug, {
        grant_type: 'authorization_code',
        code: c.code,
        code_verifier: c.verifier,
        redirect_uri: c.redirectUri,
        client_id: postClient.client_id,
        client_secret: secret,
      });
    expect((await post('wfocs_wrong')).body.error).toBe('invalid_client');
    expect((await post(postClient.client_secret as string)).status).toBe(200);
  });

  it('rotates refresh tokens: an old one replayed gets invalid_grant, another resource invalid_target', async () => {
    const owner = await signup();
    const slug = owner.tenant.slug;
    const client = await newClient(slug);
    const first = await grant(owner, client);
    const refresh = (refreshToken: string, extra: Record<string, string> = {}) =>
      token(slug, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: client.client_id,
        ...extra,
      });

    // GHSA-cw9w: a refresh token never gives a token for another resource
    const trigger = await signedInTrigger(owner);
    expect((await refresh(first.refresh_token, { resource: trigger.url })).body.error).toBe('invalid_target');

    const second = await refresh(first.refresh_token, { resource: mcpServerUrl(server.ctx.config, slug) });
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);
    expect((await refresh(first.refresh_token)).body.error).toBe('invalid_grant');
    const third = await refresh(second.body.refresh_token, { scope: 'workflow:read' });
    expect(third.body.scope).toBe('workflow:read');
    expect(
      (await refresh(third.body.refresh_token, { scope: 'workflow:read workflow:write' })).body.error,
    ).toBe('invalid_scope');
    // another client may not use it
    const otherClient = await newClient(slug);
    expect(
      (
        await token(slug, {
          grant_type: 'refresh_token',
          refresh_token: third.body.refresh_token,
          client_id: otherClient.client_id,
        })
      ).body.error,
    ).toBe('invalid_grant');
    // the new access token works on the server
    expect(await mcpStatus(mcpServerUrl(server.ctx.config, slug), third.body.access_token)).toBe(200);
  });
});

describe('resource binding', () => {
  it('binds an omitted resource to the server URL; server and trigger tokens never cross', async () => {
    const owner = await signup();
    const client = await newClient(owner.tenant.slug);
    const serverUrl = mcpServerUrl(server.ctx.config, owner.tenant.slug);
    const trigger = await signedInTrigger(owner);

    const serverToken = await grant(owner, client);
    expect(await mcpStatus(serverUrl, serverToken.access_token)).toBe(200);
    expect(await mcpStatus(trigger.url, serverToken.access_token)).toBe(401);

    const triggerToken = await grant(owner, client, { resource: trigger.url });
    expect(await mcpStatus(trigger.url, triggerToken.access_token)).toBe(200);
    expect(await mcpStatus(serverUrl, triggerToken.access_token)).toBe(401);
    const row = await server.ctx.repos.mcpOAuth.getAccessToken(
      owner.tenant.id,
      createHash('sha256').update(triggerToken.access_token).digest('hex'),
    );
    expect(row?.resource).toBe(trigger.url);

    // RFC 9728 metadata for both resources, and none for an unknown one
    const prm = async (path: string) => fetch(`${server.url}/.well-known/oauth-protected-resource/${path}`);
    const serverMeta = await (await prm(`mcp-server/${owner.tenant.slug}/http`)).json();
    expect(serverMeta).toMatchObject({ resource: serverUrl, authorization_servers: [owner.issuer] });
    const triggerMeta = await jsonOf(await prm(trigger.url.slice(server.url.length + 1)));
    expect(triggerMeta.resource).toBe(trigger.url);
    expect((await prm(`mcp/${owner.tenant.slug}/nothing-here`)).status).toBe(404);
    // the trigger's 401 points the client at that metadata
    const challenge = await fetch(trigger.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(INIT),
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(
      `resource_metadata="${server.url}/.well-known/oauth-protected-resource${new URL(trigger.url).pathname}"`,
    );
  });

  it('a trigger without workspace sign-in is no resource: no metadata, authorize gives invalid_target', async () => {
    const owner = await signup();
    const client = await newClient(owner.tenant.slug);
    const open = await signedInTrigger(owner, 'none');
    const meta = await fetch(
      `${server.url}/.well-known/oauth-protected-resource${new URL(open.url).pathname}`,
    );
    expect(meta.status).toBe(404);
    const res = await authorize(owner.tenant.slug, {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      resource: open.url,
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_target');
  });

  it("refuses a token on another workspace's slug, and a code at another workspace's token endpoint", async () => {
    const a = await signup();
    const b = await signup();
    const client = await newClient(a.tenant.slug);
    const tokens = await grant(a, client);
    expect(await mcpStatus(mcpServerUrl(server.ctx.config, b.tenant.slug), tokens.access_token)).toBe(401);
    expect(
      await verifyMcpOAuthToken(
        server.ctx,
        b.tenant.id,
        tokens.access_token,
        mcpServerUrl(server.ctx.config, a.tenant.slug),
      ),
    ).toBeNull();
    const c = await codeFor(a, client);
    const swapped = await token(b.tenant.slug, {
      grant_type: 'authorization_code',
      code: c.code,
      code_verifier: c.verifier,
      redirect_uri: c.redirectUri,
      client_id: client.client_id,
    });
    expect(swapped.status).toBe(401);
    expect(swapped.body.error).toBe('invalid_client');
    // A's client cannot authorize at B
    const res = await authorize(b.tenant.slug, {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('revoke, removal and sweep', () => {
  it('revokes at once (RFC 7009); another client cannot revoke it; a refresh takes its access tokens', async () => {
    const owner = await signup();
    const slug = owner.tenant.slug;
    const url = mcpServerUrl(server.ctx.config, slug);
    const client = await newClient(slug);
    const otherClient = await newClient(slug);
    const tokens = await grant(owner, client);
    expect(await revoke(slug, { token: tokens.access_token, client_id: otherClient.client_id })).toBe(200);
    expect(await mcpStatus(url, tokens.access_token)).toBe(200);
    expect(await revoke(slug, { token: tokens.access_token, client_id: client.client_id })).toBe(200);
    expect(await mcpStatus(url, tokens.access_token)).toBe(401);
    // unknown token: still 200; no client: 401
    expect(await revoke(slug, { token: 'wfo_at_unknown', client_id: client.client_id })).toBe(200);
    expect(await revoke(slug, { token: tokens.refresh_token })).toBe(401);

    const more = await grant(owner, client);
    expect(
      await revoke(slug, {
        token: more.refresh_token,
        client_id: client.client_id,
        token_type_hint: 'refresh_token',
      }),
    ).toBe(200);
    expect(await mcpStatus(url, more.access_token)).toBe(401);
    const refreshed = await token(slug, {
      grant_type: 'refresh_token',
      refresh_token: more.refresh_token,
      client_id: client.client_id,
    });
    expect(refreshed.body.error).toBe('invalid_grant');
  });

  it('a user removed from the workspace loses access and cannot refresh', async () => {
    const owner = await signup();
    const member = await memberOf(owner);
    const client = await newClient(owner.tenant.slug);
    const url = mcpServerUrl(server.ctx.config, owner.tenant.slug);
    const tokens = await grant(member, client, { slug: owner.tenant.slug });
    const caller = await authenticateMcpBearer(
      server.ctx,
      owner.tenant.slug,
      `Bearer ${tokens.access_token}`,
      url,
    );
    expect(caller).toMatchObject({ role: 'editor', via: 'oauth' });
    expect(caller?.user.id).toBe(member.user.id);
    // the role is the membership's current one, never the token's
    await server.ctx.repos.memberships.updateRole(owner.tenant.id, member.user.id, 'viewer');
    expect(
      (await authenticateMcpBearer(server.ctx, owner.tenant.slug, `Bearer ${tokens.access_token}`, url))
        ?.role,
    ).toBe('viewer');

    await server.ctx.repos.memberships.remove(owner.tenant.id, member.user.id);
    expect(await mcpStatus(url, tokens.access_token)).toBe(401);
    const refreshed = await token(owner.tenant.slug, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    expect(refreshed.body.error).toBe('invalid_grant');
  });

  it('sweeps expired codes and tokens, keeps live ones, and refuses an expired token', async () => {
    const owner = await signup();
    const client = await newClient(owner.tenant.slug);
    const repo = server.ctx.repos.mcpOAuth;
    const live = await grant(owner, client);
    const past = new Date(Date.now() - 60_000);
    const grantRow = {
      tenantId: owner.tenant.id,
      clientId: client.client_id,
      userId: owner.user.id,
      resource: mcpServerUrl(server.ctx.config, owner.tenant.slug),
      scope: [...MCP_SCOPES],
    };
    const expiredAccess = `wfo_at_${randomBytes(16).toString('base64url')}`;
    const hash = (v: string) => createHash('sha256').update(v).digest('hex');
    await repo.saveTokens(
      { ...grantRow, tokenHash: hash(expiredAccess), expiresAt: past },
      { ...grantRow, tokenHash: hash(`wfo_rt_${randomUUID()}`), expiresAt: past },
    );
    await repo.saveCode({
      ...grantRow,
      codeHash: hash(randomUUID()),
      redirectUri: client.redirect_uris[0],
      codeChallenge: pkce().challenge,
      codeChallengeMethod: 'S256',
      expiresAt: past,
    });
    expect(
      await verifyMcpOAuthToken(server.ctx, owner.tenant.id, expiredAccess, grantRow.resource),
    ).toBeNull();
    const swept = await repo.sweepExpired(new Date());
    expect(swept.codes).toBeGreaterThanOrEqual(1);
    expect(swept.accessTokens).toBeGreaterThanOrEqual(1);
    expect(swept.refreshTokens).toBeGreaterThanOrEqual(1);
    expect(await repo.getAccessToken(owner.tenant.id, hash(expiredAccess))).toBeUndefined();
    expect(await repo.getAccessToken(owner.tenant.id, hash(live.access_token))).toBeDefined();
    expect(await repo.sweepExpired(new Date())).toEqual({ codes: 0, accessTokens: 0, refreshTokens: 0 });
  });
});

describe('routes', () => {
  it('answers 403 on every OAuth route for another Host, with CORS and never allow-credentials', async () => {
    const owner = await signup();
    const slug = owner.tenant.slug;
    const routes: Array<[string, string]> = [
      ['POST', `/mcp-oauth/${slug}/register`],
      ['GET', `/mcp-oauth/${slug}/authorize`],
      ['POST', `/mcp-oauth/${slug}/token`],
      ['POST', `/mcp-oauth/${slug}/revoke`],
      ['GET', `/.well-known/oauth-authorization-server/mcp-oauth/${slug}`],
      ['GET', `/.well-known/oauth-protected-resource/mcp-server/${slug}/http`],
      ['OPTIONS', `/mcp-oauth/${slug}/token`],
    ];
    for (const [method, url] of routes) {
      const res = await server.app.inject({
        method: method as 'GET',
        url,
        headers: { host: 'evil.example', 'content-type': 'application/json' },
        payload: method === 'POST' ? '{}' : undefined,
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
    const good = await fetch(`${server.url}/.well-known/oauth-authorization-server/mcp-oauth/${slug}`, {
      headers: { origin: 'https://claude.example' },
    });
    expect(good.status).toBe(200);
    expect(good.headers.get('access-control-allow-origin')).toBe('*');
    expect(good.headers.get('access-control-allow-credentials')).toBeNull();
    expect(await good.json()).toMatchObject({
      issuer: owner.issuer,
      authorization_endpoint: `${owner.issuer}/authorize`,
      token_endpoint: `${owner.issuer}/token`,
      registration_endpoint: `${owner.issuer}/register`,
      revocation_endpoint: `${owner.issuer}/revoke`,
      grant_types_supported: ['authorization_code', 'refresh_token'],
      scopes_supported: [...MCP_SCOPES],
      authorization_response_iss_parameter_supported: true,
    });
    const preflight = await fetch(`${server.url}/mcp-oauth/${slug}/token`, {
      method: 'OPTIONS',
      headers: { origin: 'https://claude.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
  });

  it('while MCP access is off refuses only the server resource; a trigger signs in; an unknown slug is 404', async () => {
    const owner = await signup();
    const slug = owner.tenant.slug;
    const serverUrl = mcpServerUrl(server.ctx.config, slug);
    const client = await newClient(slug);
    const trigger = await signedInTrigger(owner);
    // a server token pair and a server flow made while access is on
    const before = await grant(owner, client);
    const { challenge } = pkce();
    const pending = flowOf(
      await authorize(slug, {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    );
    await owner.client.data(owner.client.patch('/rest/mcp/settings', { mcpAccessEnabled: false }));

    // the shared routes keep answering (as n8n): metadata, registration
    const asMeta = await fetch(`${server.url}/.well-known/oauth-authorization-server/mcp-oauth/${slug}`);
    expect(asMeta.status).toBe(200);
    expect(((await asMeta.json()) as { issuer: string }).issuer).toBe(owner.issuer);
    expect((await register(slug, { redirect_uris: ['http://localhost/cb'] })).status).toBe(201);
    // the server's own resource is refused: metadata, authorize (named or omitted), consent, refresh
    expect(
      (await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp-server/${slug}/http`)).status,
    ).toBe(404);
    for (const resource of [serverUrl, undefined]) {
      const res = await authorize(slug, {
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...(resource ? { resource } : {}),
      });
      expect(res.status).toBe(302);
      const back = new URL(res.headers.get('location') ?? '');
      expect(back.searchParams.get('error')).toBe('invalid_target');
      expect(back.searchParams.get('error_description')).toBe(
        'MCP access is not available for this workspace',
      );
    }
    expect(
      (await owner.client.post('/rest/consent/approve', { flow: pending, approved: true })).statusCode,
    ).toBe(400);
    const refreshed = await token(slug, {
      grant_type: 'refresh_token',
      refresh_token: before.refresh_token,
      client_id: client.client_id,
    });
    expect(refreshed.status).toBe(400);
    expect(refreshed.body.error).toBe('invalid_target');
    expect(await mcpStatus(serverUrl, before.access_token)).toBe(404);

    // a trigger with workspace sign-in keeps working: metadata, authorize, consent, token, call
    const triggerMeta = await fetch(
      `${server.url}/.well-known/oauth-protected-resource${new URL(trigger.url).pathname}`,
    );
    expect(triggerMeta.status).toBe(200);
    const triggerToken = await grant(owner, client, { resource: trigger.url });
    expect(await mcpStatus(trigger.url, triggerToken.access_token)).toBe(200);
    expect(await revoke(slug, { token: triggerToken.access_token, client_id: client.client_id })).toBe(200);
    expect(await mcpStatus(trigger.url, triggerToken.access_token)).toBe(401);

    // on again: the refresh token issued before still works for the server
    await owner.client.data(owner.client.patch('/rest/mcp/settings', { mcpAccessEnabled: true }));
    const again = await token(slug, {
      grant_type: 'refresh_token',
      refresh_token: before.refresh_token,
      client_id: client.client_id,
    });
    expect(again.status).toBe(200);
    expect(await mcpStatus(serverUrl, again.body.access_token)).toBe(200);

    const unknown = `no-such-${randomUUID()}`;
    expect(
      (await fetch(`${server.url}/.well-known/oauth-authorization-server/mcp-oauth/${unknown}`)).status,
    ).toBe(404);
    expect((await register(unknown, { redirect_uris: ['http://localhost/cb'] })).status).toBe(404);
    expect((await authorize(unknown, { client_id: 'x' })).status).toBe(404);
    expect((await token(unknown, { grant_type: 'refresh_token' })).status).toBe(404);
    expect(await revoke(unknown, { token: 'x' })).toBe(404);
  });

  it('lists own clients, deletes one with its tokens, shows stats; the client-wide parts need mcp:manage', async () => {
    const owner = await signup();
    const client = await newClient(owner.tenant.slug, ['http://localhost:4444/cb']);
    const tokens = await grant(owner, client);
    const list = await owner.client.data(owner.client.get('/rest/mcp/oauth-clients'));
    expect(list).toEqual([
      {
        id: client.client_id,
        name: 'Test client',
        redirectUris: ['http://localhost:4444/cb'],
        createdAt: expect.any(String),
      },
    ]);
    // a true `member` (the old `editor` name holds no scope since the cutover)
    const editor = await memberOf(owner, 'member');
    await editor.client.data(editor.client.post('/rest/auth/switch-tenant', { tenantId: owner.tenant.id }));
    // P6-35: a member lists only its own clients (a consent row), ownership=all and the stats need mcp:manage,
    // and a delete without it can only remove its own grant, which this member does not have: 404
    expect(await editor.client.data(editor.client.get('/rest/mcp/oauth-clients'))).toEqual([]);
    expect((await editor.client.get('/rest/mcp/oauth-clients?ownership=all')).statusCode).toBe(403);
    expect((await editor.client.delete(`/rest/mcp/oauth-clients/${client.client_id}`)).statusCode).toBe(404);
    expect((await editor.client.get('/rest/mcp/instance-stats')).statusCode).toBe(403);
    // another workspace's admin sees none and cannot delete it
    const other = await signup();
    expect(await other.client.data(other.client.get('/rest/mcp/oauth-clients'))).toEqual([]);
    expect((await other.client.delete(`/rest/mcp/oauth-clients/${client.client_id}`)).statusCode).toBe(404);

    expect(
      await owner.client.data(owner.client.delete(`/rest/mcp/oauth-clients/${client.client_id}`)),
    ).toEqual({ ok: true });
    expect(await mcpStatus(mcpServerUrl(server.ctx.config, owner.tenant.slug), tokens.access_token)).toBe(
      401,
    );
    expect(await owner.client.data(owner.client.get('/rest/mcp/oauth-clients'))).toEqual([]);
    expect((await owner.client.delete(`/rest/mcp/oauth-clients/${client.client_id}`)).statusCode).toBe(404);
  });
});

describe('MCP_BASE_URL with a path prefix', () => {
  const ORIGIN_9 = 'http://127.0.0.1:9';
  let prefixed: TestServer;
  beforeAll(async () => {
    prefixed = await createTestServer(
      {
        BASE_URL: ORIGIN_9,
        MCP_BASE_URL: `${ORIGIN_9}/wf`,
        MCP_ACCESS_ENABLED: 'true',
        OAUTH_SERVER_WELL_KNOWN_RATE_LIMIT: HIGH,
      },
      { reset: false, startMain: false, nodePackages: [nodesAiPackage] },
    );
  });
  afterAll(async () => {
    await prefixed?.close();
  });
  const get = (url: string) => prefixed.app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:9' } });

  it('serves both well-known documents with the prefix inserted after the well-known segment', async () => {
    const owner = await signup();
    const slug = owner.tenant.slug;
    const trigger = await signedInTrigger(owner);
    const triggerPath = new URL(trigger.url).pathname;

    const as = await get(`/.well-known/oauth-authorization-server/wf/mcp-oauth/${slug}`);
    expect(as.statusCode).toBe(200);
    expect(as.json()).toMatchObject({
      issuer: `${ORIGIN_9}/wf/mcp-oauth/${slug}`,
      token_endpoint: `${ORIGIN_9}/wf/mcp-oauth/${slug}/token`,
    });
    const serverMeta = await get(`/.well-known/oauth-protected-resource/wf/mcp-server/${slug}/http`);
    expect(serverMeta.statusCode).toBe(200);
    expect(serverMeta.json()).toMatchObject({
      resource: `${ORIGIN_9}/wf/mcp-server/${slug}/http`,
      authorization_servers: [`${ORIGIN_9}/wf/mcp-oauth/${slug}`],
    });
    const triggerMeta = await get(`/.well-known/oauth-protected-resource/wf${triggerPath}`);
    expect(triggerMeta.statusCode).toBe(200);
    expect(triggerMeta.json().resource).toBe(`${ORIGIN_9}/wf${triggerPath}`);
    // the URL the tenant server's 401 names is the one served
    const unauthorized = await prefixed.app.inject({
      method: 'POST',
      url: `/mcp-server/${slug}/http`,
      headers: {
        host: '127.0.0.1:9',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: INIT,
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['www-authenticate']).toContain(
      `resource_metadata="${ORIGIN_9}/.well-known/oauth-protected-resource/wf/mcp-server/${slug}/http"`,
    );

    // without the prefix, or with another one: no document
    expect((await get(`/.well-known/oauth-authorization-server/mcp-oauth/${slug}`)).statusCode).toBe(404);
    expect((await get(`/.well-known/oauth-authorization-server/wf/mcp-oauth/${slug}/x`)).statusCode).toBe(
      404,
    );
    expect((await get(`/.well-known/oauth-protected-resource/mcp-server/${slug}/http`)).statusCode).toBe(404);
    expect(
      (await get(`/.well-known/oauth-protected-resource/other/mcp-server/${slug}/http`)).statusCode,
    ).toBe(404);
  });
});

describe('rate limits', () => {
  let limited: Server;
  beforeAll(async () => {
    limited = await startMcpTestServer(
      {
        MCP_ACCESS_ENABLED: 'true',
        OAUTH_SERVER_REGISTER_RATE_LIMIT: '2',
        OAUTH_SERVER_AUTHORIZE_RATE_LIMIT: '2',
        OAUTH_SERVER_TOKEN_RATE_LIMIT: '2',
        OAUTH_SERVER_REVOKE_RATE_LIMIT: '2',
        OAUTH_SERVER_WELL_KNOWN_RATE_LIMIT: '2',
      },
      { reset: false, startMain: false },
    );
  });
  afterAll(async () => {
    await limited?.close();
  });

  it('limits each OAuth route on its own 5-minute window', async () => {
    const slug = `rl-${randomUUID().slice(0, 8)}`;
    const calls: Array<[string, () => Promise<Response>]> = [
      [
        'register',
        () =>
          fetch(`${limited.url}/mcp-oauth/${slug}/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }),
      ],
      ['authorize', () => fetch(`${limited.url}/mcp-oauth/${slug}/authorize`, { redirect: 'manual' })],
      [
        'token',
        () =>
          fetch(`${limited.url}/mcp-oauth/${slug}/token`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=x',
          }),
      ],
      [
        'revoke',
        () =>
          fetch(`${limited.url}/mcp-oauth/${slug}/revoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'token=x',
          }),
      ],
      ['metadata', () => fetch(`${limited.url}/.well-known/oauth-authorization-server/mcp-oauth/${slug}`)],
      [
        'resource',
        () => fetch(`${limited.url}/.well-known/oauth-protected-resource/mcp-server/${slug}/http`),
      ],
    ];
    for (const [name, call] of calls) {
      expect((await call()).status, name).toBe(404);
    }
    // the two well-known routes count apart; each route's third call is limited
    for (const [name, call] of calls) {
      expect((await call()).status, name).toBe(404);
      const third = await call();
      expect(third.status, name).toBe(429);
      expect(third.headers.get('access-control-allow-origin')).toBe('*');
      expect((await jsonOf(third)).error).toBe('rate_limited');
    }
  });
});
