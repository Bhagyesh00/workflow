/**
 * P6 S2 (C0e): the identity contracts of commit 0. A disabled member is refused at every door (session
 * load, API key, switch, push ping, form code, OAuth callback, MCP API key, the Assistant's run scope and its
 * approvals, the builder) and is still found by PATCH and DELETE /members/:userId; `disableMember` touches one
 * workspace only. Config seams (`USER_MANAGEMENT_JWT_DURATION_HOURS`, `PUBLIC_API_DISABLED`, `allowInsecureIdp`),
 * the reserved `/sso` and `/scim` paths, `endUserId` on runs, `markFirstProductionFailure`, the settings patch,
 * the moved member and API key routes, `apiKeyScopesForRole`, `changeMemberRole`, `requireAnyScope`, and the
 * PASSES list: login, switch, invite, publish, a run, a share, a credential move and a project delete with
 * transfer, and a plain OAuth2 callback behave as before with every stub in place.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Scope } from '@workflow/workflow';
import type { FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiKeyScopesForRole } from '../src/http/api-key-scopes';
import { type AuthContext, requireAnyScope } from '../src/http/auth';
import { PING_INTERVAL_MS } from '../src/routes/push';
import { createRunScope } from '../src/services/assistant/run';
import { ASSISTANT_TOOL_NO_ACCESS } from '../src/services/assistant/types';
import { SSO_SESSION_FENCED_MESSAGE, sha256 } from '../src/services/auth';
import { MCP_KEY_AUDIENCE } from '../src/services/mcp/types';
import { changeMemberRole, disableMember, LAST_OWNER_MESSAGE } from '../src/services/member-disable';
import {
  chain,
  createTestServer,
  createWorkflow,
  credentialIn,
  executionsOf,
  freePort,
  memberAs,
  node,
  ORIGIN,
  realMember,
  sessionFor,
  setNode,
  signup,
  type TestMember,
  type TestServer,
  teamProjectOf,
  waitFor,
  waitForExecution,
  workflowIn,
} from './helpers';

let server: TestServer;
let baseUrl: string;
/** a second server on the same database: 2 hour sessions, public API off, plain http to identity providers */
let other: TestServer;
let tokenServer: Server;
let tokenUrl: string;

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = await createTestServer({ AI_ENABLED: 'true', MCP_ACCESS_ENABLED: 'true', MCP_BASE_URL: baseUrl });
  await server.app.listen({ port, host: '127.0.0.1' });
  other = await createTestServer(
    { USER_MANAGEMENT_JWT_DURATION_HOURS: '2', PUBLIC_API_DISABLED: 'true' },
    { reset: false, startMain: false, allowInsecureIdp: true },
  );
  tokenServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const code = new URLSearchParams(body).get('code');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: `access-for-${code}`, token_type: 'Bearer', expires_in: 3600 }));
    });
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
  tokenUrl = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token`;
}, 120_000);

afterAll(async () => {
  await other?.close();
  await server?.close();
  await new Promise<void>((resolve) => (tokenServer ? tokenServer.close(() => resolve()) : resolve()));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Owner = Awaited<ReturnType<typeof signup>>;

let signups = 0;
/** a new workspace from its own IP (signup allows 20 an hour per IP) */
const newOwner = (): Promise<Owner> => {
  signups++;
  return signup(server.app, { remoteAddress: `10.95.${signups >> 8}.${signups & 255}` });
};

/** a member of workspace A (the owner's) who is also a member of workspace B, with a session in each */
async function twoWorkspaceMember() {
  const a = await newOwner();
  const b = await newOwner();
  const member = await realMember(a);
  await server.ctx.repos.memberships.add(b.tenant.id, member.user.id, 'member');
  const user = await server.ctx.repos.users.get(member.user.id);
  await server.ctx.repos.projects.ensurePersonal(b.tenant.id, user!);
  const inB = await sessionFor(server, b.tenant.id, member.user.id);
  return { a, b, member, inB };
}

/** the error a promise rejects with, or undefined when it resolves */
async function failure(
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; code?: string; message?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode?: number; code?: string; message?: string };
  }
  return {};
}

/** a fake request for the scope gates (`request.server.access` is what `requireScope` reads) */
function requestOf(auth: AuthContext): FastifyRequest {
  return { auth, server: { access: server.ctx.access } } as unknown as FastifyRequest;
}

async function mcpClient(tenantId: string, name = 'Client') {
  const id = `client-${randomUUID()}`;
  await server.ctx.repos.mcpOAuth.createClient({
    id,
    tenantId,
    name,
    redirectUris: ['https://client.example/cb'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethod: 'none',
  });
  return id;
}

/** an MCP OAuth access and refresh token of `userId` in `tenantId`; returns the access token's hash */
async function mcpTokens(tenantId: string, userId: string): Promise<string> {
  const clientId = await mcpClient(tenantId);
  const access = sha256(`access-${randomUUID()}`);
  const expiresAt = new Date(Date.now() + 3_600_000);
  const base = { tenantId, clientId, userId, resource: `${baseUrl}/mcp-server/x/http`, expiresAt };
  await server.ctx.repos.mcpOAuth.saveTokens(
    { ...base, tokenHash: access },
    { ...base, tokenHash: sha256(`refresh-${randomUUID()}`) },
  );
  return access;
}

/** open GET /rest/push with `cookie`; `ended` is set once the server closes the stream */
async function openPush(cookie: string) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/rest/push`, { headers: { cookie }, signal: controller.signal });
  expect(res.status).toBe(200);
  const state = { ended: false, frames: '' };
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        state.frames += decoder.decode(value, { stream: true });
      }
    } catch {
      // aborted by the test
    }
    state.ended = true;
  })();
  return { state, close: () => controller.abort() };
}

