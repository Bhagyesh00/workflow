/**
 * P6-87 Credential gate and Webhook user sign-in. A trigger that knows the person (Webhook with "Workspace
 * sign-in (OAuth2)", Form with user auth) starts a run only when the person has connected the private credentials
 * the run reaches: not ready is 428 with the credentials to connect, a check that throws is 503 and nothing runs.
 * The Webhook's Bearer resource is its own URL on the MCP base URL; `/rest/form-auth/code` takes a webhook path
 * only for that node; the connect link is a plain top-level address with no session in it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DataObject, NodePackage, WorkflowDefinition } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reachableNodes } from '../src/services/credential-gate';
import { WEBHOOK_TOKEN_KIND } from '../src/services/form-auth';
import {
  addToProject,
  chain,
  createTestServer,
  createWorkflow,
  executionsOf,
  flushRedis,
  node,
  outputOf,
  realMember,
  resetDatabase,
  signup,
  TEST_REDIS,
  type TestClient,
  type TestServer,
  waitForExecution,
} from './helpers';

let server: TestServer;
let provider: Server;
let providerUrl: string;
/** bearer token -> whose account it is */
const accounts = new Map<string, string>();

const gatePackage: NodePackage = {
  name: 'credential-gate-tests',
  nodes: [
    {
      description: {
        name: 'test.whoAmI',
        displayName: 'Who am I',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Who' },
        inputs: ['main'],
        outputs: ['main'],
        credentials: [{ name: 'oAuth2Api', required: true }],
        properties: [{ displayName: 'URL', name: 'url', type: 'string', default: '' }],
      },
      async execute(ctx) {
        const url = String(ctx.getNodeParameter('url', 0));
        const answer = (await ctx.helpers.httpRequestWithAuthentication('oAuth2Api', { url })) as DataObject;
        return [[{ json: { who: answer.who } }]];
      },
    },
  ],
  credentials: [],
};

const HIGH = '1000';
const env = {
  REDIS_URL: TEST_REDIS,
  MCP_ACCESS_ENABLED: 'true',
  OAUTH_SERVER_REGISTER_RATE_LIMIT: HIGH,
  OAUTH_SERVER_AUTHORIZE_RATE_LIMIT: HIGH,
  OAUTH_SERVER_TOKEN_RATE_LIMIT: HIGH,
  OAUTH_SERVER_REVOKE_RATE_LIMIT: HIGH,
  OAUTH_SERVER_WELL_KNOWN_RATE_LIMIT: HIGH,
};

