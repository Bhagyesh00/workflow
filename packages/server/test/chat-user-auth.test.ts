/** P5-57: a Chat Trigger with Workspace sign-in: sign-in, code, cookie, token, and the walls to forms. */
import { nodesAiPackage } from '@workflow/nodes-ai';
import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestServer,
  createWorkflow,
  executionsOf,
  flushRedis,
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
  server = await createTestServer({ REDIS_URL: TEST_REDIS }, { nodePackages: [nodesAiPackage] });
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
  signup(server.app, { remoteAddress: `10.8.${Math.floor(++signups / 200)}.${signups % 200}` });

async function member(
  admin: Awaited<ReturnType<typeof owner>>,
  role: 'admin' | 'editor' | 'viewer',
  name = 'Vera Lynn Vance',
) {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const invite = await admin.client.data(admin.client.post('/rest/members/invite', { email, role }));
  const client = new TestClient(server.app);
  await client.data(client.post(`/rest/invitations/${invite.token}/accept`, { name, password: 'Passw0rd!' }));
  const me = await client.data(client.get('/rest/auth/me'));
  return { client, id: (me.user as { id: string }).id, email };
}

const chat = (parameters: DataObject = {}, webhookId = 'chat-id') =>
  node('Chat', 'ai.chatTrigger', { public: true, authentication: 'n8nUserAuth', ...parameters }, [0, 0], {
    webhookId,
  });

const form = (path: string) =>
  node(
    'Start',
    'core.formTrigger',
    {
      formTitle: 'Who',
      path,
      authentication: 'n8nUserAuth',
      formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] },
    },
    [0, 0],
  );

async function active(client: TestClient, nodes: WorkflowNode[]) {
  const wf = await createWorkflow(client, { nodes, connections: {} });
  const activated = await client.post(`/rest/workflows/${wf.id}/activate`);
  expect(activated.statusCode, activated.body).toBe(200);
  return wf;
}

const chatPath = (slug: string, webhookId = 'chat-id') => `/webhook/${slug}/${webhookId}/chat`;
const get = (url: string, headers: Record<string, string> = {}) =>
  server.app.inject({ method: 'GET', url, headers });
const post = (url: string, headers: Record<string, string> = {}, payload: DataObject = message) =>
  server.app.inject({ method: 'POST', url, headers, payload });
const message = { sessionId: 's1', chatInput: 'Hi' };

const issueCode = async (client: TestClient, returnTo: string) =>
  (await client.data(client.post('/rest/form-auth/code', { returnTo }))).code as string;

const setCookie = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '');
const cookiePair = (res: { headers: Record<string, unknown> }) => setCookie(res).split(';')[0];
const CONFIG = /<script type="application\/json" id="chat-config">([^<]*)<\/script>/;
const configOf = (html: string) => JSON.parse(CONFIG.exec(html)?.[1] ?? 'null') as DataObject;

/** sign-in's whole way back: the code, the swap on the chat's GET, the cookie */
async function signedIn(client: TestClient, url: string) {
  const code = await issueCode(client, url);
  const swap = await get(`${url}?code=${code}`);
  expect(swap.statusCode).toBe(302);
  return { swap, cookie: cookiePair(swap), code };
}