// ---------------------------------------------------------------------------------------------

describe('a disabled member', () => {
  it('is refused at session load, API key and switch, and keeps workspace B', async () => {
    const { a, b, member, inB } = await twoWorkspaceMember();
    const { key } = await server.ctx.auth.createApiKey(a.tenant.id, member.user.id, 'mine');
    expect((await member.client.get('/rest/auth/me')).statusCode).toBe(200);
    expect(
      (await server.app.inject({ url: '/api/v1/workflows', headers: { 'x-api-key': key } })).statusCode,
    ).toBe(200);

    expect(await server.ctx.repos.memberships.disable(a.tenant.id, member.user.id)).toBe(true);
    expect(await server.ctx.repos.memberships.disable(a.tenant.id, member.user.id)).toBe(false);
    expect(await server.ctx.repos.memberships.get(a.tenant.id, member.user.id)).toBeUndefined();
    expect(
      await server.ctx.repos.memberships.getIncludingDisabled(a.tenant.id, member.user.id),
    ).toMatchObject({
      role: 'member',
      disabledAt: expect.any(Date),
    });

    // session load (the session row is kept: the membership refuses it)
    expect((await member.client.get('/rest/auth/me')).statusCode).toBe(401);
    // API key
    expect(
      (await server.app.inject({ url: '/api/v1/workflows', headers: { 'x-api-key': key } })).statusCode,
    ).toBe(401);
    expect(await server.ctx.auth.authenticateApiKey(key)).toBeUndefined();
    // B is kept: its session works, its workspace list has B only, a switch to A is refused
    expect(await server.ctx.repos.memberships.get(b.tenant.id, member.user.id)).toMatchObject({
      role: 'member',
    });
    const me = await inB.client.data(inB.client.get('/rest/auth/me'));
    expect(me.tenant.id).toBe(b.tenant.id);
    expect(
      (await server.ctx.repos.memberships.listForUser(member.user.id)).map((t: { id: string }) => t.id),
    ).toEqual([b.tenant.id]);
    const switched = await inB.client.post('/rest/auth/switch-tenant', { tenantId: a.tenant.id });
    expect(switched.statusCode).toBe(404);
    // the members list still shows the disabled member
    const members = await a.client.data<Array<{ userId?: string; id?: string; disabledAt?: unknown }>>(
      a.client.get('/rest/members'),
    );
    expect(JSON.stringify(members)).toContain(member.user.id);
  });

  it('is still found by PATCH and DELETE /members/:userId', async () => {
    const owner = await newOwner();
    const member = await realMember(owner);
    await server.ctx.repos.memberships.disable(owner.tenant.id, member.user.id);
    const patched = await owner.client.data(
      owner.client.patch(`/rest/members/${member.user.id}`, { role: 'admin' }),
    );
    expect(patched).toEqual({ userId: member.user.id, role: 'admin' });
    expect(
      await server.ctx.repos.memberships.getIncludingDisabled(owner.tenant.id, member.user.id),
    ).toMatchObject({ role: 'admin', disabledAt: expect.any(Date) });
    const removed = await owner.client.request('DELETE', `/rest/members/${member.user.id}`, {
      deleteData: true,
    });
    expect(removed.statusCode).toBe(200);
    expect(
      await server.ctx.repos.memberships.getIncludingDisabled(owner.tenant.id, member.user.id),
    ).toBeUndefined();
    // an invitation to a disabled member is "already a member"
    const again = await realMember(owner);
    await server.ctx.repos.memberships.disable(owner.tenant.id, again.user.id);
    const invite = await owner.client.post('/rest/members/invite', { email: again.email, role: 'member' });
    expect(invite.statusCode).toBeGreaterThanOrEqual(400);
    expect(invite.statusCode).toBeLessThan(500);
  });

  it('loses the push stream at the next ping', async () => {
    const owner = await newOwner();
    const member = await realMember(owner);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const push = await openPush(member.client.cookie!);
    try {
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      await waitFor(async () => (push.state.frames.includes('event: ping') ? true : undefined), {
        message: 'a ping',
      });
      expect(push.state.ended).toBe(false);
      await server.ctx.repos.memberships.disable(owner.tenant.id, member.user.id);
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      await waitFor(async () => (push.state.ended ? true : undefined), { message: 'the stream to end' });
    } finally {
      push.close();
    }
  });

  it('gets no form code', async () => {
    const owner = await newOwner();
    const member = await realMember(owner);
    const { auth } = await sessionFor(server, owner.tenant.id, member.user.id);
    const returnTo = `/form/${owner.tenant.slug}/who`;
    expect(typeof (await server.ctx.formAuth.issueCode(auth, returnTo))).toBe('string');
    await server.ctx.repos.memberships.disable(owner.tenant.id, member.user.id);
    expect((await failure(server.ctx.formAuth.issueCode(auth, returnTo))).statusCode).toBeGreaterThanOrEqual(
      400,
    );
  });

  it("can't finish an OAuth2 callback started before", async () => {
    const owner = await newOwner();
    const editor = await memberAs(owner, 'editor');
    const credential = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'Provider',
        type: 'testPkceOAuth2Api',
        data: {
          authUrl: 'https://auth.example.com/authorize',
          accessTokenUrl: tokenUrl,
          clientId: 'client-1',
          clientSecret: 'client-secret',
        },
      }),
    );
    const started = await editor.client.data(
      editor.client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`),
    );
    const state = new URL(started.url).searchParams.get('state')!;
    await server.ctx.repos.memberships.disable(owner.tenant.id, editor.user.id);
    const callback = await server.app.inject({
      url: `/rest/oauth2/callback?code=late&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(400);
    expect(callback.body).toContain('no longer edit credentials');
  });

  it("gets 401 at the MCP server with the member's MCP API key", async () => {
    const owner = await newOwner();
    await owner.client.data(owner.client.patch('/rest/mcp/settings', { mcpAccessEnabled: true }));
    const member = await realMember(owner);
    const { key } = await server.ctx.auth.createApiKey(
      owner.tenant.id,
      member.user.id,
      'mcp',
      [],
      MCP_KEY_AUDIENCE,
    );
    const call = () =>
      server.app.inject({
        method: 'POST',
        url: `/mcp-server/${owner.tenant.slug}/http`,
        headers: {
          host: new URL(baseUrl).host,
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
    expect((await call()).statusCode).not.toBe(401);
    await server.ctx.repos.memberships.disable(owner.tenant.id, member.user.id);
    expect((await call()).statusCode).toBe(401);
  });

  it("is refused by the Assistant's run scope (resume and settle) and by a pending approval", async () => {
    const owner = await newOwner();
    const member = await memberAs(owner, 'admin');
    const input = {
      tenantId: owner.tenant.id,
      userId: member.user.id,
      threadId: randomUUID(),
      runId: randomUUID(),
      actor: { userId: member.user.id },
      signal: new AbortController().signal,
      attachments: [],
    };
    const scope = await createRunScope(server.ctx, input);
    expect(scope.role).toBe('admin');
    await server.ctx.repos.memberships.disable(owner.tenant.id, member.user.id);
    const refused = await failure(createRunScope(server.ctx, { ...input, runId: randomUUID() }));
    expect(refused).toMatchObject({
      statusCode: 403,
      message: 'You are no longer a member of this workspace',
    });

    // an approved card of the member: `runApproved` refuses it instead of running the tool
    const card = {
      id: randomUUID(),
      tenantId: owner.tenant.id,
      userId: member.user.id,
      threadId: input.threadId,
      toolCallId: 'call-1',
      toolName: 'list_workflows',
      status: 'approved',
    };
    const cards = server.ctx.repos.assistantConfirmations;
    vi.spyOn(cards, 'get').mockResolvedValue(card as never);
    const refuse = vi.spyOn(cards, 'refuseApproved').mockResolvedValue(true);
    const approvals = server.ctx.assistantApprovals as unknown as { writeResult: () => Promise<void> };
    vi.spyOn(approvals, 'writeResult').mockResolvedValue(undefined);
    await server.ctx.assistantApprovals.runApproved(scope, card as never);
    expect(refuse).toHaveBeenCalledWith(owner.tenant.id, member.user.id, card.id, ASSISTANT_TOOL_NO_ACCESS);
  });

  it("can't call the builder", async () => {
    const owner = await newOwner();
    const member = await memberAs(owner, 'admin');
    const workflow = await createWorkflow(owner.client, { nodes: [node('Start', 'core.manualTrigger')] });
    const before = await member.client.post('/rest/ai/sessions', { workflowId: workflow.id });
    expect(before.statusCode).not.toBe(401);
    expect(before.statusCode).not.toBe(403);
    await server.ctx.repos.memberships.disable(owner.tenant.id, member.user.id);
    expect((await member.client.post('/rest/ai/sessions', { workflowId: workflow.id })).statusCode).toBe(401);
    expect((await member.client.post('/rest/ai/build', { workflowId: workflow.id })).statusCode).toBe(401);
  });
});

describe('disableMember and enableMember', () => {
  it("deletes A's sessions and MCP OAuth rows of the member and no one else's; keeps the API keys", async () => {
    const { a, b, member, inB } = await twoWorkspaceMember();
    const bystander = await realMember(a);
    const inA = await sessionFor(server, a.tenant.id, member.user.id);
    const theirs = await sessionFor(server, a.tenant.id, bystander.user.id);
    const mineInA = await mcpTokens(a.tenant.id, member.user.id);
    const mineInB = await mcpTokens(b.tenant.id, member.user.id);
    const theirsInA = await mcpTokens(a.tenant.id, bystander.user.id);
    const { key } = await server.ctx.auth.createApiKey(a.tenant.id, member.user.id, 'kept');

    expect(await disableMember(server.ctx, a.tenant.id, member.user.id, a.user.id)).toBe(true);
    expect(await disableMember(server.ctx, a.tenant.id, member.user.id, a.user.id)).toBe(false);

    const sessions = server.ctx.repos.sessions;
    expect(await sessions.get(inA.sessionId)).toBeUndefined();
    expect(await sessions.get(inB.sessionId)).toBeDefined();
    expect(await sessions.get(theirs.sessionId)).toBeDefined();
    const oauth = server.ctx.repos.mcpOAuth;
    expect(await oauth.getAccessToken(a.tenant.id, mineInA)).toBeUndefined();
    expect(await oauth.getAccessToken(b.tenant.id, mineInB)).toBeDefined();
    expect(await oauth.getAccessToken(a.tenant.id, theirsInA)).toBeDefined();
    // the key row stays (refused through the membership) and works again once enabled
    expect(await server.ctx.auth.authenticateApiKey(key)).toBeUndefined();
    expect(await server.ctx.repos.memberships.get(b.tenant.id, member.user.id)).toBeDefined();

    expect(await server.ctx.repos.memberships.enable(a.tenant.id, member.user.id)).toBe(true);
    expect((await server.ctx.auth.authenticateApiKey(key))?.user.id).toBe(member.user.id);
  });

  it('refuses an owner, and 404s someone who is not a member', async () => {
    const owner = await newOwner();
    expect(await failure(disableMember(server.ctx, owner.tenant.id, owner.user.id, null))).toMatchObject({
      statusCode: 403,
    });
    expect(await failure(disableMember(server.ctx, owner.tenant.id, randomUUID(), null))).toMatchObject({
      statusCode: 404,
    });
  });
});

describe('sessions and keys', () => {
  it('an expired API key is refused', async () => {
    const owner = await newOwner();
    const past = new Date(Date.now() - 1000);
    const expired = await server.ctx.auth.createApiKey(
      owner.tenant.id,
      owner.user.id,
      'old',
      [],
      undefined,
      past,
    );
    expect(expired.expiresAt).toBe(past.toISOString());
    expect(await server.ctx.auth.authenticateApiKey(expired.key)).toBeUndefined();
    const res = await server.app.inject({ url: '/api/v1/workflows', headers: { 'x-api-key': expired.key } });
    expect(res.statusCode).toBe(401);
    const future = new Date(Date.now() + 3_600_000);
    const fresh = await server.ctx.auth.createApiKey(
      owner.tenant.id,
      owner.user.id,
      'new',
      [],
      undefined,
      future,
    );
    expect(await server.ctx.auth.authenticateApiKey(fresh.key)).toBeDefined();
  });

  it('a SAML session gets 403 sso_session_fenced on a global account change; a password session passes', async () => {
    const owner = await newOwner();
    const saml = await sessionFor(server, owner.tenant.id, owner.user.id, { authMethod: 'saml' });
    expect(saml.auth).toMatchObject({ authMethod: 'saml', mfaVerified: false });
    let thrown: unknown;
    try {
      server.ctx.auth.assertGlobalAccountChange(saml.auth);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      statusCode: 403,
      code: 'sso_session_fenced',
      message: SSO_SESSION_FENCED_MESSAGE,
    });
    const password = await sessionFor(server, owner.tenant.id, owner.user.id, { mfaVerified: true });
    expect(() => server.ctx.auth.assertGlobalAccountChange(password.auth)).not.toThrow();
    // the session row carries both, and /auth/me names the method
    const me = await saml.client.data(saml.client.get('/rest/auth/me'));
    expect(me).toMatchObject({ authMethod: 'saml', ssoFenced: true, mfaEnabled: false });
  });

  it("USER_MANAGEMENT_JWT_DURATION_HOURS sets the session cookie's age", async () => {
    const signupBody = () => ({
      email: `ttl-${randomUUID().slice(0, 8)}@example.com`,
      password: 'Passw0rd!',
      name: 'TTL',
      workspaceName: `TTL ${randomUUID().slice(0, 6)}`,
    });
    const cookieOf = async (app: TestServer['app']) => {
      const res = await app.inject({
        method: 'POST',
        url: '/rest/auth/signup',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: JSON.stringify(signupBody()),
        remoteAddress: `10.94.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      });
      expect(res.statusCode).toBe(200);
      return String(res.headers['set-cookie']);
    };
    expect(server.ctx.config.sessionTtlMs).toBe(336 * 3_600_000);
    expect(await cookieOf(server.app)).toContain(`Max-Age=${336 * 3600}`);
    expect(other.ctx.config.sessionTtlMs).toBe(2 * 3_600_000);
    expect(await cookieOf(other.app)).toContain('Max-Age=7200');
  });

  it('PUBLIC_API_DISABLED gives 404 on /api/v1/*, never the SPA', async () => {
    const owner = await newOwner();
    const { key } = await server.ctx.auth.createApiKey(owner.tenant.id, owner.user.id, 'k');
    for (const url of ['/api/v1/workflows', '/api/v1/docs', '/api/v1/users']) {
      const res = await other.app.inject({ url, headers: { 'x-api-key': key, accept: 'text/html' } });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toContain('json');
    }
    const on = await server.app.inject({ url: '/api/v1/workflows', headers: { 'x-api-key': key } });
    expect(on.statusCode).toBe(200);
  });

  it('allowInsecureIdp is false by default and never read from the environment', async () => {
    expect(server.ctx.allowInsecureIdp).toBe(false);
    expect(other.ctx.allowInsecureIdp).toBe(true);
    const fromEnv = await createTestServer(
      { ALLOW_INSECURE_IDP: 'true', allowInsecureIdp: 'true' },
      { reset: false, startMain: false },
    );
    try {
      expect(fromEnv.ctx.allowInsecureIdp).toBe(false);
    } finally {
      await fromEnv.close();
    }
  });
});

describe('routes', () => {
  it('/sso/* and /scim/v2/* are not answered by the SPA', async () => {
    for (const url of ['/sso', '/sso/x', '/sso/saml', '/scim', '/scim/v2/x', '/scim/v2']) {
      const res = await server.app.inject({ url, headers: { accept: 'text/html' } });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toContain('json');
    }
    // the SPA (or its status page) still answers an editor path
    const spa = await server.app.inject({ url: '/settings/members', headers: { accept: 'text/html' } });
    expect(spa.statusCode).toBe(200);
    expect(spa.headers['content-type']).toContain('text/html');
  });

  it('the moved member and API key routes answer as before', async () => {
    const owner = await newOwner();
    const members = await owner.client.data<Array<Record<string, unknown>>>(
      owner.client.get('/rest/members'),
    );
    expect(members).toEqual([expect.objectContaining({ role: 'owner', email: expect.any(String) })]);
    const invite = await owner.client.data(
      owner.client.post('/rest/members/invite', {
        email: `inv-${randomUUID().slice(0, 8)}@example.com`,
        role: 'member',
      }),
    );
    expect(invite).toMatchObject({ token: expect.any(String), inviteUrl: expect.any(String) });
    const pending = await owner.client.data<Array<{ id: string }>>(owner.client.get('/rest/invitations'));
    expect(pending).toHaveLength(1);
    expect((await owner.client.delete(`/rest/invitations/${pending[0].id}`)).statusCode).toBe(200);
    expect(await owner.client.data(owner.client.get('/rest/invitations'))).toEqual([]);

    const created = await owner.client.data(owner.client.post('/rest/api-keys', { name: 'moved' }));
    expect(created).toMatchObject({
      id: expect.any(String),
      name: 'moved',
      key: expect.stringMatching(/^wfk_/),
    });
    const keys = await owner.client.data<Array<{ id: string; name: string }>>(
      owner.client.get('/rest/api-keys'),
    );
    expect(keys.map((k) => k.name)).toContain('moved');
    expect((await owner.client.delete(`/rest/api-keys/${created.id}`)).statusCode).toBe(200);
    const left = await owner.client.data<Array<{ id: string }>>(owner.client.get('/rest/api-keys'));
    expect(left.some((k) => k.id === created.id)).toBe(false);
  });

  it('PATCH /members/:userId goes through changeMemberRole and keeps the last owner', async () => {
    const owner = await newOwner();
    const member = await realMember(owner);
    const onRoleChange = vi.spyOn(server.ctx.apiKeys, 'onRoleChange');
    const afterAccessChange = vi.spyOn(server.ctx.privateCredentials, 'afterAccessChange');
    await owner.client.data(owner.client.patch(`/rest/members/${member.user.id}`, { role: 'admin' }));
    expect(onRoleChange).toHaveBeenCalledWith(owner.tenant.id, member.user.id, 'admin');
    expect(afterAccessChange).toHaveBeenCalledWith(owner.tenant.id, { userId: member.user.id });
    const audit = await server.ctx.repos.audit.list(owner.tenant.id, 50);
    expect(JSON.stringify(audit)).toContain('member.role_changed');

    // the only owner hears why before "own role"
    const self = await owner.client.patch(`/rest/members/${owner.user.id}`, { role: 'admin' });
    expect(self.statusCode).toBe(409);
    expect(self.body).toContain(LAST_OWNER_MESSAGE);
    expect(
      await failure(changeMemberRole(server.ctx, owner.tenant.id, owner.user.id, 'admin')),
    ).toMatchObject({ statusCode: 409, message: LAST_OWNER_MESSAGE });
    expect((await server.ctx.repos.memberships.get(owner.tenant.id, owner.user.id))?.role).toBe('owner');
  });

  it('requireAnyScope passes with one of the scopes and gives 403 with none', async () => {
    const owner = await newOwner();
    const member = await realMember(owner);
    const ownerAuth = (await sessionFor(server, owner.tenant.id, owner.user.id)).auth;
    const memberAuth = (await sessionFor(server, owner.tenant.id, member.user.id)).auth;
    const sso: Scope[] = ['saml:manage', 'oidc:manage', 'ldap:manage'];
    expect(await requireAnyScope(requestOf(ownerAuth), sso)).toBe(ownerAuth);
    expect(await requireAnyScope(requestOf(memberAuth), ['saml:manage', 'tag:create'])).toBe(memberAuth);
    expect(await failure(requireAnyScope(requestOf(memberAuth), sso))).toMatchObject({
      statusCode: 403,
      message: 'User is missing a scope required to perform this action',
    });
    expect(await failure(requireAnyScope({ auth: null } as unknown as FastifyRequest, sso))).toMatchObject({
      statusCode: 401,
    });
  });

  it('apiKeyScopesForRole for a member has no user:* scope that manages people; an owner has them', async () => {
    const owner = await newOwner();
    const forMember = apiKeyScopesForRole(await server.ctx.access.globalScopes(owner.tenant.id, 'member'));
    expect(forMember.length).toBeGreaterThan(0);
    // `user:list` only: the member role holds it (as n8n's global member), and plan item 9 filters the role's
    // scopes; whether a member's key may list users is an open question in the C0e report
    expect(forMember.filter((s) => s.startsWith('user:'))).toEqual(['user:list']);
    expect(forMember).toContain('workflow:create');
    const forOwner = apiKeyScopesForRole(await server.ctx.access.globalScopes(owner.tenant.id, 'owner'));
    expect(forOwner).toEqual(
      expect.arrayContaining(['user:list', 'user:create', 'saml:manage', 'ldap:sync']),
    );
  });

  it('settingsPatch ignores mfa and scim', async () => {
    const owner = await newOwner();
    const res = await owner.client.patch('/rest/settings', {
      timezone: 'Europe/Berlin',
      mfa: { enforced: true },
      scim: { enabled: true, onDelete: 'delete' },
    });
    expect(res.statusCode).toBe(200);
    const settings = (await server.ctx.repos.tenants.get(owner.tenant.id))?.settings as Record<
      string,
      unknown
    >;
    expect(settings.timezone).toBe('Europe/Berlin');
    expect(settings.mfa).toBeUndefined();
    expect(settings.scim).toBeUndefined();
  });
});

describe('runs', () => {
  it('a manual run stores endUserId, a sub-run inherits it, a webhook run has none', async () => {
    const owner = await newOwner();
    const child = await createWorkflow(owner.client, {
      name: 'Child',
      nodes: [
        node('Manual', 'core.manualTrigger', {}, [0, -200]),
        node('Called', 'core.executeWorkflowTrigger', {}, [0, 0]),
        setNode('Mark', 'child', 'yes'),
      ],
      connections: chain('Called', 'Mark'),
    });
    const parent = await createWorkflow(owner.client, {
      name: 'Parent',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0]),
      ],
      connections: chain('Start', 'Call'),
    });
    const { executionId } = await owner.client.data(
      owner.client.post(`/rest/workflows/${parent.id}/run`, {}),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const runOptions = async (id: string) =>
      ((await server.ctx.repos.executions.getData(owner.tenant.id, id))?.runOptions ?? {}) as Record<
        string,
        unknown
      >;
    expect((await runOptions(executionId)).endUserId).toBe(owner.user.id);
    const [sub] = await server.ctx.repos.executions.list(owner.tenant.id, {
      workflowId: child.id,
      limit: 10,
    });
    expect(sub).toMatchObject({ parentExecutionId: executionId, status: 'success' });
    expect((await runOptions(sub.id)).endUserId).toBe(owner.user.id);

    // publish (assertPublishable PASSES) and a webhook run: no end user
    const hook = await createWorkflow(owner.client, {
      name: 'Hook',
      nodes: [
        node('Webhook', 'core.webhook', { httpMethod: 'POST', path: 'p6s2-hook' }, [0, 0], {
          webhookId: 'p6s2-hook-id',
        }),
      ],
    });
    await owner.client.data(owner.client.post(`/rest/workflows/${hook.id}/activate`));
    const called = await server.app.inject({
      method: 'POST',
      url: `/webhook/${owner.tenant.slug}/p6s2-hook`,
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1}',
    });
    expect(called.statusCode).toBe(200);
    const run = await waitFor(async () => (await executionsOf(server.ctx, owner.tenant.id, hook.id))[0], {
      message: 'the webhook run',
    });
    await waitForExecution(server.ctx, owner.tenant.id, run.id);
    expect((await runOptions(run.id)).endUserId).toBeUndefined();
  });

  it('markFirstProductionFailure is true once', async () => {
    const owner = await newOwner();
    const tenants = server.ctx.repos.tenants;
    const both = await Promise.all([
      tenants.markFirstProductionFailure(owner.tenant.id),
      tenants.markFirstProductionFailure(owner.tenant.id),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect(await tenants.markFirstProductionFailure(owner.tenant.id)).toBe(false);
    const settings = (await tenants.get(owner.tenant.id))?.settings as Record<string, unknown>;
    expect(settings.firstProductionFailure).toMatchObject({ at: expect.any(String) });
  });
});

describe('PASSES: today behaves the same with every stub in place', () => {
  it('login, switch and invite', async () => {
    const owner = await newOwner();
    const member: TestMember = await memberAs(owner, 'admin');
    const other2: Owner = await newOwner();
    await server.ctx.repos.memberships.add(other2.tenant.id, member.user.id, 'member');
    const login = await member.client.post('/rest/auth/login', {
      email: member.email,
      password: 'Passw0rd!',
    });
    expect(login.statusCode).toBe(200);
    const me = await member.client.data(member.client.get('/rest/auth/me'));
    expect(me).toMatchObject({ authMethod: 'password', ssoFenced: false, mfaEnabled: false });
    const switched = await member.client.post('/rest/auth/switch-tenant', { tenantId: other2.tenant.id });
    expect(switched.statusCode).toBe(200);
    expect((await member.client.data(member.client.get('/rest/auth/me'))).tenant.id).toBe(other2.tenant.id);
    // a workspace slug picks the session's workspace when the person is a member there
    const picked = await member.client.post('/rest/auth/login', {
      email: member.email,
      password: 'Passw0rd!',
      workspace: other2.tenant.slug,
    });
    expect(picked.statusCode).toBe(200);
    // the settings answer the new feature flags
    const settings = await owner.client.data(owner.client.get('/rest/settings'));
    expect(settings.features).toMatchObject({ mail: false, mfa: true, publicApi: true });
  });

  it('a share, a credential move and a project delete with transfer', async () => {
    const owner = await newOwner();
    const team = await teamProjectOf(server, owner.tenant.id);
    const target = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/projects', { name: 'Target' }),
    );
    const leaving = await owner.client.data<{ id: string }>(
      owner.client.post('/rest/projects', { name: 'Leaving' }),
    );

    const workflow = await workflowIn(server, owner.tenant.id, team, { name: 'Shared' });
    const shared = await owner.client.put(`/rest/workflows/${workflow.id}/share`, {
      shareWithIds: [target.id],
    });
    expect(shared.statusCode).toBe(200);

    const credential = await credentialIn(server, owner.tenant.id, team, { name: 'Moved' });
    const moved = await owner.client.put(`/rest/credentials/${credential.id}/transfer`, {
      destinationProjectId: target.id,
    });
    expect(moved.statusCode).toBe(200);
    expect((await server.ctx.repos.credentials.get(owner.tenant.id, credential.id))?.projectId).toBe(
      target.id,
    );

    const inLeaving = await workflowIn(server, owner.tenant.id, leaving.id, { name: 'Carried' });
    const deleted = await owner.client.delete(`/rest/projects/${leaving.id}?transferId=${target.id}`);
    expect(deleted.statusCode).toBe(200);
    expect((await server.ctx.repos.workflows.get(owner.tenant.id, inLeaving.id))?.projectId).toBe(target.id);
  });

  it('a plain OAuth2 callback still stores its token with the JWE stub in place', async () => {
    const owner = await newOwner();
    const credential = await owner.client.data(
      owner.client.post('/rest/credentials', {
        name: 'Plain',
        type: 'testPkceOAuth2Api',
        data: {
          authUrl: 'https://auth.example.com/authorize',
          accessTokenUrl: tokenUrl,
          clientId: 'client-1',
          clientSecret: 'client-secret',
        },
      }),
    );
    const { url } = await owner.client.data(
      owner.client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`),
    );
    const state = new URL(url).searchParams.get('state')!;
    const callback = await server.app.inject({
      url: `/rest/oauth2/callback?code=plain&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain('"status":"success"');
    const row = await server.ctx.repos.credentials.get(owner.tenant.id, credential.id);
    expect(server.ctx.credentials.decrypt(row!).oauthTokenData).toMatchObject({
      access_token: 'access-for-plain',
    });
  });
});