beforeAll(async () => {
  server = await createTestServer(env, { nodePackages: [gatePackage] });
  provider = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/token') {
        const form = Object.fromEntries(new URLSearchParams(body));
        if (form.grant_type === 'authorization_code') {
          const access = `access-${form.code}-${randomUUID().slice(0, 6)}`;
          accounts.set(access, form.code);
          return json(200, { access_token: access, refresh_token: `refresh-${form.code}`, expires_in: 3600 });
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (req.url === '/me') {
        const who = accounts.get(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
        return who ? json(200, { who }) : json(401, { error: 'invalid_token' });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await server.close();
  await new Promise((r) => provider.close(r));
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  await flushRedis();
  accounts.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const repos = () => server.ctx.repos;
const hostOf = (s: TestServer) => new URL(s.ctx.config.baseUrl).host;

let signups = 0;
const ownerSignup = (s: TestServer = server) =>
  signup(s.app, { remoteAddress: `10.16.${Math.floor(++signups / 200)}.${signups % 200}` });

/** an owner with a team project, an editor and a viewer there */
async function setup(s: TestServer = server) {
  const owner = await ownerSignup(s);
  const team = owner.client.defaultProjectId!;
  const editor = await realMember(owner);
  await addToProject(s, owner.tenant.id, team, editor.user.id, 'project:editor');
  editor.client.defaultProjectId = team;
  const viewer = await realMember(owner);
  await addToProject(s, owner.tenant.id, team, viewer.user.id, 'project:viewer');
  return { owner, editor, viewer, team, tenantId: owner.tenant.id, slug: owner.tenant.slug };
}
type Setup = Awaited<ReturnType<typeof setup>>;

function oauth2Data(extra: DataObject = {}): DataObject {
  return {
    authUrl: 'https://auth.example.com/authorize',
    accessTokenUrl: `${providerUrl}/token`,
    clientId: 'shared-client',
    clientSecret: 'shared-client-secret',
    scope: 'read',
    ...extra,
  };
}

async function privateCredential(client: TestClient, name = 'Mail') {
  return client.data<{ id: string; name: string }>(
    client.post('/rest/credentials', { name, type: 'oAuth2Api', isResolvable: true, data: oauth2Data() }),
  );
}

/** the per user flow: authorize as `client`, then the provider sends that browser back with `code` */
async function connect(client: TestClient, credentialId: string, code: string) {
  const { url } = await client.data<{ url: string }>(client.post(`/rest/credentials/${credentialId}/authorize`));
  const state = new URL(url).searchParams.get('state')!;
  const res = await client.get(`/rest/oauth2/callback?code=${code}&state=${encodeURIComponent(state)}`);
  expect(res.statusCode).toBe(200);
}

const who = (credential: { id: string; name: string }) =>
  node('Who', 'test.whoAmI', { url: `${providerUrl}/me` }, [400, 0], {
    credentials: { oAuth2Api: { id: credential.id, name: credential.name } },
  });

async function activate(client: TestClient, id: string) {
  await client.data(client.post(`/rest/workflows/${id}/activate`));
}

function webhookNode(path: string, parameters: DataObject = {}) {
  return node('Webhook', 'core.webhook', { httpMethod: 'POST', path, authentication: 'n8nOAuth2', ...parameters });
}

/** a published Webhook with workspace sign-in feeding a node that uses the private credential */
async function webhookWorkflow(s: Setup, credential: { id: string; name: string }, parameters: DataObject = {}) {
  const path = `gate-${randomUUID().slice(0, 8)}`;
  const wf = await createWorkflow(s.owner.client, {
    name: `Webhook ${path}`,
    nodes: [webhookNode(path, parameters), who(credential)],
    connections: chain('Webhook', 'Who'),
  });
  await activate(s.owner.client, wf.id);
  return { ...wf, path, urlPath: `/webhook/${s.slug}/${path}` };
}

const send = (
  s: TestServer,
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
) =>
  s.app.inject({
    method,
    url,
    headers: { host: hostOf(s), ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(payload ? { payload: JSON.stringify(payload) } : {}),
  });

// ---------------------------------------------------------------------------------------------
// OAuth tokens of the workspace's MCP OAuth server, by inject

/** register, authorize for `resource`, consent as `user`, swap the code: an access token */
async function tokenFor(
  s: TestServer,
  slug: string,
  user: { client: TestClient },
  resource: string,
  host = hostOf(s),
): Promise<string> {
  const redirectUri = 'http://127.0.0.1:7788/cb';
  const base = `/mcp-oauth/${slug}`;
  const reg = await s.app.inject({
    method: 'POST',
    url: `${base}/register`,
    headers: { host, 'content-type': 'application/json' },
    payload: JSON.stringify({
      client_name: 'Gate client',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    }),
  });
  const clientId = (reg.json() as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString('base64url');
  const authorize = await s.app.inject({
    method: 'GET',
    url: `${base}/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource,
    })}`,
    headers: { host },
  });
  expect(authorize.statusCode).toBe(302);
  const location = new URL(String(authorize.headers.location));
  if (location.searchParams.get('error')) throw new Error(`authorize: ${location.searchParams.get('error')}`);
  const flow = location.searchParams.get('flow') ?? '';
  const { redirectUrl } = await user.client.data<{ redirectUrl: string }>(
    user.client.post('/rest/consent/approve', { flow, approved: true }),
  );
  const code = new URL(redirectUrl).searchParams.get('code') ?? '';
  const res = await s.app.inject({
    method: 'POST',
    url: `${base}/token`,
    headers: { host, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: clientId,
      resource,
    }).toString(),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { access_token: string }).access_token;
}

const resourceOf = (s: TestServer, slug: string, path: string, base = s.ctx.config.mcp.baseUrl) =>
  `${base}/webhook/${slug}/${path}`;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** the Who node's output of the workflow's newest run */
async function lastWho(s: Setup, workflowId: string): Promise<string | undefined> {
  const [run] = await executionsOf(server.ctx, s.tenantId, workflowId);
  await waitForExecution(server.ctx, s.tenantId, run.id, ['success']);
  const execution = await s.owner.client.data<{ state: unknown }>(s.owner.client.get(`/rest/executions/${run.id}`));
  return outputOf(execution.state, 'Who')[0]?.who as string | undefined;
}

// ---------------------------------------------------------------------------------------------

describe('the gate service', () => {
  it('lists the private credentials the trigger reaches, sub-nodes included, and checks the user\'s entries', async () => {
    const s = await setup();
    const mail = await privateCredential(s.owner.client, 'Mail');
    const calendar = await privateCredential(s.owner.client, 'Calendar');
    const fixed = await s.owner.client.data<{ id: string; name: string }>(
      s.owner.client.post('/rest/credentials', { name: 'Shared', type: 'oAuth2Api', data: oauth2Data() }),
    );
    const ref = (c: { id: string; name: string }) => ({ oAuth2Api: { id: c.id, name: c.name } });
    const definition = {
      name: 'reach',
      nodes: [
        node('Hook', 'core.webhook', { path: 'x' }),
        node('A', 'test.whoAmI', {}, [0, 0], { credentials: ref(mail) }),
        node('Fixed', 'test.whoAmI', {}, [0, 0], { credentials: ref(fixed) }),
        // a sub-node of A, feeding it over a non-main connection
        node('Model', 'test.whoAmI', {}, [0, 0], { credentials: ref(calendar) }),
        // not reached from the trigger
        node('Island', 'test.whoAmI', {}, [0, 0], { credentials: ref(await privateCredential(s.owner.client, 'Island')) }),
        // reached, but disabled
        node('Off', 'test.whoAmI', {}, [0, 0], { credentials: ref(await privateCredential(s.owner.client, 'Off')), disabled: true }),
      ],
      connections: {
        Hook: { main: [[{ node: 'A', type: 'main', index: 0 }]] },
        A: { main: [[{ node: 'Fixed', type: 'main', index: 0 }, { node: 'Off', type: 'main', index: 0 }]] },
        Model: { ai_languageModel: [[{ node: 'A', type: 'ai_languageModel', index: 0 }]] },
      },
    } as unknown as WorkflowDefinition;

    expect(reachableNodes(definition, 'Hook').map((n) => n.name).sort()).toEqual(['A', 'Fixed', 'Hook', 'Model']);
    const gate = server.ctx.credentialGate;
    const before = await gate.check(s.tenantId, definition, 'Hook', s.editor.user.id);
    expect(before.readyToExecute).toBe(false);
    expect(before.credentials.map((c) => [c.credentialName, c.status])).toEqual([
      ['Calendar', 'missing'],
      ['Mail', 'missing'],
    ]);
    expect(before.credentials[0]).toMatchObject({ credentialId: calendar.id, credentialType: 'oAuth2Api' });

    await connect(s.editor.client, mail.id, 'bea');
    const half = await gate.check(s.tenantId, definition, 'Hook', s.editor.user.id);
    expect(half.readyToExecute).toBe(false);
    expect(half.credentials.map((c) => [c.credentialName, c.status])).toEqual([
      ['Calendar', 'missing'],
      ['Mail', 'configured'],
    ]);
    // another user's connection does not count
    const owners = await gate.check(s.tenantId, definition, 'Hook', s.owner.user.id);
    expect(owners.credentials.every((c) => c.status === 'missing')).toBe(true);

    await connect(s.editor.client, calendar.id, 'bea');
    const ready = await gate.check(s.tenantId, definition, 'Hook', s.editor.user.id);
    expect(ready).toMatchObject({ readyToExecute: true });
    expect(ready.credentials.every((c) => c.status === 'configured')).toBe(true);
  });

  it('is ready with nothing to connect, and finds a private credential named without an id', async () => {
    const s = await setup();
    const plain = { name: 'p', nodes: [node('Hook', 'core.webhook', {})], connections: {} } as unknown as WorkflowDefinition;
    expect(await server.ctx.credentialGate.check(s.tenantId, plain, 'Hook', s.editor.user.id)).toEqual({
      readyToExecute: true,
      credentials: [],
    });
    const mail = await privateCredential(s.owner.client, 'ByName');
    const named = {
      name: 'n',
      nodes: [node('Hook', 'core.webhook', {}), node('A', 'test.whoAmI', {}, [0, 0], { credentials: { oAuth2Api: { id: null, name: 'ByName' } } })],
      connections: chain('Hook', 'A'),
    } as unknown as WorkflowDefinition;
    const result = await server.ctx.credentialGate.check(s.tenantId, named, 'Hook', s.editor.user.id);
    expect(result.credentials).toMatchObject([{ credentialId: mail.id, status: 'missing' }]);
  });

  it('builds the connect link as a plain address: the credential, the action and the return path, nothing else', () => {
    const helper = server.ctx.credentialGate.forRun('t', { name: 'x', nodes: [], connections: {} } as never, 'p');
    const url = new URL(helper.connectPageUrl('cred-1', 'disconnect', '/form/acme/who'));
    expect(url.origin).toBe(new URL(server.ctx.config.baseUrl).origin);
    expect(url.pathname).toBe('/credential-connect/cred-1');
    expect([...url.searchParams.keys()].sort()).toEqual(['action', 'returnTo']);
    expect(url.searchParams.get('action')).toBe('disconnect');
    expect(url.searchParams.get('returnTo')).toBe('/form/acme/who');
  });
});

describe('Webhook with workspace sign-in: Bearer', () => {
  it('answers 428 with the credentials to connect, starts no run, then runs with the user\'s own token', async () => {
    const s = await setup();
    const credential = await privateCredential(s.owner.client);
    const hook = await webhookWorkflow(s, credential);
    const token = await tokenFor(server, s.slug, s.editor, resourceOf(server, s.slug, hook.path));

    const blocked = await send(server, 'POST', hook.urlPath, bearer(token), {});
    expect(blocked.statusCode).toBe(428);
    expect(blocked.json()).toEqual({
      status: 'credential_connections_required',
      readyToExecute: false,
      credentials: [
        {
          credentialId: credential.id,
          credentialName: credential.name,
          credentialType: 'oAuth2Api',
          credentialStatus: 'missing',
        },
      ],
    });
    expect(await executionsOf(server.ctx, s.tenantId, hook.id)).toHaveLength(0);

    await connect(s.editor.client, credential.id, 'bea');
    const ok = await send(server, 'POST', hook.urlPath, bearer(token), {});
    expect(ok.statusCode).toBe(200);
    expect(await lastWho(s, hook.id)).toBe('bea');
  });

  it('runs two users each with their own account', async () => {
    const s = await setup();
    const second = await realMember(s.owner);
    await addToProject(server, s.tenantId, s.team, second.user.id, 'project:editor');
    const credential = await privateCredential(s.owner.client);
    const hook = await webhookWorkflow(s, credential);
    await connect(s.editor.client, credential.id, 'bea');
    await connect(second.client, credential.id, 'cal');
    for (const [user, name] of [
      [s.editor, 'bea'],
      [second, 'cal'],
    ] as const) {
      const token = await tokenFor(server, s.slug, user, resourceOf(server, s.slug, hook.path));
      expect((await send(server, 'POST', hook.urlPath, bearer(token), {})).statusCode).toBe(200);
      expect(await lastWho(s, hook.id)).toBe(name);
    }
  });

  it('fails closed: a check that throws is 503 and no run starts', async () => {
    const s = await setup();
    const credential = await privateCredential(s.owner.client);
    const hook = await webhookWorkflow(s, credential);
    await connect(s.editor.client, credential.id, 'bea');
    const token = await tokenFor(server, s.slug, s.editor, resourceOf(server, s.slug, hook.path));
    vi.spyOn(server.ctx.credentialGate, 'check').mockRejectedValue(new Error('connection to db-host:5432 refused'));
    const res = await send(server, 'POST', hook.urlPath, bearer(token), {});
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'credential_readiness_check_failed' });
    expect(res.body).not.toContain('db-host');
    expect(await executionsOf(server.ctx, s.tenantId, hook.id)).toHaveLength(0);
  });

  it('refuses a token for another resource: another webhook, the tenant server, an MCP trigger path', async () => {
    const s = await setup();
    const credential = await privateCredential(s.owner.client);
    const one = await webhookWorkflow(s, credential);
    const two = await webhookWorkflow(s, credential);
    await connect(s.editor.client, credential.id, 'bea');
    const tokenOne = await tokenFor(server, s.slug, s.editor, resourceOf(server, s.slug, one.path));
    expect((await send(server, 'POST', one.urlPath, bearer(tokenOne), {})).statusCode).toBe(200);
    const other = await send(server, 'POST', two.urlPath, bearer(tokenOne), {});
    expect(other.statusCode).toBe(401);
    expect(String(other.headers['www-authenticate'])).toContain('error="invalid_token"');
    const serverToken = await tokenFor(server, s.slug, s.editor, `${server.ctx.config.mcp.baseUrl}/mcp-server/${s.slug}/http`);
    expect((await send(server, 'POST', two.urlPath, bearer(serverToken), {})).statusCode).toBe(401);
    expect(await executionsOf(server.ctx, s.tenantId, two.id)).toHaveLength(0);
  });

  it('refuses a token from another tenant', async () => {
    const s = await setup();
    const credential = await privateCredential(s.owner.client);
    const hook = await webhookWorkflow(s, credential);
    const stranger = await setup();
    const strangerHook = await webhookWorkflow(stranger, await privateCredential(stranger.owner.client));
    const foreign = await tokenFor(server, stranger.slug, stranger.owner, resourceOf(server, stranger.slug, strangerHook.path));
    const res = await send(server, 'POST', hook.urlPath, bearer(foreign), {});
    expect(res.statusCode).toBe(401);
    expect(await executionsOf(server.ctx, s.tenantId, hook.id)).toHaveLength(0);
    // and the stranger's authorize for this tenant's webhook is no resource of theirs
    await expect(tokenFor(server, stranger.slug, stranger.owner, resourceOf(server, s.slug, hook.path))).rejects.toThrow(
      /invalid_target/,
    );
  });

  it('asks for a token with the challenge, and a wrong one is 401', async () => {
    const s = await setup();
    const hook = await webhookWorkflow(s, await privateCredential(s.owner.client));
    const none = await send(server, 'POST', hook.urlPath, {}, {});
    expect(none.statusCode).toBe(401);
    const metadataUrl = `${server.ctx.config.mcp.baseUrl}/.well-known/oauth-protected-resource${hook.urlPath}`;
    expect(String(none.headers['www-authenticate'])).toContain(`resource_metadata="${metadataUrl}"`);
    expect((await send(server, 'POST', hook.urlPath, bearer('wfo_at_not-a-token'), {})).statusCode).toBe(401);
    expect(await executionsOf(server.ctx, s.tenantId, hook.id)).toHaveLength(0);
  });

  it('keeps "Require Workflow Execute Permission" on by default: a viewer is 403, an editor runs', async () => {
    const s = await setup();
    const credential = await privateCredential(s.owner.client);
    const strict = await webhookWorkflow(s, credential);
    const open = await webhookWorkflow(s, credential, { requireExecuteAccess: false });
    await connect(s.editor.client, credential.id, 'bea');

    const viewerStrict = await tokenFor(server, s.slug, s.viewer, resourceOf(server, s.slug, strict.path));
    const refused = await send(server, 'POST', strict.urlPath, bearer(viewerStrict), {});
    expect(refused.statusCode).toBe(403);
    expect(await executionsOf(server.ctx, s.tenantId, strict.id)).toHaveLength(0);

    const viewerOpen = await tokenFor(server, s.slug, s.viewer, resourceOf(server, s.slug, open.path));
    // past the execute check, the viewer has not connected the account: the gate answers, no run starts
    expect((await send(server, 'POST', open.urlPath, bearer(viewerOpen), {})).statusCode).toBe(428);
    expect(await executionsOf(server.ctx, s.tenantId, open.id)).toHaveLength(0);

    const editorStrict = await tokenFor(server, s.slug, s.editor, resourceOf(server, s.slug, strict.path));
    expect((await send(server, 'POST', strict.urlPath, bearer(editorStrict), {})).statusCode).toBe(200);
  });
});

describe('the resource follows config.mcp.baseUrl', () => {
  const OTHER = 'http://mcp.example.test:8443';
  let split: TestServer;
  beforeAll(async () => {
    split = await createTestServer(
      { ...env, MCP_BASE_URL: OTHER },
      { reset: false, nodePackages: [gatePackage] },
    );
  });
  afterAll(async () => {
    await split?.close();
  });

  it('builds the Webhook resource and its metadata on MCP_BASE_URL, not on the Webhook URL\'s base URL', async () => {
    expect(split.ctx.config.baseUrl).not.toBe(OTHER);
    expect(split.ctx.config.mcp.baseUrl).toBe(OTHER);
    const s = await setup(split);
    const credential = await privateCredential(s.owner.client);
    const hook = await webhookWorkflow(s, credential);
    await connect(s.editor.client, credential.id, 'bea');

    // the metadata names the resource on the MCP host
    const meta = await split.app.inject({
      method: 'GET',
      url: `/.well-known/oauth-protected-resource${hook.urlPath}`,
      headers: { host: new URL(OTHER).host },
    });
    expect(meta.statusCode).toBe(200);
    expect(meta.json()).toMatchObject({
      resource: `${OTHER}${hook.urlPath}`,
      authorization_servers: [`${OTHER}/mcp-oauth/${s.slug}`],
    });
    // the 401 points at it
    const none = await send(split, 'POST', hook.urlPath, {}, {});
    expect(none.statusCode).toBe(401);
    expect(String(none.headers['www-authenticate'])).toContain(
      `resource_metadata="${OTHER}/.well-known/oauth-protected-resource${hook.urlPath}"`,
    );

    // the webhook's own URL on the base URL is not a resource; the MCP host's is
    await expect(
      tokenFor(split, s.slug, s.editor, `${split.ctx.config.baseUrl}${hook.urlPath}`, new URL(OTHER).host),
    ).rejects.toThrow(/invalid_target/);
    const token = await tokenFor(split, s.slug, s.editor, `${OTHER}${hook.urlPath}`, new URL(OTHER).host);
    const ok = await send(split, 'POST', hook.urlPath, bearer(token), {});
    expect(ok.statusCode).toBe(200);
    expect(await lastWho(s, hook.id)).toBe('bea');
  });

  it('serves a Webhook resource while MCP access is off, as an MCP Server Trigger; a plain Webhook is no resource', async () => {
    const off = await createTestServer(
      { ...env, MCP_ACCESS_ENABLED: 'false', MCP_BASE_URL: OTHER },
      { reset: false, nodePackages: [gatePackage] },
    );
    try {
      const s = await setup(off);
      const signed = await createWorkflow(s.owner.client, { nodes: [webhookNode('signed')] });
      const plain = await createWorkflow(s.owner.client, {
        nodes: [webhookNode('plain', { authentication: 'none' })],
      });
      await activate(s.owner.client, signed.id);
      await activate(s.owner.client, plain.id);
      const meta = (path: string) =>
        off.app.inject({
          method: 'GET',
          url: `/.well-known/oauth-protected-resource/webhook/${s.slug}/${path}`,
          headers: { host: new URL(OTHER).host },
        });
      expect((await meta('signed')).statusCode).toBe(200);
      expect((await meta('plain')).statusCode).toBe(404);
      expect((await meta('missing')).statusCode).toBe(404);
    } finally {
      await off.close();
    }
  });
});

describe('/rest/form-auth/code for a webhook', () => {
  const codeFor = (client: TestClient, returnTo: string) => client.post('/rest/form-auth/code', { returnTo });

  it('takes the path of a Webhook with workspace sign-in only, and mints a webhook-user token', async () => {
    const s = await setup();
    const signed = await createWorkflow(s.owner.client, { nodes: [webhookNode('signed')] });
    const plain = await createWorkflow(s.owner.client, { nodes: [webhookNode('plain', { authentication: 'none' })] });
    for (const wf of [signed, plain]) await activate(s.owner.client, wf.id);

    // any member may ask for the webhook that has the sign-in
    const res = await codeFor(s.editor.client, `/webhook/${s.slug}/signed`);
    expect(res.statusCode).toBe(200);
    const code = (res.json().data as { code: string }).code;
    const token = await server.ctx.formAuth.exchangeCode(code);
    expect(token).toBeTruthy();
    expect(server.ctx.formTokens.verify(token!)).toMatchObject({
      kind: WEBHOOK_TOKEN_KIND,
      tenantId: s.tenantId,
      path: `/webhook/${s.slug}/signed`,
      userId: s.editor.user.id,
    });
    expect(await server.ctx.formAuth.verifyToken(token!)).toMatchObject({ id: s.editor.user.id });
    // the code is used once
    expect(await server.ctx.formAuth.exchangeCode(code)).toBeNull();

    // never any webhook: a webhook with another authentication, or none, or an unknown path
    for (const path of ['plain', 'missing']) {
      expect((await codeFor(s.editor.client, `/webhook/${s.slug}/${path}`)).statusCode).toBe(403);
    }
    // the test address of an unlistened webhook serves nothing
    expect((await codeFor(s.editor.client, `/webhook-test/${s.slug}/signed`)).statusCode).toBe(403);
  });

  it('refuses another workspace\'s webhook as it does a form, and a path with a way out', async () => {
    const s = await setup();
    const other = await setup();
    const wf = await createWorkflow(other.owner.client, { nodes: [webhookNode('theirs')] });
    await activate(other.owner.client, wf.id);
    expect((await codeFor(s.editor.client, `/webhook/${other.slug}/theirs`)).statusCode).toBe(403);
    for (const path of [`/webhook/${s.slug}/../../rest/me`, `/webhook/${s.slug}/%2e%2e/x`, 'https://evil.example/webhook/a/b']) {
      expect((await codeFor(s.editor.client, path)).statusCode).toBe(400);
    }
  });

  it('still takes a Chat Trigger\'s /chat path, with a chat-user token', async () => {
    const s = await setup();
    const res = await codeFor(s.editor.client, `/webhook/${s.slug}/chat-id/chat`);
    expect(res.statusCode).toBe(200);
    const token = await server.ctx.formAuth.exchangeCode((res.json().data as { code: string }).code);
    expect(server.ctx.formTokens.verify(token!)).toMatchObject({ kind: 'chat-user' });
  });

  it('lets a browser sign in end to end: page, code, cookie, then the run as that user', async () => {
    const s = await setup();
    const credential = await privateCredential(s.owner.client);
    const hook = await webhookWorkflow(s, credential, { httpMethod: 'GET', oauthClient: 'auto' });
    await connect(s.editor.client, credential.id, 'bea');
    const html = { accept: 'text/html', 'sec-fetch-mode': 'navigate' };

    const first = await send(server, 'GET', hook.urlPath, html);
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe(`/form-auth?redirect=${encodeURIComponent(hook.urlPath)}`);

    const code = ((await codeFor(s.editor.client, hook.urlPath)).json().data as { code: string }).code;
    const swapped = await send(server, 'GET', `${hook.urlPath}?code=${code}`, html);
    expect(swapped.statusCode).toBe(302);
    expect(swapped.headers.location).toBe(hook.urlPath);
    const cookie = swapped.cookies.find((c) => c.name === `ncb-form-auth-wf-${hook.id}`);
    expect(cookie).toBeTruthy();
    expect(cookie?.path).toBe(hook.urlPath);
    expect(cookie?.httpOnly).toBe(true);

    const opened = await send(server, 'GET', hook.urlPath, { ...html, cookie: `${cookie!.name}=${cookie!.value}` });
    expect(opened.statusCode).toBe(200);
    expect(await lastWho(s, hook.id)).toBe('bea');

    // a code is not reusable, and another user's code gives another user's run, not this cookie's
    const again = await send(server, 'GET', `${hook.urlPath}?code=${code}`, html);
    expect(again.statusCode).toBe(302);
    expect(String(again.headers.location)).toContain('/form-auth?redirect=');
  });

  it('gates a browser that has not connected: 428, no run', async () => {
    const s = await setup();
    const hook = await webhookWorkflow(s, await privateCredential(s.owner.client), { httpMethod: 'GET', oauthClient: 'auto' });
    const token = server.ctx.formTokens.sign(
      { kind: WEBHOOK_TOKEN_KIND, tenantId: s.tenantId, workflowId: hook.id, userId: s.editor.user.id },
      3600,
    );
    const res = await send(server, 'GET', hook.urlPath, { accept: 'text/html', cookie: `ncb-form-auth-wf-${hook.id}=${token}` });
    expect(res.statusCode).toBe(428);
    expect(await executionsOf(server.ctx, s.tenantId, hook.id)).toHaveLength(0);
  });
});

describe('Form Trigger with user auth', () => {
  const formNode = (path: string) =>
    node('Start', 'core.formTrigger', {
      formTitle: 'Who',
      path,
      authentication: 'n8nUserAuth',
      formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] },
    });

  async function formWorkflow(s: Setup, credential: { id: string; name: string }) {
    const path = `form-${randomUUID().slice(0, 8)}`;
    const wf = await createWorkflow(s.owner.client, {
      nodes: [formNode(path), who(credential)],
      connections: chain('Start', 'Who'),
    });
    await activate(s.owner.client, wf.id);
    return { ...wf, path, urlPath: `/form/${s.slug}/${path}` };
  }

  const tokenOf = (s: Setup, workflowId: string, userId: string) =>
    server.ctx.formTokens.sign({ kind: 'form-user', tenantId: s.tenantId, workflowId, userId }, 3600);

  it('shows the panel to an unconnected visitor, answers a submit 428, and runs with their token once connected', async () => {
    const s = await setup();
    const credential = await privateCredential(s.owner.client, 'Calendar <b>x</b>');
    const form = await formWorkflow(s, credential);
    const token = tokenOf(s, form.id, s.editor.user.id);

    const page = await send(server, 'GET', form.urlPath, { 'x-auth-token': token });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('0 of 1 connected');
    expect(page.body).toMatch(/<button type="submit" id="form-submit" disabled>/);
    // the name is text, the link has the credential and the form's path and nothing of the session
    expect(page.body).not.toContain('<b>x</b>');
    expect(page.body).toContain('Calendar &lt;b&gt;x&lt;/b&gt;');
    expect(page.body).toContain(
      `/credential-connect/${credential.id}?action=connect&amp;returnTo=${encodeURIComponent(form.urlPath)}`,
    );
    // the page's own config holds the token it submits with (as before); the panel's links and text do not
    expect(page.body).not.toMatch(/credential-connect[^"<]*eyJ/);
    expect(page.body).not.toMatch(/wf_session/);

    const blocked = await send(server, 'POST', form.urlPath, { 'x-auth-token': token }, { 'field-0': 'Ann' });
    expect(blocked.statusCode).toBe(428);
    expect(blocked.json()).toMatchObject({ readyToExecute: false });
    expect(await executionsOf(server.ctx, s.tenantId, form.id)).toHaveLength(0);

    await connect(s.editor.client, credential.id, 'bea');
    const ready = await send(server, 'GET', form.urlPath, { 'x-auth-token': token });
    expect(ready.body).toContain('1 of 1 connected');
    expect(ready.body).toMatch(/<button type="submit" id="form-submit">/);
    const ok = await send(server, 'POST', form.urlPath, { 'x-auth-token': token }, { 'field-0': 'Ann' });
    expect(ok.statusCode).toBe(200);
    expect(await lastWho(s, form.id)).toBe('bea');
  });

  it('is 503 when the check throws, and the run does not start', async () => {
    const s = await setup();
    const credential = await privateCredential(s.owner.client);
    const form = await formWorkflow(s, credential);
    await connect(s.editor.client, credential.id, 'bea');
    vi.spyOn(server.ctx.credentialGate, 'check').mockRejectedValue(new Error('boom'));
    const token = tokenOf(s, form.id, s.editor.user.id);
    const res = await send(server, 'POST', form.urlPath, { 'x-auth-token': token }, { 'field-0': 'Ann' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'credential_readiness_check_failed' });
    expect(await executionsOf(server.ctx, s.tenantId, form.id)).toHaveLength(0);
    const page = await send(server, 'GET', form.urlPath, { 'x-auth-token': token });
    expect(page.body).toContain("We couldn't check your connected accounts");
    expect(page.body).not.toContain('boom');
  });
});
