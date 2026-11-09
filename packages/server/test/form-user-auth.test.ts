/** P4-16: a form only signed-in workspace members open: sign-in, code, cookie, token, later pages. */
import type { DataObject, WebhookRequest, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactUrl } from '../src/logger';
import { FormAuthService } from '../src/services/form-auth';
import { normalizePath } from '../src/services/webhook-paths';
import type { WebhookReply } from '../src/services/webhooks';
import {
  chain,
  createTestServer,
  createWorkflow,
  executionsOf,
  flushRedis,
  memberAs,
  node,
  outputOf,
  resetDatabase,
  signup,
  TEST_REDIS,
  TestClient,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ REDIS_URL: TEST_REDIS });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  await flushRedis();
});

let signups = 0;
const owner = () =>
  signup(server.app, { remoteAddress: `10.7.${Math.floor(++signups / 200)}.${signups % 200}` });

async function member(
  admin: Awaited<ReturnType<typeof owner>>,
  role: 'admin' | 'editor' | 'viewer',
  name = 'Vera Lynn Vance',
) {
  const { client, user, email } = await memberAs(admin, role, { name });
  return { client, id: user.id, email };
}

const form = (parameters: DataObject = {}, path = 'who') =>
  node('Start', 'core.formTrigger', {
    formTitle: 'Who',
    path,
    authentication: 'n8nUserAuth',
    formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] },
    ...parameters,
  });

const secondPage = () =>
  node(
    'Second',
    'core.form',
    { operation: 'page', formFields: { values: [{ fieldLabel: 'City', fieldType: 'text' }] } },
    [200, 0],
  );

async function active(client: TestClient, nodes: WorkflowNode[], connections?: unknown) {
  const wf = await createWorkflow(client, { nodes, connections });
  await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
  return wf;
}

interface Hit {
  method?: 'GET' | 'POST';
  headers?: WebhookRequest['headers'];
  body?: DataObject;
  secure?: boolean;
}

/**
 * The service behind /form and /form-waiting, with the `url` the route passes on. The tests through
 * the routes themselves are in the last group.
 */
function requestOf(url: string, hit: Hit) {
  const [pathname, search = ''] = url.split('?');
  const method = hit.method ?? 'GET';
  const headers = hit.headers ?? {};
  const request = {
    method,
    url,
    secure: hit.secure,
    headers,
    query: Object.fromEntries(new URLSearchParams(search)),
    params: {},
    body: hit.body ?? {},
  };
  return { pathname, method, headers, read: async () => request };
}

function hitForm(url: string, hit: Hit = {}): Promise<WebhookReply> {
  const { pathname, ...incoming } = requestOf(url, hit);
  const [, , slug, ...rest] = pathname.split('/');
  return server.ctx.webhooks.handleProduction(
    slug,
    { ...incoming, path: normalizePath(rest.join('/')) },
    'form',
  );
}

function hitPage(url: string, hit: Hit = {}): Promise<WebhookReply> {
  const { pathname, ...incoming } = requestOf(url, hit);
  const [, , executionId, ...rest] = pathname.split('/');
  return server.ctx.webhooks.handleWaiting(
    executionId,
    { ...incoming, path: normalizePath(rest.join('/')) },
    'form',
  );
}

const issueCode = async (client: TestClient, returnTo: string) =>
  (await client.data(client.post('/rest/form-auth/code', { returnTo }))).code as string;

const cookieOf = (reply: WebhookReply) => String(reply.headers['set-cookie'] ?? '');
const cookiePair = (reply: WebhookReply) => cookieOf(reply).split(';')[0];
const tokenOf = (reply: WebhookReply) => cookiePair(reply).split('=')[1];

