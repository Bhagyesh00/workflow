/**
 * P6-87: the Webhook node's "Workspace sign-in (OAuth2)" through a real webhook context, with the host's helpers
 * faked. `bearer` needs a token for the webhook's own URL; `auto` also sends a browser through the form
 * sign-in page (kind `webhook-user`, a cookie scoped to the webhook's path).
 */
import { createWebhookContext, type ExecutionServices } from '@workflow/core';
import {
  type DataObject,
  ExpressionEvaluator,
  type FormAuthHelper,
  type McpAuthHelper,
  type WebhookRequest,
  type WebhookResponseData,
  Workflow,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { WEBHOOK_TOKEN_KIND } from '../src/utils/workspace-signin';
import { node, nodeTypes, testServices } from './harness';

const USER = { id: 'u1', email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee' };
const URL_PATH = '/webhook/acme/orders';
const HOUR = 60 * 60;

function fakeTokens() {
  let issued = 0;
  const tokens = new Map<string, { payload: DataObject; expires: number }>();
  return {
    tokens,
    sign(payload: DataObject, ttlSeconds: number) {
      const token = `tok-${++issued}`;
      tokens.set(token, { payload, expires: Date.now() + ttlSeconds * 1000 });
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
let mcpAuth: McpAuthHelper;
/** the resources the fake host was asked about, in order */
let asked: string[];
/** the token the fake host takes, for this resource only */
const GOOD_TOKEN = 'wfo_at_good';
let codes: Map<string, string>;

beforeEach(() => {
  formTokens = fakeTokens();
  canExecute = vi.fn<FormAuthHelper['canExecute']>(async () => true);
  asked = [];
  codes = new Map([['good-code', URL_PATH]]);
  formAuth = {
    signInUrl: (returnTo) => `/form-auth?redirect=${encodeURIComponent(returnTo)}`,
    exchangeCode: async (code) => {
      const path = codes.get(code);
      if (!path) return null;
      codes.delete(code);
      return formTokens.sign({ kind: WEBHOOK_TOKEN_KIND, userId: USER.id, tenantId: 't1', path }, HOUR);
    },
    verifyToken: async (token) => (formTokens.verify(token)?.userId === USER.id ? USER : null),
    canExecute,
  };
  mcpAuth = {
    verifyAccessToken: async (token, resource) => {
      asked.push(resource);
      return token === GOOD_TOKEN && resource === URL_PATH ? { user: USER, role: 'editor' } : null;
    },
    canExecute: (userId, workflowId) => canExecute(userId, workflowId),
    challenge: (resource) => `Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource${resource}"`,
  };
});

interface CallOptions {
  method?: WebhookRequest['method'];
  url?: string;
  query?: DataObject;
  headers?: WebhookRequest['headers'];
  parameters?: DataObject;
  services?: Partial<ExecutionServices>;
}

function contextOf(options: CallOptions) {
  const workflow = new Workflow(
    {
      id: 'wf-1',
      name: 'hooks',
      nodes: [
        node('Webhook', 'core.webhook', {
          httpMethod: 'GET',
          path: 'orders',
          authentication: 'n8nOAuth2',
          ...options.parameters,
        }),
      ],
      connections: {},
      settings: {},
    },
    nodeTypes,
  );
  const request: WebhookRequest = {
    method: options.method ?? 'GET',
    url: options.url ?? URL_PATH,
    headers: options.headers ?? {},
    query: options.query ?? {},
    params: {},
    body: {},
  };
  return createWebhookContext(
    {
      workflow,
      node: workflow.nodes.Webhook,
      services: testServices(
        {},
        { tenantId: 't1', mode: 'webhook', formTokens, formAuth, mcpAuth, ...options.services },
      ),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    },
    request,
    'default',
  );
}

const call = (options: CallOptions = {}): Promise<WebhookResponseData> =>
  nodeTypes.get('core.webhook')!.webhook!(contextOf(options));

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const browser = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate' };

describe('the option', () => {
  const description = nodeTypes.get('core.webhook')!.description;
  const property = (name: string) => description.properties.find((p) => p.name === name);

  it('is "Workspace sign-in (OAuth2)" with the value n8nOAuth2, and no n8n name in a label', () => {
    const auth = property('authentication');
    expect(auth?.options).toContainEqual(
      expect.objectContaining({ name: 'Workspace sign-in (OAuth2)', value: 'n8nOAuth2' }),
    );
    for (const option of [...(auth?.options ?? []), ...(property('oauthClient')?.options ?? [])]) {
      expect(JSON.stringify(option)).not.toMatch(/n8n instance|instance/i);
      expect((option as { name: string }).name).not.toMatch(/n8n/i);
    }
  });

  it('asks for the execute permission by default and offers the two clients', () => {
    expect(property('requireExecuteAccess')).toMatchObject({ default: true });
    expect(property('requireExecuteAccess')?.displayOptions).toEqual({ show: { authentication: ['n8nOAuth2'] } });
    expect(property('oauthClient')).toMatchObject({ default: 'bearer' });
    expect(property('oauthClient')?.options?.map((o) => (o as { value?: unknown }).value)).toEqual(['bearer', 'auto']);
    expect(property('includeUserInOutput')).toMatchObject({ default: true });
  });
});

describe('client "bearer"', () => {
  it('answers 401 with the challenge when there is no token, and no run starts', async () => {
    const result = await call();
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(401);
    expect(result.webhookResponse?.headers?.['www-authenticate']).toContain(
      `oauth-protected-resource${URL_PATH}`,
    );
  });

  it("checks the token against the webhook's own address, so a token for another resource is refused", async () => {
    // the fake host binds its token to URL_PATH; the same token on another webhook's address fails
    const other = await call({ url: '/webhook/acme/other', headers: bearer(GOOD_TOKEN) });
    expect(other.webhookResponse?.statusCode).toBe(401);
    expect(other.webhookResponse?.headers?.['www-authenticate']).toContain('error="invalid_token"');
    expect(asked).toEqual(['/webhook/acme/other']);
    const wrong = await call({ headers: bearer('wfo_at_other') });
    expect(wrong.webhookResponse?.statusCode).toBe(401);
  });

  it('gives only the path to the host, never the Host header, scheme or query', async () => {
    const result = await call({ url: `${URL_PATH}?x=1`, headers: { ...bearer(GOOD_TOKEN), host: 'evil.example' } });
    expect(result.webhookResponse).toBeUndefined();
    expect(asked).toEqual([URL_PATH]);
  });

  it('starts the run as the token\'s user, whether or not the user is in the output', async () => {
    const result = await call({ headers: bearer(GOOD_TOKEN) });
    expect(result.triggerUserId).toBe(USER.id);
    expect(result.workflowData?.[0][0].json.user).toEqual(USER);
    const hidden = await call({ headers: bearer(GOOD_TOKEN), parameters: { includeUserInOutput: false } });
    expect(hidden.workflowData?.[0][0].json.user).toBeUndefined();
    expect(hidden.triggerUserId).toBe(USER.id);
  });

  it('keeps the token out of the output headers, and keeps the other headers', async () => {
    const result = await call({
      headers: { ...bearer(GOOD_TOKEN), 'x-auth-token': 'tok-x', cookie: 'theme=dark', 'x-trace': 't1' },
    });
    const headers = result.workflowData?.[0][0].json.headers as DataObject;
    expect(headers).toEqual({ cookie: 'theme=dark', 'x-trace': 't1' });
    expect(JSON.stringify(result.workflowData)).not.toContain(GOOD_TOKEN);
    expect(JSON.stringify(result.workflowData)).not.toContain('tok-x');
  });

  it('does not take a browser: no token on a page navigation is 401, no redirect', async () => {
    const result = await call({ headers: browser });
    expect(result.webhookResponse?.statusCode).toBe(401);
    expect(result.webhookResponse?.headers?.location).toBeUndefined();
  });

  it('refuses a user without the execute permission, unless the option is off', async () => {
    canExecute.mockResolvedValue(false);
    const refused = await call({ headers: bearer(GOOD_TOKEN) });
    expect(refused.webhookResponse?.statusCode).toBe(403);
    expect(refused.workflowData).toBeUndefined();
    expect(canExecute).toHaveBeenCalledWith(USER.id, 'wf-1');
    const open = await call({ headers: bearer(GOOD_TOKEN), parameters: { requireExecuteAccess: false } });
    expect(open.workflowData).toBeDefined();
    expect(open.triggerUserId).toBe(USER.id);
  });

  it('refuses with 401 where the host has no sign-in helper', async () => {
    const result = await call({ services: { mcpAuth: undefined } });
    expect(result.webhookResponse?.statusCode).toBe(401);
  });

  it('adds no user and no trigger user for the other authentication modes', async () => {
    const result = await call({ parameters: { authentication: 'none' } });
    expect(result.triggerUserId).toBeUndefined();
    expect(result.workflowData?.[0][0].json.user).toBeUndefined();
  });
});

describe('client "auto"', () => {
  const auto = { oauthClient: 'auto' };

  it('still takes a Bearer token for the webhook\'s own address', async () => {
    const result = await call({ parameters: auto, headers: bearer(GOOD_TOKEN) });
    expect(result.triggerUserId).toBe(USER.id);
    expect((await call({ parameters: auto, headers: bearer('nope') })).webhookResponse?.statusCode).toBe(401);
  });

  it('sends a browser without a token to the sign-in page, back to this address', async () => {
    const result = await call({ parameters: auto, headers: browser, query: { ref: 'mail' }, url: `${URL_PATH}?ref=mail` });
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(302);
    expect(result.webhookResponse?.headers?.location).toBe(
      `/form-auth?redirect=${encodeURIComponent(`${URL_PATH}?ref=mail`)}`,
    );
  });

  it('swaps the one-time code for a cookie scoped to the webhook path, and drops the code from the address', async () => {
    const result = await call({
      parameters: auto,
      headers: browser,
      query: { code: 'good-code', ref: 'mail' },
      url: `${URL_PATH}?code=good-code&ref=mail`,
    });
    expect(result.webhookResponse?.statusCode).toBe(302);
    expect(result.webhookResponse?.headers?.location).toBe(`${URL_PATH}?ref=mail`);
    const cookie = String(result.webhookResponse?.headers?.['set-cookie']);
    expect(cookie).toMatch(/^ncb-form-auth-wf-wf-1=tok-\d+;/);
    expect(cookie).toContain(`Path=${URL_PATH};`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('good-code');
    // the token is of the webhook kind and bound to this tenant and workflow
    const minted = [...formTokens.tokens.values()].map((t) => t.payload).find((p) => p.userId === USER.id && p.workflowId);
    expect(minted).toMatchObject({ kind: WEBHOOK_TOKEN_KIND, tenantId: 't1', workflowId: 'wf-1' });
  });

  it('refuses a code that was issued for another address', async () => {
    codes.set('other-code', '/webhook/acme/other');
    const result = await call({ parameters: auto, headers: browser, query: { code: 'other-code' } });
    expect(result.webhookResponse?.statusCode).toBe(302);
    expect(result.webhookResponse?.headers?.location).toContain('/form-auth?redirect=');
    expect(result.webhookResponse?.headers?.['set-cookie']).toBeUndefined();
  });

  it('runs a browser that holds the cookie, as that user', async () => {
    const token = formTokens.sign(
      { kind: WEBHOOK_TOKEN_KIND, userId: USER.id, tenantId: 't1', workflowId: 'wf-1' },
      HOUR,
    );
    const result = await call({
      parameters: auto,
      headers: { ...browser, cookie: `ncb-form-auth-wf-wf-1=${token}` },
    });
    expect(result.workflowData).toBeDefined();
    expect(result.triggerUserId).toBe(USER.id);
  });

  it('keeps the sign-in cookie and token out of the output headers, and keeps the other cookies', async () => {
    const token = formTokens.sign(
      { kind: WEBHOOK_TOKEN_KIND, userId: USER.id, tenantId: 't1', workflowId: 'wf-1' },
      HOUR,
    );
    const result = await call({
      parameters: auto,
      headers: { ...browser, cookie: `theme=dark; ncb-form-auth-wf-wf-1=${token}; ncb-chat-auth-wf-wf-2=c2` },
    });
    expect(result.triggerUserId).toBe(USER.id);
    const headers = result.workflowData?.[0][0].json.headers as DataObject;
    expect(headers.cookie).toBe('theme=dark');
    expect(JSON.stringify(result.workflowData)).not.toContain(token);

    const only = await call({ parameters: auto, headers: { 'x-auth-token': token } });
    expect(only.triggerUserId).toBe(USER.id);
    expect(only.workflowData?.[0][0].json.headers).toEqual({});
  });

  it('does not take a token of another kind (a form token never opens a webhook)', async () => {
    const token = formTokens.sign(
      { kind: 'form-user', userId: USER.id, tenantId: 't1', workflowId: 'wf-1' },
      HOUR,
    );
    const result = await call({
      parameters: auto,
      headers: { ...browser, cookie: `ncb-form-auth-wf-wf-1=${token}` },
    });
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(302);
  });

  it('does not take a token of another tenant or workflow', async () => {
    for (const extra of [{ tenantId: 't2' }, { workflowId: 'wf-2' }]) {
      const token = formTokens.sign(
        { kind: WEBHOOK_TOKEN_KIND, userId: USER.id, tenantId: 't1', workflowId: 'wf-1', ...extra },
        HOUR,
      );
      const result = await call({
        parameters: auto,
        headers: { ...browser, cookie: `ncb-form-auth-wf-wf-1=${token}` },
      });
      expect(result.workflowData).toBeUndefined();
    }
  });

  it('answers a script with no token 401 with the Bearer challenge, not a redirect', async () => {
    const result = await call({ parameters: auto, method: 'POST', headers: { accept: 'application/json' } });
    expect(result.webhookResponse?.statusCode).toBe(401);
    expect(result.webhookResponse?.headers?.['www-authenticate']).toMatch(/^Bearer /);
  });

  it('checks the execute permission of a browser too', async () => {
    canExecute.mockResolvedValue(false);
    const token = formTokens.sign(
      { kind: WEBHOOK_TOKEN_KIND, userId: USER.id, tenantId: 't1', workflowId: 'wf-1' },
      HOUR,
    );
    const result = await call({
      parameters: auto,
      headers: { ...browser, cookie: `ncb-form-auth-wf-wf-1=${token}` },
    });
    expect(result.webhookResponse?.statusCode).toBe(403);
    expect(String(result.webhookResponse?.body)).toContain("don&#39;t have permission");
  });
});
