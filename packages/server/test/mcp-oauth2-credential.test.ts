/**
 * P5-18 MCP OAuth2 credential (`mcpOAuth2Api`) on the server: discovery (RFC 9728, RFC 8414), automatic
 * client registration (RFC 7591) or a Client ID Metadata Document, Connect with PKCE and `resource`, then
 * our `McpClient` (through `createMcpConnection`) on an MCP Server Trigger: the first call gets a 401, the
 * token is refreshed with `resource` and the call is retried.
 * Run with TEST_DATABASE_URL=.../workflow_test_p5_s4_oauthcred and TEST_REDIS_URL=redis://127.0.0.1:6379/10.
 *
 * The fake authorization server listens on 127.0.0.1. It also serves the protected resource metadata and
 * passes `/mcp/...` on to the test server, so the MCP endpoint and its authorization server share one host
 * as a real deployment behind a gateway would.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createMcpConnection, nodesAiPackage } from '@workflow/nodes-ai';
import type { DataObject, NodePackage, NodeType } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  outputOf,
  startMcpTestServer,
  TestClient,
  type TestServer,
  waitForExecution,
} from './helpers';

const STALE_TOKEN = `stale-access-${randomUUID()}`;
const GOOD_TOKEN = `good-access-${randomUUID()}`;
const REFRESH_TOKEN = `refresh-${randomUUID()}`;
const REGISTERED_SECRET = `registered-secret-${randomUUID()}`;
const CIMD_BASE = 'https://workflow.example.com';

interface Logged {
  method: string;
  path: string;
  host: string;
  authorization?: string;
  body: string;
  status?: number;
}

/** what the fake authorization server answers; reset before each test */
interface Mode {
  issuer?: string;
  tokenEndpoint?: string;
  methods: string[];
  cimd: boolean;
  /** the protected resource metadata answers with a redirect to this origin */
  prmRedirectTo?: string;
  registerSecret: boolean;
  /** the client authentication the registration answer states for a client with a secret */
  registerMethod?: 'client_secret_post' | 'client_secret_basic';
  registerError?: { status: number; body: DataObject };
}

class FakeAuthorizationServer {
  readonly log: Logged[] = [];
  mode: Mode = { methods: ['S256'], cimd: false, registerSecret: false };
  private server!: Server;
  private codes = new Map<
    string,
    { challenge: string; clientId: string; redirectUri: string; resource: string }
  >();
  private clients = 0;
  origin = '';
  /** where `/mcp/...` goes */
  upstreamPort = 0;

  get issuer() {
    return `${this.origin}/as`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.log.length = 0;
    this.mode = { methods: ['S256'], cimd: false, registerSecret: false };
  }

  /** the browser step: the user signs in at the authorize URL and the server issues a code for it */
  issueCode(authorizeUrl: string): string {
    const url = new URL(authorizeUrl);
    const code = `code-${randomUUID()}`;
    this.codes.set(code, {
      challenge: url.searchParams.get('code_challenge') ?? '',
      clientId: url.searchParams.get('client_id') ?? '',
      redirectUri: url.searchParams.get('redirect_uri') ?? '',
      resource: url.searchParams.get('resource') ?? '',
    });
    return code;
  }