/** sign-in's whole way back: the code, the swap, the cookie */
async function signedInCookie(client: TestClient, url: string) {
  const code = await issueCode(client, url);
  const separator = url.includes('?') ? '&' : '?';
  const swap = url.startsWith('/form-waiting/')
    ? await hitPage(`${url}${separator}code=${code}`)
    : await hitForm(`${url}${separator}code=${code}`);
  expect(swap.statusCode).toBe(302);
  return { swap, cookie: cookiePair(swap), token: tokenOf(swap) };
}

const stateOf = async (tenantId: string, id: string) =>
  (await server.ctx.repos.executions.getData(tenantId, id))?.state;

/** the state of a run once it has finished */
const finished = async (tenantId: string, id: string) => {
  await waitForExecution(server.ctx, tenantId, id);
  return stateOf(tenantId, id);
};

describe('POST /rest/form-auth/code', () => {
  it('needs a session', async () => {
    const { tenant } = await owner();
    const res = await new TestClient(server.app).post('/rest/form-auth/code', {
      returnTo: `/form/${tenant.slug}/who`,
    });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    '/form/../rest/me',
    '/form/acme/../../rest/me',
    '/form/acme/%2e%2e/rest',
    '/form/acme\\..\\x',
    '/form/acme/a b',
    '/form/acme/\u0007',
  ])('refuses returnTo %s', async (returnTo) => {
    const { client } = await owner();
    const res = await client.post('/rest/form-auth/code', { returnTo });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a form of a workspace the user isn't in", async () => {
    const first = await owner();
    const second = await owner();
    const res = await first.client.post('/rest/form-auth/code', {
      returnTo: `/form/${second.tenant.slug}/who`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses an unknown workspace and an unknown execution the same way', async () => {
    const { client } = await owner();
    for (const returnTo of [
      '/form/no-such-workspace/who',
      '/form-waiting/00000000-0000-4000-8000-000000000000/sig',
    ]) {
      expect((await client.post('/rest/form-auth/code', { returnTo })).statusCode).toBe(403);
    }
  });

  it("a form opens from another of the user's workspaces: the code goes by the form, not the session", async () => {
    const first = await owner();
    const second = await owner();
    const email = `both-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const { client: both, user } = await memberAs(first, 'viewer', { email, name: 'Both' });
    await server.ctx.repos.memberships.add(second.tenant.id, user.id, 'viewer');
    await server.ctx.repos.projects.ensurePersonal(second.tenant.id, user);
    await active(second.client, [form()]);
    const url = `/form/${second.tenant.slug}/who`;
    const { cookie } = await signedInCookie(both, url);
    expect((await hitForm(url, { headers: { cookie } })).statusCode).toBe(200);
  });
});

describe('the one-time code', () => {
  it('is kept 60 seconds in Redis, under a hash', async () => {
    const { client, tenant } = await owner();
    const code = await issueCode(client, `/form/${tenant.slug}/who`);
    const redis = server.ctx.redis!;
    const keys = await redis.keys('*form-auth:code:*');
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(code);
    const left = await redis.pttl(keys[0]);
    expect(left).toBeGreaterThan(50_000);
    expect(left).toBeLessThanOrEqual(60_000);
    expect(await redis.get(keys[0])).not.toContain(code);
  });

  it('works once', async () => {
    const { client, tenant } = await owner();
    await active(client, [form()]);
    const url = `/form/${tenant.slug}/who`;
    const code = await issueCode(client, url);
    const first = await hitForm(`${url}?code=${code}`);
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe(url);
    expect(cookieOf(first)).toContain('ncb-form-auth-wf-');

    const reused = await hitForm(`${url}?code=${code}`);
    expect(reused.statusCode).toBe(302);
    expect(reused.headers.location).toContain('/form-auth');
    expect(reused.headers['set-cookie']).toBeUndefined();
  });

  it('two swaps at once: only one wins', async () => {
    const { client, tenant } = await owner();
    await active(client, [form()]);
    const url = `/form/${tenant.slug}/who`;
    const code = await issueCode(client, url);
    const replies = await Promise.all([hitForm(`${url}?code=${code}`), hitForm(`${url}?code=${code}`)]);
    expect(replies.filter((reply) => reply.headers['set-cookie'])).toHaveLength(1);
  });

  it('does not open another form of the workspace', async () => {
    const { client, tenant } = await owner();
    await active(client, [form({}, 'who')]);
    await active(client, [form({}, 'other')]);
    const code = await issueCode(client, `/form/${tenant.slug}/other`);
    const reply = await hitForm(`/form/${tenant.slug}/who?code=${code}`);
    expect(reply.headers['set-cookie']).toBeUndefined();
    expect(reply.headers.location).toContain('/form-auth');
  });

  it('without Redis: lives in memory, once, for 60 seconds', async () => {
    const { client, tenant } = await owner();
    await active(client, [form()]);
    const { user } = await client.data(client.get('/rest/auth/me'));
    const userId = (user as { id: string }).id;
    const formAuth = new FormAuthService({
      ...server.ctx.formAuth.deps,
      context: () => ({ ...server.ctx, redis: undefined }),
    });
    const returnTo = `/form/${tenant.slug}/who`;
    const once = await formAuth.issueCode(userId, returnTo);
    expect(await formAuth.exchangeCode(once)).toBeTruthy();
    expect(await formAuth.exchangeCode(once)).toBeNull();

    const late = await formAuth.issueCode(userId, returnTo);
    const issuedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(issuedAt + 60_001);
    try {
      expect(await formAuth.exchangeCode(late)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['', 'short', 'x'.repeat(5000), 'not a code!'])(
    'refuses %j without asking the store',
    async (code) => {
      const spy = vi.spyOn(server.ctx.redis!, 'multi');
      expect(await server.ctx.formAuth.exchangeCode(code)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    },
  );
});

describe('the token', () => {
  it('lives 60 minutes and holds no secret in clear', async () => {
    const { client, tenant } = await owner();
    await active(client, [form()]);
    const { token, swap } = await signedInCookie(client, `/form/${tenant.slug}/who`);
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    const left = payload.exp - Date.now() / 1000;
    expect(left).toBeGreaterThan(3500);
    expect(left).toBeLessThanOrEqual(3600);
    expect(cookieOf(swap)).toContain('Max-Age=3600');
    expect(Object.keys(payload).sort()).toEqual(['exp', 'kind', 'tenantId', 'userId', 'workflowId']);
  });

  it('verifyToken gives the four fields of the user', async () => {
    const { client, tenant } = await owner();
    const viewer = await member({ client, tenant } as never, 'viewer');
    const granted = await server.ctx.formAuth.exchangeCode(
      await issueCode(viewer.client, `/form/${tenant.slug}/who`),
    );
    expect(await server.ctx.formAuth.verifyToken(granted as string)).toEqual({
      id: viewer.id,
      email: viewer.email,
      firstName: 'Vera',
      lastName: 'Lynn Vance',
    });
  });

  it('a removed member loses the form at once', async () => {
    const admin = await owner();
    await active(admin.client, [form()]);
    const viewer = await member(admin, 'viewer');
    const url = `/form/${admin.tenant.slug}/who`;
    const { cookie } = await signedInCookie(viewer.client, url);
    expect((await hitForm(url, { headers: { cookie } })).statusCode).toBe(200);
    await admin.client.data(admin.client.delete(`/rest/members/${viewer.id}`));
    const after = await hitForm(url, { headers: { cookie } });
    expect(after.statusCode).toBe(302);
    expect(after.headers.location).toContain('/form-auth');
  });

  it('a Basic auth token is not a user token', async () => {
    const token = server.ctx.formTokens.sign({ kind: 'form-basic', userId: 'x', tenantId: 'y' }, 3600);
    expect(await server.ctx.formAuth.verifyToken(token)).toBeNull();
  });

  it('a forged token is refused', async () => {
    expect(await server.ctx.formAuth.verifyToken('abc.def')).toBeNull();
  });
});

describe('the Form Trigger with User Auth', () => {
  it('a signed-out visitor goes to sign-in, and after it the run output holds the user', async () => {
    const admin = await owner();
    const wf = await active(admin.client, [form()]);
    const url = `/form/${admin.tenant.slug}/who`;

    const signedOut = await hitForm(`${url}?ref=mail`);
    expect(signedOut.statusCode).toBe(302);
    expect(signedOut.headers.location).toBe(`/form-auth?redirect=${encodeURIComponent(`${url}?ref=mail`)}`);
    expect(signedOut.headers['set-cookie']).toBeUndefined();

    const viewer = await member(admin, 'viewer');
    const code = await issueCode(viewer.client, `${url}?ref=mail`);
    const swap = await hitForm(`${url}?ref=mail&code=${code}`, { secure: true });
    expect(swap.statusCode).toBe(302);
    expect(swap.headers.location).toBe(`${url}?ref=mail`);
    expect(swap.headers.location).not.toContain('code');
    const cookie = cookieOf(swap);
    expect(cookie).toMatch(new RegExp(`^ncb-form-auth-wf-${wf.id}=[^;]+; `));
    for (const part of ['HttpOnly', 'SameSite=Lax', 'Secure', `Path=${url}`]) expect(cookie).toContain(part);

    const opened = await hitForm(`${url}?ref=mail`, { headers: { cookie: cookiePair(swap) } });
    expect(opened.statusCode).toBe(200);
    const fresh = tokenOf(opened);
    expect(String(opened.body)).toContain(`"authToken":"${fresh}"`);

    const posted = await hitForm(`${url}?ref=mail`, {
      method: 'POST',
      headers: { 'x-auth-token': fresh },
      body: { 'field-0': 'Ann' },
    });
    expect(posted.statusCode).toBe(200);
    const [execution] = await waitFor(async () => {
      const rows = await executionsOf(server.ctx, admin.tenant.id, wf.id);
      return rows.length ? rows : undefined;
    });
    const [output] = outputOf(await finished(admin.tenant.id, execution.id), 'Start');
    expect(output.user).toEqual({
      id: viewer.id,
      email: viewer.email,
      firstName: 'Vera',
      lastName: 'Lynn Vance',
    });
    expect(output.Name).toBe('Ann');
    expect(output.formQueryParameters).toEqual({ ref: 'mail' });
  });

  it('Include User in Output off drops the user', async () => {
    const admin = await owner();
    const wf = await active(admin.client, [form({ options: { includeUserInOutput: false } })]);
    const url = `/form/${admin.tenant.slug}/who`;
    const { token } = await signedInCookie(admin.client, url);
    await hitForm(url, { method: 'POST', headers: { 'x-auth-token': token }, body: { 'field-0': 'Ann' } });
    const [execution] = await waitFor(async () => {
      const rows = await executionsOf(server.ctx, admin.tenant.id, wf.id);
      return rows.length ? rows : undefined;
    });
    const state = await finished(admin.tenant.id, execution.id);
    expect(outputOf(state, 'Start')[0]).not.toHaveProperty('user');
  });

  it('the run data has no code, no token and no x-auth-token', async () => {
    const admin = await owner();
    const wf = await active(admin.client, [form({ options: { showHeaders: true } })]);
    const url = `/form/${admin.tenant.slug}/who`;
    const { token } = await signedInCookie(admin.client, url);
    await hitForm(`${url}?code=the-spent-code&ref=mail`, {
      method: 'POST',
      headers: { 'x-auth-token': token, cookie: `ncb-form-auth-wf-${wf.id}=${token}` },
      body: { 'field-0': 'Ann' },
    });
    const [execution] = await waitFor(async () => {
      const rows = await executionsOf(server.ctx, admin.tenant.id, wf.id);
      return rows.length ? rows : undefined;
    });
    await waitForExecution(server.ctx, admin.tenant.id, execution.id);
    const state = JSON.stringify(await stateOf(admin.tenant.id, execution.id));
    expect(state).not.toContain('the-spent-code');
    expect(state).not.toContain(token);
    expect(state).not.toContain('x-auth-token');
    expect(state).not.toContain('"code"');
  });

  it('a POST without a token starts no run', async () => {
    const admin = await owner();
    const wf = await active(admin.client, [form()]);
    const reply = await hitForm(`/form/${admin.tenant.slug}/who`, {
      method: 'POST',
      body: { 'field-0': 'Ann' },
    });
    expect(reply.statusCode).toBe(401);
    expect(await executionsOf(server.ctx, admin.tenant.id, wf.id)).toHaveLength(0);
  });

  it("a token of another workspace's form does not open this one", async () => {
    const first = await owner();
    const second = await owner();
    await active(first.client, [form()]);
    await active(second.client, [form()]);
    const { token } = await signedInCookie(first.client, `/form/${first.tenant.slug}/who`);
    const reply = await hitForm(`/form/${second.tenant.slug}/who`, { headers: { 'x-auth-token': token } });
    expect(reply.statusCode).toBe(302);
  });
});

describe('Require Workflow Execute Permission', () => {
  it('off by default: a viewer gets in', async () => {
    const admin = await owner();
    await active(admin.client, [form()]);
    const viewer = await member(admin, 'viewer');
    const url = `/form/${admin.tenant.slug}/who`;
    const { cookie } = await signedInCookie(viewer.client, url);
    expect((await hitForm(url, { headers: { cookie } })).statusCode).toBe(200);
  });

  it('on: a viewer is refused, an editor gets in', async () => {
    const admin = await owner();
    await active(admin.client, [form({ requireExecuteAccess: true })]);
    const url = `/form/${admin.tenant.slug}/who`;

    const viewer = await member(admin, 'viewer');
    const code = await issueCode(viewer.client, url);
    const refused = await hitForm(`${url}?code=${code}`);
    expect(refused.statusCode).toBe(403);
    expect(refused.headers['set-cookie']).toBeUndefined();

    const editor = await member(admin, 'editor');
    const { cookie } = await signedInCookie(editor.client, url);
    expect((await hitForm(url, { headers: { cookie } })).statusCode).toBe(200);
  });

  it("canExecute goes by the role in the workflow's workspace", async () => {
    const first = await owner();
    const second = await owner();
    const wf = await active(first.client, [form()]);
    const viewer = await member(first, 'viewer');
    const { formAuth } = server.ctx;
    const firstMe = await first.client.data(first.client.get('/rest/auth/me'));
    expect(await formAuth.canExecute((firstMe.user as { id: string }).id, wf.id as string)).toBe(true);
    expect(await formAuth.canExecute(viewer.id, wf.id as string)).toBe(false);
    const secondMe = await second.client.data(second.client.get('/rest/auth/me'));
    expect(await formAuth.canExecute((secondMe.user as { id: string }).id, wf.id as string)).toBe(false);
    expect(await formAuth.canExecute(viewer.id, 'not-a-uuid')).toBe(false);
  });
});

describe('a later page', () => {
  async function waitingPage() {
    const admin = await owner();
    const wf = await active(admin.client, [form(), secondPage()], chain('Start', 'Second'));
    const url = `/form/${admin.tenant.slug}/who`;
    const { token } = await signedInCookie(admin.client, url);
    const posted = await hitForm(url, {
      method: 'POST',
      headers: { 'x-auth-token': token },
      body: { 'field-0': 'Ann' },
    });
    expect(posted.statusCode).toBe(200);
    const pageUrl = new URL((posted.body as { formWaitingUrl: string }).formWaitingUrl).pathname;
    await waitFor(async () => {
      const status = await hitPage(`${pageUrl}/n8n-execution-status`);
      return status.body === 'form-waiting' ? status : undefined;
    });
    const [execution] = await executionsOf(server.ctx, admin.tenant.id, wf.id);
    return { admin, wf, pageUrl, execution, triggerToken: token };
  }

  it('asks for sign-in, then opens with the cookie alone and the run gets both answers', async () => {
    const { admin, pageUrl, execution } = await waitingPage();

    const signedOut = await hitPage(pageUrl);
    expect(signedOut.statusCode).toBe(302);
    expect(signedOut.headers.location).toBe(`/form-auth?redirect=${encodeURIComponent(pageUrl)}`);

    const { swap, cookie } = await signedInCookie(admin.client, pageUrl);
    expect(swap.headers.location).toBe(pageUrl);
    expect(cookieOf(swap)).toMatch(new RegExp(`^ncb-form-auth-ex-${execution.id}=`));
    expect(cookieOf(swap)).toContain(`Path=/form-waiting/${execution.id};`);

    const opened = await hitPage(pageUrl, { headers: { cookie } });
    expect(opened.statusCode).toBe(200);
    expect(String(opened.body)).toContain('City');
    const pageToken = tokenOf(opened);

    const answered = await hitPage(pageUrl, {
      method: 'POST',
      headers: { 'x-auth-token': pageToken },
      body: { 'field-0': 'Oslo' },
    });
    expect(answered.statusCode).toBe(200);
    const state = await finished(admin.tenant.id, execution.id);
    const me = await admin.client.data(admin.client.get('/rest/auth/me'));
    const userId = (me.user as { id: string }).id;
    expect(outputOf(state, 'Start')[0].user).toMatchObject({ id: userId });
    const [second] = outputOf(state, 'Second');
    expect(second.City).toBe('Oslo');
    expect(second.user).toMatchObject({ id: userId });
    expect(JSON.stringify(await stateOf(admin.tenant.id, execution.id))).not.toContain(pageToken);
  });

  it("the trigger's token does not open a later page", async () => {
    const { pageUrl, triggerToken } = await waitingPage();
    const reply = await hitPage(pageUrl, { headers: { 'x-auth-token': triggerToken } });
    expect(reply.statusCode).toBe(302);
  });

  it('a POST without a token does not move the run', async () => {
    const { admin, pageUrl, execution } = await waitingPage();
    const reply = await hitPage(pageUrl, { method: 'POST', body: { 'field-0': 'Oslo' } });
    expect(reply.statusCode).toBe(401);
    const row = await server.ctx.repos.executions.get(admin.tenant.id, execution.id);
    expect(row?.status).toBe('waiting');
  });

  it("a user outside the page's workspace gets no code for it", async () => {
    const { pageUrl } = await waitingPage();
    const stranger = await owner();
    const res = await stranger.client.post('/rest/form-auth/code', { returnTo: pageUrl });
    expect(res.statusCode).toBe(403);
  });
});

describe('test forms', () => {
  it('sign-in works on /form-test and keeps the registration', async () => {
    const admin = await owner();
    const wf = await createWorkflow(admin.client, { nodes: [form()] });
    await admin.client.data(
      admin.client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Start' }),
    );
    const url = `/form-test/${admin.tenant.slug}/who`;
    const hit = (target: string, extra: Hit = {}) => {
      const { pathname, ...incoming } = requestOf(target, extra);
      return server.ctx.webhooks.handleTest(
        admin.tenant.slug,
        { ...incoming, path: normalizePath(pathname.split('/').slice(3).join('/')) },
        'form',
      );
    };
    const signedOut = await hit(url);
    expect(signedOut.statusCode).toBe(302);
    const code = await issueCode(admin.client, url);
    const swap = await hit(`${url}?code=${code}`);
    expect(swap.headers.location).toBe(url);
    expect(cookieOf(swap)).toMatch(new RegExp(`^ncb-form-auth-wf-${wf.id}=`));
    expect((await hit(url, { headers: { cookie: cookiePair(swap) } })).statusCode).toBe(200);
  });
});

/**
 * Through the real routes. Two lines of routes/webhooks.ts have to be in for these (see the L2
 * report): `send()` lets the form-auth cookie through, `toWebhookRequest` passes `url`.
 */
describe('through the routes', () => {
  it('a signed-out GET of /form is sent to sign-in', async () => {
    const admin = await owner();
    await active(admin.client, [form()]);
    const url = `/form/${admin.tenant.slug}/who?ref=mail`;
    const res = await server.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/form-auth?redirect=${encodeURIComponent(url)}`);
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('the swap sets the one form cookie in the reply, no other cookie gets through', async () => {
    const admin = await owner();
    const wf = await active(admin.client, [form()]);
    const url = `/form/${admin.tenant.slug}/who`;
    const code = await issueCode(admin.client, url);
    const swap = await server.app.inject({ method: 'GET', url: `${url}?code=${code}` });
    expect(swap.statusCode).toBe(302);
    expect(swap.headers.location).toBe(url);
    const cookie = String(swap.headers['set-cookie']);
    expect(cookie).toMatch(new RegExp(`^ncb-form-auth-wf-${wf.id}=`));
    for (const part of ['HttpOnly', 'SameSite=Lax', `Path=${url}`]) expect(cookie).toContain(part);

    const opened = await server.app.inject({
      method: 'GET',
      url,
      headers: { cookie: cookie.split(';')[0] },
    });
    expect(opened.statusCode).toBe(200);
    expect(String(opened.headers['set-cookie'])).toMatch(new RegExp(`^ncb-form-auth-wf-${wf.id}=`));
  });

  it('the cookie follows the scheme, and a proxy header counts only when proxies are trusted', async () => {
    const admin = await owner();
    await active(admin.client, [form()]);
    const url = `/form/${admin.tenant.slug}/who`;
    const cookieFrom = async (app: TestServer['app'], proto?: string) => {
      const code = await issueCode(admin.client, url);
      const swap = await app.inject({
        method: 'GET',
        url: `${url}?code=${code}`,
        headers: proto ? { 'x-forwarded-proto': proto } : {},
      });
      expect(swap.statusCode).toBe(302);
      return String(swap.headers['set-cookie']);
    };

    // plain http with a plain-http BASE_URL: a Secure cookie would be dropped, and the visitor would loop
    expect(await cookieFrom(server.app)).not.toContain('Secure');
    // nobody trusts this caller's word
    expect(await cookieFrom(server.app, 'https')).not.toContain('Secure');

    const proxied = await createTestServer({ REDIS_URL: TEST_REDIS, TRUST_PROXY: 'true' }, { reset: false });
    try {
      expect(await cookieFrom(proxied.app, 'https')).toMatch(/; Secure$/);
      expect(await cookieFrom(proxied.app, ' https , http')).toMatch(/; Secure$/);
      expect(await cookieFrom(proxied.app, 'http, https')).not.toContain('Secure');
      expect(await cookieFrom(proxied.app)).not.toContain('Secure');
    } finally {
      await proxied.close();
    }
  });

  it('the one-time code of a form URL stays out of the request log', () => {
    const code = 'a'.repeat(43);
    expect(redactUrl(`/form/acme/who?code=${code}`)).toBe('/form/acme/who?code=[redacted]');
    expect(redactUrl(`/form-test/acme/who?ref=mail&code=${code}&x=1`)).toBe(
      '/form-test/acme/who?ref=mail&code=[redacted]&x=1',
    );
    expect(redactUrl(`/form-waiting/e1/sig?code=${code}`)).toBe('/form-waiting/[redacted]?code=[redacted]');
    expect(redactUrl(`/%66orm/acme/who?code=${code}`)).not.toContain(code);
    // the rest of the log stays as it was
    expect(redactUrl('/form/acme/who?ref=mail')).toBe('/form/acme/who?ref=mail');
    expect(redactUrl('/rest/oauth2-credential/callback?state=s')).toBe(
      '/rest/oauth2-credential/callback?state=s',
    );
  });
});
