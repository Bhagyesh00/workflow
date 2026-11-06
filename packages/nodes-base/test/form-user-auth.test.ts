/** P4-16: the form's User Auth through a real webhook context, with the host's helper faked. */
import { createWebhookContext, type ExecutionServices } from '@workflow/core';
import {
  type DataObject,
  ExpressionEvaluator,
  type FormAuthHelper,
  type WebhookRequest,
  type WebhookResponseData,
  Workflow,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { checkFormUserAuth, userAuthProperties } from '../src/nodes/core/form/user-auth';
import { node, nodeTypes, testServices } from './harness';

const USER = { id: 'u1', email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee' };
const FORM_URL = '/form/acme/who';
const HOUR = 60 * 60;

function fakeTokens() {
  let issued = 0;
  const tokens = new Map<string, { payload: DataObject; ttl: number; expires: number }>();
  return {
    tokens,
    sign(payload: DataObject, ttlSeconds: number) {
      const token = `tok-${++issued}`;
      tokens.set(token, { payload, ttl: ttlSeconds, expires: Date.now() + ttlSeconds * 1000 });
      return token;
    },
    verify(token: string) {
      const found = tokens.get(token);
      return found && found.expires > Date.now() ? found.payload : null;
    },
  };
}

let formTokens: ReturnType<typeof fakeTokens>;
let canExecute: Mock<FormAuthHelper['canExecute']>;
let formAuth: FormAuthHelper;
/** one-time codes the fake host holds: code to the path it was issued for */
let codes: Map<string, string>;

beforeEach(() => {
  formTokens = fakeTokens();
  canExecute = vi.fn<FormAuthHelper['canExecute']>(async () => true);
  codes = new Map([['good-code', FORM_URL]]);
  formAuth = {
    signInUrl: (returnTo) => `/sign-in?to=${encodeURIComponent(returnTo)}`,
    exchangeCode: async (code) => {
      const path = codes.get(code);
      if (!path) return null;
      codes.delete(code);
      return formTokens.sign({ kind: 'form-user', userId: USER.id, tenantId: 't1', path }, HOUR);
    },
    verifyToken: async (token) => (formTokens.verify(token)?.userId === USER.id ? USER : null),
    canExecute,
  };
});

interface CallOptions {
  method?: 'GET' | 'POST';
  url?: string;
  query?: DataObject;
  headers?: WebhookRequest['headers'];
  parameters?: DataObject;
  services?: Partial<ExecutionServices>;
}

function contextOf(options: CallOptions) {
  const method = options.method ?? 'GET';
  const workflow = new Workflow(
    {
      id: 'wf-1',
      name: 'forms',
      nodes: [
        node('Form', 'core.formTrigger', {
          formTitle: 'Who',
          authentication: 'n8nUserAuth',
          formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] },
          ...options.parameters,
        }),
      ],
      connections: {},
      settings: {},
    },
    nodeTypes,
  );
  const request: WebhookRequest & { url?: string } = {
    method,
    url: options.url ?? FORM_URL,
    headers: options.headers ?? {},
    query: options.query ?? {},
    params: {},
    body: method === 'POST' ? { 'field-0': 'Ann' } : {},
  };
  return {
    workflow,
    ctx: createWebhookContext(
      {
        workflow,
        node: workflow.nodes.Form,
        services: testServices(
          {},
          { tenantId: 't1', mode: 'webhook', formTokens, formAuth, ...options.services },
        ),
        evaluator: new ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      request,
      method === 'GET' ? 'setup' : 'default',
    ),
  };
}

async function call(options: CallOptions = {}): Promise<WebhookResponseData> {
  return nodeTypes.get('core.formTrigger')!.webhook!(contextOf(options).ctx);
}

const check = (
  options: CallOptions = {},
  params: Parameters<typeof checkFormUserAuth>[1] = { scope: 'trigger', requireExecuteAccess: false },
) => checkFormUserAuth(contextOf(options).ctx, params);

const trigger = { tenantId: 't1', workflowId: 'wf-1' };
const tokenFor = (extra: DataObject = {}) =>
  formTokens.sign({ kind: 'form-user', userId: USER.id, ...trigger, ...extra }, HOUR);

const cookieHeader = (token: string) => ({ cookie: `other=1; ncb-form-auth-wf-wf-1=${token}` });

describe('the properties', () => {
  it('offers one trusted source and the execute permission, off by default', () => {
    const source = userAuthProperties.find((p) => p.name === 'trustedSource');
    expect(source?.options).toHaveLength(1);
    expect(source?.options?.[0]).toMatchObject({ name: 'Workspace sign-in' });
    expect(source?.displayOptions).toEqual({ show: { authentication: ['n8nUserAuth'] } });
    const access = userAuthProperties.find((p) => p.name === 'requireExecuteAccess');
    expect(access).toMatchObject({ displayName: 'Require Workflow Execute Permission', default: false });
    expect(access?.displayOptions).toEqual({ show: { authentication: ['n8nUserAuth'] } });
  });
});

describe('a visitor with no token', () => {
  it('goes to sign-in and comes back to this form with its query', async () => {
    const result = await call({ url: `${FORM_URL}?ref=mail`, query: { ref: 'mail' } });
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(302);
    expect(result.webhookResponse?.headers?.location).toBe(
      `/sign-in?to=${encodeURIComponent(`${FORM_URL}?ref=mail`)}`,
    );
    expect(result.webhookResponse?.headers).not.toHaveProperty('set-cookie');
  });

  it('a used or unknown code goes to sign-in, the return URL does not hold the code', async () => {
    const result = await call({
      url: `${FORM_URL}?code=spent&ref=mail`,
      query: { code: 'spent', ref: 'mail' },
    });
    expect(result.webhookResponse?.statusCode).toBe(302);
    const location = String(result.webhookResponse?.headers?.location);
    expect(decodeURIComponent(location)).toContain(`${FORM_URL}?ref=mail`);
    expect(decodeURIComponent(location)).not.toContain('spent');
    expect(result.webhookResponse?.headers).not.toHaveProperty('set-cookie');
  });

  it('a POST without a token is refused and starts nothing, a page cannot follow a redirect', async () => {
    const result = await call({ method: 'POST' });
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(401);
    expect(result.webhookResponse?.headers).not.toHaveProperty('location');
  });

  it('refuses when the host has no form sign-in', async () => {
    const result = await call({ services: { formAuth: undefined } });
    expect(result.webhookResponse?.statusCode).toBe(403);
  });

  it('refuses when the address of the form is not known', async () => {
    const { workflow } = contextOf({});
    const ctx = createWebhookContext(
      {
        workflow,
        node: workflow.nodes.Form,
        services: testServices({}, { tenantId: 't1', mode: 'webhook', formTokens, formAuth }),
        evaluator: new ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      { method: 'GET', headers: {}, query: {}, params: {}, body: {} },
      'setup',
    );
    const result = await checkFormUserAuth(ctx, { scope: 'trigger', requireExecuteAccess: false });
    expect(result.allowed).toBe(false);
    expect(result.response?.statusCode).toBe(403);
  });
});

describe('the code from sign-in', () => {
  it('is swapped once for a cookie and a redirect to the URL without the code', async () => {
    const result = await call({
      url: `${FORM_URL}?code=good-code&ref=mail`,
      query: { code: 'good-code', ref: 'mail' },
    });
    expect(result.webhookResponse?.statusCode).toBe(302);
    expect(result.webhookResponse?.headers?.location).toBe(`${FORM_URL}?ref=mail`);
    const cookie = String(result.webhookResponse?.headers?.['set-cookie']);
    expect(cookie).toMatch(/^ncb-form-auth-wf-wf-1=[^;]+; /);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain(`Path=${FORM_URL}`);
    expect(cookie).toContain(`Max-Age=${HOUR}`);

    const again = await call({ url: `${FORM_URL}?code=good-code`, query: { code: 'good-code' } });
    expect(again.webhookResponse?.headers).not.toHaveProperty('set-cookie');
    expect(again.webhookResponse?.headers?.location).toContain('/sign-in');
  });

  it("the cookie's token holds the user, tenant and workflow, for 60 minutes", async () => {
    const result = await call({ url: `${FORM_URL}?code=good-code`, query: { code: 'good-code' } });
    const token = /=([^;]+);/.exec(String(result.webhookResponse?.headers?.['set-cookie']))?.[1] as string;
    const stored = formTokens.tokens.get(token);
    expect(stored?.ttl).toBe(HOUR);
    expect(stored?.payload).toMatchObject({
      kind: 'form-user',
      userId: 'u1',
      tenantId: 't1',
      workflowId: 'wf-1',
    });
  });

  it('a code issued for another form does not open this one', async () => {
    codes.set('other-form', '/form/acme/other');
    const result = await call({ url: `${FORM_URL}?code=other-form`, query: { code: 'other-form' } });
    expect(result.webhookResponse?.headers).not.toHaveProperty('set-cookie');
    expect(result.webhookResponse?.headers?.location).toContain('/sign-in');
  });

  it("a code from another workspace's sign-in does not open this form", async () => {
    formAuth.exchangeCode = async () =>
      formTokens.sign({ kind: 'form-user', userId: USER.id, tenantId: 't2', path: FORM_URL }, HOUR);
    const result = await call({ url: `${FORM_URL}?code=x`, query: { code: 'x' } });
    expect(result.webhookResponse?.headers).not.toHaveProperty('set-cookie');
    expect(result.webhookResponse?.statusCode).toBe(302);
    expect(result.webhookResponse?.headers?.location).toContain('/sign-in');
  });

  it('a POST never swaps a code', async () => {
    const result = await call({
      method: 'POST',
      url: `${FORM_URL}?code=good-code`,
      query: { code: 'good-code' },
    });
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(401);
    expect(codes.has('good-code')).toBe(true);
  });

  it('with Require Workflow Execute Permission a refused user gets no cookie', async () => {
    canExecute.mockResolvedValue(false);
    const result = await call({
      url: `${FORM_URL}?code=good-code`,
      query: { code: 'good-code' },
      parameters: { requireExecuteAccess: true },
    });
    expect(result.webhookResponse?.statusCode).toBe(403);
    expect(result.webhookResponse?.headers).not.toHaveProperty('set-cookie');
  });
});

describe('a token', () => {
  it('the form cookie opens the page, and each page gets a fresh cookie', async () => {
    const token = tokenFor();
    const result = await call({ headers: cookieHeader(token) });
    expect(result.webhookResponse?.statusCode).toBe(200);
    const cookie = String(result.webhookResponse?.headers?.['set-cookie']);
    const fresh = /^ncb-form-auth-wf-wf-1=([^;]+);/.exec(cookie)?.[1] as string;
    expect(fresh).not.toBe(token);
    expect(formTokens.tokens.get(fresh)?.ttl).toBe(HOUR);
    expect(String(result.webhookResponse?.body)).toContain(`"authToken":"${fresh}"`);
  });

  it('the x-auth-token header opens the page too', async () => {
    const result = await call({ headers: { 'x-auth-token': tokenFor() } });
    expect(result.webhookResponse?.statusCode).toBe(200);
  });

  it('a POST reads the x-auth-token header and never the cookie', async () => {
    const byCookie = await call({ method: 'POST', headers: cookieHeader(tokenFor()) });
    expect(byCookie.webhookResponse?.statusCode).toBe(401);
    expect(byCookie.workflowData).toBeUndefined();
    const byHeader = await call({ method: 'POST', headers: { 'x-auth-token': tokenFor() } });
    expect(byHeader.workflowData).toBeTruthy();
    expect(byHeader.webhookResponse?.headers).not.toHaveProperty('set-cookie');
  });

  it.each([
    ['of another workflow', { workflowId: 'wf-2' }],
    ['of another workspace', { tenantId: 't2' }],
    ['of a later page', { executionId: 'e9' }],
    ['of another kind', { kind: 'form-basic' }],
  ])('%s does not open the form', async (_label, extra) => {
    const result = await call({ headers: { 'x-auth-token': tokenFor(extra) } });
    expect(result.webhookResponse?.statusCode).toBe(302);
  });

  it('a token the host no longer accepts does not open the form', async () => {
    formAuth.verifyToken = async () => null;
    const result = await call({ headers: cookieHeader(tokenFor()) });
    expect(result.webhookResponse?.statusCode).toBe(302);
  });

  it('a forged cookie does not open the form', async () => {
    const result = await call({ headers: cookieHeader('forged') });
    expect(result.webhookResponse?.statusCode).toBe(302);
  });

  it("another workflow's cookie is not read", async () => {
    const result = await call({ headers: { cookie: `ncb-form-auth-wf-wf-2=${tokenFor()}` } });
    expect(result.webhookResponse?.statusCode).toBe(302);
  });
});

describe('the output', () => {
  const submit = (parameters: DataObject = {}, headers: WebhookRequest['headers'] = {}) =>
    call({
      method: 'POST',
      parameters,
      headers: { 'x-auth-token': tokenFor(), ...headers },
    }).then((result) => result.workflowData?.[0]?.[0]?.json as DataObject);

  it('holds the user with its four fields', async () => {
    expect((await submit()).user).toEqual(USER);
  });

  it('Include User in Output off drops the user', async () => {
    expect(await submit({ options: { includeUserInOutput: false } })).not.toHaveProperty('user');
  });

  it('Show Headers never shows the token', async () => {
    const json = await submit({ options: { showHeaders: true } }, { 'x-other': '1' });
    expect(json.headers).toHaveProperty('x-other');
    expect(json.headers).not.toHaveProperty('x-auth-token');
    expect(JSON.stringify(json)).not.toContain('tok-');
  });

  it('never holds the code', async () => {
    const result = await call({
      method: 'POST',
      url: `${FORM_URL}?code=the-code&ref=mail`,
      query: { code: 'the-code', ref: 'mail' },
      headers: { 'x-auth-token': tokenFor() },
    });
    const json = result.workflowData?.[0]?.[0]?.json as DataObject;
    expect(json.formQueryParameters).toEqual({ ref: 'mail' });
    expect(JSON.stringify(json)).not.toContain('the-code');
  });
});

describe('Require Workflow Execute Permission', () => {
  it('is not asked by default', async () => {
    canExecute.mockResolvedValue(false);
    const result = await call({ headers: cookieHeader(tokenFor()) });
    expect(result.webhookResponse?.statusCode).toBe(200);
    expect(canExecute).not.toHaveBeenCalled();
  });

  it('on: refuses a user who may not run the workflow', async () => {
    canExecute.mockResolvedValue(false);
    const parameters = { requireExecuteAccess: true };
    const page = await call({ headers: cookieHeader(tokenFor()), parameters });
    expect(page.webhookResponse?.statusCode).toBe(403);
    expect(String(page.webhookResponse?.body)).toContain('permission');
    expect(page.webhookResponse?.headers).not.toHaveProperty('set-cookie');
    expect(canExecute).toHaveBeenCalledWith('u1', 'wf-1');

    const posted = await call({ method: 'POST', headers: { 'x-auth-token': tokenFor() }, parameters });
    expect(posted.workflowData).toBeUndefined();
    expect(posted.webhookResponse?.statusCode).toBe(403);
  });

  it('on: lets a user who may run it in', async () => {
    const result = await call({
      headers: cookieHeader(tokenFor()),
      parameters: { requireExecuteAccess: true },
    });
    expect(result.webhookResponse?.statusCode).toBe(200);
  });
});

describe('a later page', () => {
  const RESUME = 'http://localhost:5678/form-waiting/e1/sig';
  const later = { scope: 'waiting' as const, requireExecuteAccess: false };
  const services = { resumeFormUrl: RESUME };

  it('goes to sign-in with the signed URL of the page as the way back', async () => {
    const result = await check({ services }, later);
    expect(result.allowed).toBe(false);
    expect(result.response?.statusCode).toBe(302);
    expect(result.response?.headers?.location).toBe(
      `/sign-in?to=${encodeURIComponent('/form-waiting/e1/sig')}`,
    );
  });

  it('swaps a code for the cookie of this execution', async () => {
    codes.set('page-code', '/form-waiting/e1/sig');
    const result = await check({ services, query: { code: 'page-code' } }, later);
    expect(result.response?.headers?.location).toBe('/form-waiting/e1/sig');
    const cookie = String(result.response?.headers?.['set-cookie']);
    expect(cookie).toMatch(/^ncb-form-auth-ex-e1=[^;]+; /);
    expect(cookie).toContain('Path=/form-waiting/e1;');
  });

  it('opens with the cookie of this execution alone', async () => {
    const token = tokenFor({ executionId: 'e1' });
    const result = await check({ services, headers: { cookie: `ncb-form-auth-ex-e1=${token}` } }, later);
    expect(result.allowed).toBe(true);
    expect(result.user).toEqual(USER);
    expect(result.headers['set-cookie']).toMatch(/^ncb-form-auth-ex-e1=/);
  });

  it("does not take the trigger's token or another execution's", async () => {
    for (const extra of [{}, { executionId: 'e2' }]) {
      const result = await check({ services, headers: { 'x-auth-token': tokenFor(extra) } }, later);
      expect(result.allowed).toBe(false);
    }
  });

  it('asks the execute permission when the trigger did', async () => {
    canExecute.mockResolvedValue(false);
    const result = await check(
      { services, headers: { 'x-auth-token': tokenFor({ executionId: 'e1' }) } },
      { scope: 'waiting', requireExecuteAccess: true },
    );
    expect(result.allowed).toBe(false);
    expect(result.response?.statusCode).toBe(403);
  });
});

describe('the cookie Path', () => {
  it('cannot carry another attribute from the URL', async () => {
    const result = await call({
      url: '/form/acme/a;Domain=evil.example',
      headers: cookieHeader(tokenFor()),
    });
    const cookie = String(result.webhookResponse?.headers?.['set-cookie']);
    expect(cookie).toContain('Path=/form/acme/a%3BDomain%3Devil.example;');
    expect(cookie).not.toContain('; Domain=');
  });
});