  requests(path: string): Logged[] {
    return this.log.filter((entry) => entry.path === path);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (path.startsWith('/mcp/')) return this.proxy(req, res, path);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const entry: Logged = {
      method: req.method ?? 'GET',
      path,
      host: String(req.headers.host ?? ''),
      authorization: req.headers.authorization,
      body,
    };
    this.log.push(entry);
    const json = (status: number, value: unknown) => {
      entry.status = status;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const prmPrefix = '/.well-known/oauth-protected-resource';
    if (path.startsWith(prmPrefix)) {
      if (this.mode.prmRedirectTo) {
        entry.status = 302;
        res.writeHead(302, { location: `${this.mode.prmRedirectTo}${path}` });
        return void res.end();
      }
      const resourcePath = path.slice(prmPrefix.length);
      if (!resourcePath.startsWith('/mcp/')) return json(404, { error: 'not_found' });
      return json(200, {
        resource: `${this.origin}${resourcePath}`,
        authorization_servers: [this.issuer],
        scopes_supported: ['tools'],
        bearer_methods_supported: ['header'],
      });
    }
    if (path === '/.well-known/oauth-authorization-server/as') {
      return json(200, {
        issuer: this.mode.issuer ?? this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: this.mode.tokenEndpoint ?? `${this.issuer}/token`,
        registration_endpoint: `${this.issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: this.mode.methods,
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        ...(this.mode.cimd ? { client_id_metadata_document_supported: true } : {}),
      });
    }
    if (path === '/as/register' && req.method === 'POST') {
      if (this.mode.registerError) return json(this.mode.registerError.status, this.mode.registerError.body);
      const metadata = JSON.parse(body) as DataObject;
      this.clients++;
      return json(201, {
        ...metadata,
        client_id: `client-${this.clients}`,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...(this.mode.registerSecret
          ? {
              client_secret: REGISTERED_SECRET,
              token_endpoint_auth_method: this.mode.registerMethod ?? 'client_secret_post',
            }
          : {}),
      });
    }
    if (path === '/as/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(body));
      // a client_secret_basic client names itself in the Basic header, not in the form
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
      if (basic) form.client_id = Buffer.from(basic[1], 'base64').toString().split(':')[0];
      if (form.grant_type === 'authorization_code') {
        const issued = this.codes.get(form.code ?? '');
        this.codes.delete(form.code ?? '');
        const challenge = createHash('sha256')
          .update(form.code_verifier ?? '')
          .digest('base64url');
        if (
          !issued ||
          issued.challenge !== challenge ||
          issued.clientId !== form.client_id ||
          issued.redirectUri !== form.redirect_uri ||
          issued.resource !== form.resource
        ) {
          return json(400, { error: 'invalid_grant' });
        }
        return json(200, {
          access_token: STALE_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      if (form.grant_type === 'refresh_token' && form.refresh_token === REFRESH_TOKEN) {
        return json(200, { access_token: GOOD_TOKEN, expires_in: 3600, token_type: 'Bearer' });
      }
      return json(400, { error: 'invalid_grant' });
    }
    json(404, { error: 'not_found' });
  }

  /** `/mcp/...` to the test server with its own Host (its DNS-rebinding check), streamed both ways */
  private proxy(req: IncomingMessage, res: ServerResponse, path: string): void {
    const entry: Logged = {
      method: req.method ?? 'GET',
      path,
      host: String(req.headers.host ?? ''),
      authorization: req.headers.authorization,
      body: '',
    };
    this.log.push(entry);
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: this.upstreamPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${this.upstreamPort}` },
      },
      (answer) => {
        entry.status = answer.statusCode;
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }
}

/** a node that opens a connection with `createMcpConnection`, lists the tools and calls the Calculator */
const probe: NodeType = {
  description: {
    name: 'test.mcpOAuthProbe',
    displayName: 'MCP OAuth probe',
    description: 'Lists and calls a tool over an MCP OAuth2 credential',
    icon: 'lucide:plug',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Probe' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'mcpOAuth2Api', required: true }],
    properties: [{ displayName: 'Endpoint', name: 'endpointUrl', type: 'string', default: '' }],
  },
  async execute(ctx) {
    const client = await createMcpConnection(ctx, {
      endpointUrl: String(ctx.getNodeParameter('endpointUrl', 0, '')),
      serverTransport: 'httpStreamable',
      authentication: 'mcpOAuth2Api',
      timeoutMs: 10_000,
    });
    try {
      const tools = (await client.listTools()).map((tool) => tool.name);
      const result = await client.callTool('Calculator', { input: '2 + 3' });
      const text = (result.content ?? []).map((part) => String(part.text ?? '')).join('');
      return [[{ json: { tools, text } }]];
    } finally {
      await client.close();
    }
  },
};
const probePackage: NodePackage = { name: 'mcp-oauth2-credential-tests', nodes: [probe], credentials: [] };

const fake = new FakeAuthorizationServer();
let server: TestServer & { url: string; port: number };
/** a second app on an https base URL (never listening): the CIMD case */
let cimdServer: TestServer;

beforeAll(async () => {
  await fake.start();
  server = await startMcpTestServer({}, { nodePackages: [nodesAiPackage, probePackage] });
  fake.upstreamPort = server.port;
  cimdServer = await createTestServer(
    { BASE_URL: CIMD_BASE, MCP_BASE_URL: CIMD_BASE },
    { nodePackages: [nodesAiPackage], reset: false, startMain: false },
  );
});
afterAll(async () => {
  await cimdServer?.close();
  await server?.close();
  await fake.stop();
});
beforeEach(() => {
  fake.reset();
});

async function signup(app = server.app, origin = server.url) {
  const client = new TestClient(app, origin);
  const id = randomUUID().slice(0, 8);
  const res = await client.post('/rest/auth/signup', {
    email: `mcp-oauth-${id}@example.com`,
    password: 'Passw0rd!',
    name: `MCP OAuth ${id}`,
    workspaceName: `MCP OAuth ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as { user: { id: string }; tenant: { id: string; slug: string } };
  return { client, ...data };
}

async function mcpCredential(client: TestClient, data: DataObject) {
  return client.data<{ id: string; name: string }>(
    client.post('/rest/credentials', { name: 'MCP OAuth2', type: 'mcpOAuth2Api', data }),
  );
}

const resourceFor = (path: string) => `${fake.origin}/mcp/${path}`;

async function authorize(client: TestClient, credentialId: string) {
  return client.get(`/rest/oauth2/authorize?credentialId=${credentialId}`);
}

async function stored(target: TestServer, tenantId: string, credentialId: string): Promise<DataObject> {
  const row = await target.ctx.repos.credentials.get(tenantId, credentialId);
  if (!row) throw new Error('credential not found');
  return target.ctx.credentials.decrypt(row);
}

describe('MCP OAuth2: discovery, registration, connect and a retried call', () => {
  it('connects through discovery and RFC 7591, then lists and calls a tool on an MCP Server Trigger after a refresh', async () => {
    const { client, tenant } = await signup();
    // the MCP Server Trigger accepts only the refreshed token
    const bearer = await client.data<{ id: string }>(
      client.post('/rest/credentials', {
        name: 'MCP bearer',
        type: 'httpBearerAuth',
        data: { token: GOOD_TOKEN },
      }),
    );
    const path = `tools-${randomUUID().slice(0, 8)}`;
    const trigger = await createWorkflow(client, {
      name: 'MCP tools',
      nodes: [
        node('MCP Server Trigger', 'ai.mcpTrigger', { path, authentication: 'bearerAuth' }, [0, 0], {
          webhookId: randomUUID(),
          credentials: { httpBearerAuth: { id: bearer.id, name: 'MCP bearer' } },
        }),
        node('Calculator', 'ai.toolCalculator', {}, [0, 200]),
      ],
      connections: {
        Calculator: { ai_tool: [[{ node: 'MCP Server Trigger', type: 'ai_tool', index: 0 }]] },
      },
    });
    await client.data(client.post(`/rest/workflows/${trigger.id}/activate`));
    const resourceUrl = resourceFor(`${tenant.slug}/${path}`);

    const credential = await mcpCredential(client, { useDynamicClientRegistration: true, resourceUrl });
    const { url } = await client.data<{ url: string }>(authorize(client, credential.id));
    const authorizeUrl = new URL(url);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(`${fake.issuer}/authorize`);
    expect(authorizeUrl.searchParams.get('client_id')).toBe('client-1');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${server.url}/rest/oauth2/callback`);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('resource')).toBe(resourceUrl);
    expect(authorizeUrl.searchParams.get('scope')).toBe('tools');

    // RFC 9728 path insertion, then RFC 8414 path insertion, then one registration of a public client
    expect(fake.requests(`/.well-known/oauth-protected-resource/mcp/${tenant.slug}/${path}`)).toHaveLength(1);
    expect(fake.requests('/.well-known/oauth-authorization-server/as')).toHaveLength(1);
    const [registration] = fake.requests('/as/register');
    expect(JSON.parse(registration.body)).toMatchObject({
      redirect_uris: [`${server.url}/rest/oauth2/callback`],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    });
    const found = await stored(server, tenant.id, credential.id);
    expect(found).toMatchObject({
      authUrl: `${fake.issuer}/authorize`,
      accessTokenUrl: `${fake.issuer}/token`,
      clientId: 'client-1',
      resourceUrl,
    });
    expect(found.clientSecret).toBeUndefined();

    // the browser signs in; the callback exchanges the code with the verifier and the resource
    const code = fake.issueCode(url);
    const callback = await server.app.inject({
      method: 'GET',
      url: `/rest/oauth2/callback?code=${code}&state=${encodeURIComponent(authorizeUrl.searchParams.get('state') ?? '')}`,
    });
    expect(callback.statusCode).toBe(200);
    const [exchange] = fake.requests('/as/token');
    const exchangeForm = Object.fromEntries(new URLSearchParams(exchange.body));
    expect(exchangeForm).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'client-1',
      resource: resourceUrl,
    });
    expect(exchangeForm.client_secret).toBeUndefined();
    expect(exchange.authorization).toBeUndefined();
    expect(((await stored(server, tenant.id, credential.id)).oauthTokenData as DataObject).access_token).toBe(
      STALE_TOKEN,
    );

    // our McpClient: the stale token gets a 401, the refresh carries `resource`, the retry succeeds
    fake.log.length = 0;
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Probe', 'test.mcpOAuthProbe', { endpointUrl: resourceUrl }, [200, 0], {
          credentials: { mcpOAuth2Api: { id: credential.id, name: credential.name } },
        }),
      ],
      connections: chain('Start', 'Probe'),
    });
    const { executionId } = await client.data<{ executionId: string }>(
      client.post(`/rest/workflows/${wf.id}/run`, {}),
    );
    await waitForExecution(server.ctx, tenant.id, executionId, ['success', 'error'], 30_000);
    const execution = await client.data<{ status: string; state: unknown }>(
      client.get(`/rest/executions/${executionId}`),
    );
    expect(execution.status).toBe('success');
    const [output] = outputOf(execution.state, 'Probe');
    expect(output.tools).toContain('Calculator');
    expect(output.text).toBe('5');

    const calls = fake.log.filter((entry) => entry.path.startsWith('/mcp/'));
    expect(calls[0]).toMatchObject({ authorization: `Bearer ${STALE_TOKEN}`, status: 401 });
    expect(
      calls.some((entry) => entry.authorization === `Bearer ${GOOD_TOKEN}` && entry.status === 200),
    ).toBe(true);
    const refreshes = fake
      .requests('/as/token')
      .map((entry) => Object.fromEntries(new URLSearchParams(entry.body)));
    expect(refreshes.length).toBeGreaterThanOrEqual(1);
    for (const form of refreshes) {
      expect(form).toMatchObject({
        grant_type: 'refresh_token',
        resource: resourceUrl,
        client_id: 'client-1',
      });
      expect(form.client_secret).toBeUndefined();
    }
    expect(((await stored(server, tenant.id, credential.id)).oauthTokenData as DataObject).access_token).toBe(
      GOOD_TOKEN,
    );
    expect(JSON.stringify(execution)).not.toContain(GOOD_TOKEN);
  });

  it('refuses metadata that names another issuer', async () => {
    const { client } = await signup();
    fake.mode.issuer = `${fake.origin}/someone-else`;
    const credential = await mcpCredential(client, { resourceUrl: resourceFor('t/one') });
    const res = await authorize(client, credential.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('another issuer');
    expect(fake.requests('/as/register')).toHaveLength(0);
  });

  it('refuses a plain http endpoint on a public name', async () => {
    const { client, tenant } = await signup();
    fake.mode.tokenEndpoint = 'http://auth.example.com/token';
    const credential = await mcpCredential(client, { resourceUrl: resourceFor('t/two') });
    const res = await authorize(client, credential.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('token endpoint must use https');
    expect(fake.requests('/as/register')).toHaveLength(0);
    expect((await stored(server, tenant.id, credential.id)).accessTokenUrl).toBeUndefined();
  });

  it('refuses a plain http resource URL on a public name before any request', async () => {
    const { client } = await signup();
    const credential = await mcpCredential(client, { resourceUrl: 'http://mcp.example.com/mcp' });
    const res = await authorize(client, credential.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('resource URL must use https');
    expect(fake.log).toHaveLength(0);
  });

  it('refuses a metadata redirect to another host when the credential allows only some domains', async () => {
    const { client } = await signup();
    const port = new URL(fake.origin).port;
    fake.mode.prmRedirectTo = `http://localhost:${port}`;
    const credential = await mcpCredential(client, {
      resourceUrl: resourceFor('t/three'),
      allowedHttpRequestDomains: 'domains',
      allowedDomains: '127.0.0.1',
    });
    const res = await authorize(client, credential.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Domain not allowed');
    expect(fake.log.every((entry) => entry.host !== `localhost:${port}`)).toBe(true);
    expect(fake.requests('/.well-known/oauth-authorization-server/as')).toHaveLength(0);
  });

  it('refuses an authorization server without S256', async () => {
    const { client } = await signup();
    fake.mode.methods = ['plain'];
    const credential = await mcpCredential(client, { resourceUrl: resourceFor('t/four') });
    const res = await authorize(client, credential.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('S256');
    expect(fake.requests('/as/register')).toHaveLength(0);
  });

  it('keeps a registered client secret out of the API and out of errors', async () => {
    const { client, tenant } = await signup();
    fake.mode.registerSecret = true;
    const credential = await mcpCredential(client, { resourceUrl: resourceFor('t/five') });
    const first = await authorize(client, credential.id);
    expect(first.statusCode).toBe(200);
    expect(first.body).not.toContain(REGISTERED_SECRET);
    expect((await stored(server, tenant.id, credential.id)).clientSecret).toBe(REGISTERED_SECRET);
    const read = await client.get(`/rest/credentials/${credential.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain(REGISTERED_SECRET);

    // a failing registration that quotes the secret: only the RFC 7591 error code is shown
    fake.mode.registerError = {
      status: 400,
      body: { error: 'invalid_client_metadata', error_description: `refused ${REGISTERED_SECRET}` },
    };
    const second = await authorize(client, credential.id);
    expect(second.statusCode).toBe(400);
    expect(second.json().error.message).toContain('invalid_client_metadata');
    expect(second.body).not.toContain(REGISTERED_SECRET);
    expect(second.body).not.toContain('refused');
  });

  it('exchanges the code with Basic when the registration states client_secret_basic', async () => {
    const { client, tenant } = await signup();
    fake.mode.registerSecret = true;
    fake.mode.registerMethod = 'client_secret_basic';
    const credential = await mcpCredential(client, { resourceUrl: resourceFor('t/basic') });
    const { url } = await client.data<{ url: string }>(authorize(client, credential.id));
    expect((await stored(server, tenant.id, credential.id)).authentication).toBe('header');
    const code = fake.issueCode(url);
    const state = new URL(url).searchParams.get('state') ?? '';
    const callback = await server.app.inject({
      method: 'GET',
      url: `/rest/oauth2/callback?code=${code}&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(200);
    const [exchange] = fake.requests('/as/token');
    expect(exchange.status).toBe(200);
    const expected = Buffer.from(`${new URL(url).searchParams.get('client_id')}:${REGISTERED_SECRET}`);
    expect(exchange.authorization).toBe(`Basic ${expected.toString('base64')}`);
    const form = Object.fromEntries(new URLSearchParams(exchange.body));
    expect(form.client_secret).toBeUndefined();
    expect(form.client_id).toBeUndefined();
    expect(((await stored(server, tenant.id, credential.id)).oauthTokenData as DataObject).access_token).toBe(
      STALE_TOKEN,
    );
  });

  it('uses the metadata document URL as client id with an https base URL and a server that states CIMD support', async () => {
    const { client } = await signup(cimdServer.app, CIMD_BASE);
    fake.mode.cimd = true;
    const credential = await mcpCredential(client, { resourceUrl: resourceFor('t/six') });
    const { url } = await client.data<{ url: string }>(authorize(client, credential.id));
    const authorizeUrl = new URL(url);
    expect(authorizeUrl.searchParams.get('client_id')).toBe(`${CIMD_BASE}/rest/oauth2/mcp-client-metadata`);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${CIMD_BASE}/rest/oauth2/callback`);
    expect(fake.requests('/as/register')).toHaveLength(0);
  });

  it('registers through RFC 7591 when the base URL is http, even with CIMD support', async () => {
    const { client } = await signup();
    fake.mode.cimd = true;
    const credential = await mcpCredential(client, { resourceUrl: resourceFor('t/seven') });
    const { url } = await client.data<{ url: string }>(authorize(client, credential.id));
    expect(new URL(url).searchParams.get('client_id')).toMatch(/^client-\d+$/);
    expect(fake.requests('/as/register')).toHaveLength(1);
  });

  it('serves the client metadata document with no session', async () => {
    const res = await cimdServer.app.inject({ method: 'GET', url: '/rest/oauth2/mcp-client-metadata' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.json()).toEqual({
      client_id: `${CIMD_BASE}/rest/oauth2/mcp-client-metadata`,
      client_name: 'Workflow',
      client_uri: CIMD_BASE,
      redirect_uris: [`${CIMD_BASE}/rest/oauth2/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('with automatic registration off, uses the typed client and still sends resource', async () => {
    const { client } = await signup();
    const resourceUrl = 'https://mcp.example.com/mcp';
    const credential = await mcpCredential(client, {
      useDynamicClientRegistration: false,
      resourceUrl,
      authUrl: 'https://login.example.com/authorize',
      accessTokenUrl: 'https://login.example.com/token',
      clientId: 'typed-client',
    });
    const { url } = await client.data<{ url: string }>(authorize(client, credential.id));
    const authorizeUrl = new URL(url);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://login.example.com/authorize');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('typed-client');
    expect(authorizeUrl.searchParams.get('resource')).toBe(resourceUrl);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(fake.log).toHaveLength(0);
  });

  it('leaves an ordinary oAuth2Api credential as it was: no discovery and no resource', async () => {
    const { client } = await signup();
    const credential = await client.data<{ id: string }>(
      client.post('/rest/credentials', {
        name: 'Plain OAuth2',
        type: 'oAuth2Api',
        data: {
          grantType: 'authorizationCode',
          authUrl: 'https://provider.example.com/authorize',
          accessTokenUrl: 'https://provider.example.com/token',
          clientId: 'plain-client',
          clientSecret: 'plain-secret',
          resourceUrl: resourceFor('t/eight'),
        },
      }),
    );
    const { url } = await client.data<{ url: string }>(authorize(client, credential.id));
    const authorizeUrl = new URL(url);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe('https://provider.example.com/authorize');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('plain-client');
    expect(authorizeUrl.searchParams.has('resource')).toBe(false);
    expect(authorizeUrl.searchParams.has('code_challenge')).toBe(false);
    expect(fake.log).toHaveLength(0);
  });
});