describe('POST /rest/form-auth/code for a chat', () => {
  it('gives a code for a chat path of the own workspace, production or test', async () => {
    const admin = await owner();
    for (const base of ['webhook', 'webhook-test']) {
      const code = await issueCode(admin.client, `/${base}/${admin.tenant.slug}/chat-id/chat`);
      expect(code).toMatch(/^[\w-]{43}$/);
    }
    // the path may carry the page's own query
    expect(await issueCode(admin.client, `${chatPath(admin.tenant.slug)}?ref=mail`)).toBeTruthy();
  });

  it.each([
    ['not ending in /chat', '/webhook/acme/chat-id/chat/extra'],
    ['a look-alike ending', '/webhook/acme/chat-id/notchat'],
    ['no workspace and id', '/webhook/chat'],
    ['a waiting resume URL', '/webhook-waiting/e1/chat'],
    ['the REST API', '/rest/me'],
    ['a way out of the path', '/webhook/acme/../../rest/chat'],
    ['an encoded way out', '/webhook/acme/%2e%2e/chat'],
    ['another site', 'https://evil.example/webhook/acme/x/chat'],
    ['a path with a backslash', '/webhook/acme/a\\b/chat'],
  ])('refuses %s', async (_name, returnTo) => {
    const { client } = await owner();
    expect((await client.post('/rest/form-auth/code', { returnTo })).statusCode).toBe(400);
  });

  it("refuses a chat of a workspace the user isn't in", async () => {
    const first = await owner();
    const second = await owner();
    const res = await first.client.post('/rest/form-auth/code', { returnTo: chatPath(second.tenant.slug) });
    expect(res.statusCode).toBe(403);
  });
});

describe('the Chat Trigger with Workspace sign-in', () => {
  it('sends a signed-out visitor to /form-auth, then the code swap sets the chat cookie and opens the page', async () => {
    const admin = await owner();
    const wf = await active(admin.client, [chat()]);
    const url = chatPath(admin.tenant.slug);

    const signedOut = await get(`${url}?ref=mail`);
    expect(signedOut.statusCode).toBe(302);
    expect(signedOut.headers.location).toBe(`/form-auth?redirect=${encodeURIComponent(`${url}?ref=mail`)}`);
    expect(signedOut.headers['set-cookie']).toBeUndefined();

    const viewer = await member(admin, 'viewer');
    const code = await issueCode(viewer.client, `${url}?ref=mail`);
    const swap = await get(`${url}?ref=mail&code=${code}`);
    expect(swap.statusCode).toBe(302);
    expect(swap.headers.location).toBe(`${url}?ref=mail`);
    expect(String(swap.headers.location)).not.toContain('code');

    // cookie name per workflow, path of the chat, no other cookie
    const cookie = setCookie(swap);
    expect(cookie).toMatch(new RegExp(`^ncb-chat-auth-wf-${wf.id}=[^;]+; `));
    for (const part of ['HttpOnly', 'SameSite=Lax', 'Max-Age=3600', `Path=${url}`]) {
      expect(cookie).toContain(part);
    }
    expect([swap.headers['set-cookie']].flat()).toHaveLength(1);

    const opened = await get(`${url}?ref=mail`, { cookie: cookiePair(swap) });
    expect(opened.statusCode).toBe(200);
    expect(String(opened.headers['content-security-policy'])).toMatch(/^sandbox /);
    const authToken = String(configOf(opened.body).authToken);
    expect(authToken).toBeTruthy();
    // the token is not in the cookie header of the page reply twice, nor in the URL
    expect(String(opened.headers.location ?? '')).not.toContain(authToken);
  });

  it('a POST needs the x-auth-token the page got: none is 401 JSON, with it the run holds the user', async () => {
    const admin = await owner();
    const wf = await active(admin.client, [chat()]);
    const url = chatPath(admin.tenant.slug);
    const viewer = await member(admin, 'viewer');

    const bare = await post(url);
    expect(bare.statusCode).toBe(401);
    expect(bare.headers['content-type']).toContain('application/json');
    expect(String((bare.json() as { message: string }).message)).toContain('sign-in');
    // the cookie alone is not enough: the page's fetch omits cookies, and a POST asks for the token
    const { cookie } = await signedIn(viewer.client, url);
    expect((await post(url, { cookie })).statusCode).toBe(401);
    expect(await executionsOf(server.ctx, admin.tenant.id, wf.id as string)).toHaveLength(0);

    const page = await get(url, { cookie });
    const authToken = String(configOf(page.body).authToken);
    const ok = await post(url, { 'x-auth-token': authToken }, { ...message, user: { id: 'evil' } });
    expect(ok.statusCode, ok.body).toBe(200);
    const [execution] = await waitFor(async () => {
      const rows = await executionsOf(server.ctx, admin.tenant.id, wf.id as string);
      return rows.length ? rows : undefined;
    });
    await waitForExecution(server.ctx, admin.tenant.id, execution.id);
    const state = (await server.ctx.repos.executions.getData(admin.tenant.id, execution.id))?.state;
    const [output] = outputOf(state, 'Chat');
    expect(output.user).toEqual({
      id: viewer.id,
      email: viewer.email,
      firstName: 'Vera',
      lastName: 'Lynn Vance',
    });
    expect(output.chatInput).toBe('Hi');
    // no code, token or cookie in the run data
    const text = JSON.stringify(state);
    expect(text).not.toContain(authToken);
    expect(text).not.toContain(cookie.split('=')[1]);
  });

  it('Include User in Output off drops the user', async () => {
    const admin = await owner();
    const wf = await active(admin.client, [chat({ includeUserInOutput: false })]);
    const url = chatPath(admin.tenant.slug);
    const { cookie } = await signedIn(admin.client, url);
    const authToken = String(configOf((await get(url, { cookie })).body).authToken);
    expect((await post(url, { 'x-auth-token': authToken })).statusCode).toBe(200);
    const [execution] = await waitFor(async () => {
      const rows = await executionsOf(server.ctx, admin.tenant.id, wf.id as string);
      return rows.length ? rows : undefined;
    });
    await waitForExecution(server.ctx, admin.tenant.id, execution.id);
    const state = (await server.ctx.repos.executions.getData(admin.tenant.id, execution.id))?.state;
    expect(outputOf(state, 'Chat')[0]).not.toHaveProperty('user');
  });

  it('a removed member loses the chat at once', async () => {
    const admin = await owner();
    await active(admin.client, [chat()]);
    const viewer = await member(admin, 'viewer');
    const url = chatPath(admin.tenant.slug);
    const { cookie } = await signedIn(viewer.client, url);
    const authToken = String(configOf((await get(url, { cookie })).body).authToken);
    expect((await get(url, { cookie })).statusCode).toBe(200);
    await admin.client.data(admin.client.delete(`/rest/members/${viewer.id}`));
    const page = await get(url, { cookie });
    expect(page.statusCode).toBe(302);
    expect(String(page.headers.location)).toContain('/form-auth');
    expect((await post(url, { 'x-auth-token': authToken })).statusCode).toBe(401);
  });

  it('Require Workflow Execute Permission: a viewer is refused with 403 and no cookie, an editor gets in', async () => {
    const admin = await owner();
    await active(admin.client, [chat({ requireExecuteAccess: true })]);
    const url = chatPath(admin.tenant.slug);

    const viewer = await member(admin, 'viewer');
    const code = await issueCode(viewer.client, url);
    const refused = await get(`${url}?code=${code}`);
    expect(refused.statusCode).toBe(403);
    expect(refused.headers['set-cookie']).toBeUndefined();
    expect(refused.body).toContain('have permission to open this chat');
    expect(refused.body).toContain('chat');

    const editor = await member(admin, 'editor');
    const { cookie } = await signedIn(editor.client, url);
    expect((await get(url, { cookie })).statusCode).toBe(200);
  });

  it('keeps the code and tokens out of the page for a refused visitor', async () => {
    const admin = await owner();
    await active(admin.client, [chat()]);
    const url = chatPath(admin.tenant.slug);
    const code = 'a'.repeat(43);
    const res = await get(`${url}?code=${code}`);
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).not.toContain(code);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('chat and form tokens do not mix', () => {
  it('mints a chat-user token for a chat path and a form-user token for a form path', async () => {
    const admin = await owner();
    const chatToken = (await server.ctx.formAuth.exchangeCode(
      await issueCode(admin.client, chatPath(admin.tenant.slug)),
    )) as string;
    const formToken = (await server.ctx.formAuth.exchangeCode(
      await issueCode(admin.client, `/form/${admin.tenant.slug}/who`),
    )) as string;
    expect(server.ctx.formTokens.verify(chatToken)).toMatchObject({ kind: 'chat-user' });
    expect(server.ctx.formTokens.verify(formToken)).toMatchObject({ kind: 'form-user' });
    // the helper's second check accepts both kinds; the page's own binding is the wall
    expect(await server.ctx.formAuth.verifyToken(chatToken)).not.toBeNull();
    expect(await server.ctx.formAuth.verifyToken(formToken)).not.toBeNull();
  });

  it('a code issued for a chat opens the chat, and its grant does not open a form of the same workspace', async () => {
    const admin = await owner();
    await active(admin.client, [chat()]);
    await active(admin.client, [form('who')]);
    const chatUrl = chatPath(admin.tenant.slug);
    const formUrl = `/form/${admin.tenant.slug}/who`;

    // the same code on the form: no cookie, back to sign-in
    const forChat = await issueCode(admin.client, chatUrl);
    const onForm = await get(`${formUrl}?code=${forChat}`);
    expect(onForm.headers['set-cookie']).toBeUndefined();
    expect(String(onForm.headers.location)).toContain('/form-auth');

    // a fresh code on the chat works
    const fresh = await issueCode(admin.client, chatUrl);
    const onChat = await get(`${chatUrl}?code=${fresh}`);
    expect(setCookie(onChat)).toContain('ncb-chat-auth-wf-');
  });

  it('a form code does not open a chat, and a form cookie or token does not open a chat', async () => {
    const admin = await owner();
    await active(admin.client, [chat()]);
    await active(admin.client, [form('who')]);
    const chatUrl = chatPath(admin.tenant.slug);
    const formUrl = `/form/${admin.tenant.slug}/who`;

    const forForm = await issueCode(admin.client, formUrl);
    const onChat = await get(`${chatUrl}?code=${forForm}`);
    expect(onChat.headers['set-cookie']).toBeUndefined();
    expect(String(onChat.headers.location)).toContain('/form-auth');

    // a real form cookie under the chat's cookie name, and a real form token as x-auth-token
    const formCode = await issueCode(admin.client, formUrl);
    const formSwap = await get(`${formUrl}?code=${formCode}`);
    expect(setCookie(formSwap)).toContain('ncb-form-auth-wf-');
    const formCookie = cookiePair(formSwap);
    const formToken = formCookie.split('=')[1];
    const wfId = /ncb-form-auth-wf-([^=]+)=/.exec(formCookie)?.[1];
    const asChatCookie = await get(chatUrl, { cookie: `ncb-chat-auth-wf-${wfId}=${formToken}` });
    expect(asChatCookie.statusCode).toBe(302);
    expect((await post(chatUrl, { 'x-auth-token': formToken })).statusCode).toBe(401);

    // and the reverse: a chat token does not open the form
    const { cookie } = await signedIn(admin.client, chatUrl);
    const chatToken = cookie.split('=')[1];
    const formPage = await get(formUrl, { cookie: `ncb-form-auth-wf-${wfId}=${chatToken}` });
    expect(formPage.statusCode).toBe(302);
    expect(String(formPage.headers.location)).toContain('/form-auth');
  });

  it('a code for another chat path is refused', async () => {
    const admin = await owner();
    await active(admin.client, [chat({}, 'one')]);
    await active(admin.client, [chat({}, 'two')]);
    const code = await issueCode(admin.client, chatPath(admin.tenant.slug, 'one'));
    const res = await get(`${chatPath(admin.tenant.slug, 'two')}?code=${code}`);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(String(res.headers.location)).toContain('/form-auth');
  });

  it("a user outside the chat's workspace gets no code for it", async () => {
    const first = await owner();
    const second = await owner();
    await active(first.client, [chat()]);
    const res = await second.client.post('/rest/form-auth/code', { returnTo: chatPath(first.tenant.slug) });
    expect(res.statusCode).toBe(403);
  });
});

describe('a test chat', () => {
  it('sign-in works on /webhook-test too', async () => {
    const admin = await owner();
    await active(admin.client, [chat()]);
    const code = await issueCode(admin.client, `/webhook-test/${admin.tenant.slug}/chat-id/chat`);
    expect(code).toBeTruthy();
  });
});
