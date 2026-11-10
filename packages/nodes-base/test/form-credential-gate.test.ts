/**
 * P6-87: a Form Trigger with user auth shows the private accounts the run needs ("{n} of {m} connected", a
 * link per account, submit disabled until ready), and its POST names the signed-in user as the trigger user even
 * when Include User is off. Through a real webhook context with the host's gate faked.
 */
import { createWebhookContext } from '@workflow/core';
import {
  type CredentialGateHelper,
  type CredentialGateResult,
  type DataObject,
  ExpressionEvaluator,
  type FormAuthHelper,
  type WebhookRequest,
  type WebhookResponseData,
  Workflow,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConnectPanel, renderConnectPanelHtml } from '../src/utils/connect-panel';
import { node, nodeTypes, testServices } from './harness';

const USER = { id: 'u1', email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee' };
const FORM_URL = '/form/acme/who';
const HOUR = 60 * 60;

let result: CredentialGateResult;
let check: ReturnType<typeof vi.fn<CredentialGateHelper['check']>>;
let gate: CredentialGateHelper;
let tokens: Map<string, DataObject>;
let formAuth: FormAuthHelper;

const one = (id: string, name: string, status: 'configured' | 'missing', type = 'googleOAuth2Api') => ({
  credentialId: id,
  credentialName: name,
  credentialType: type,
  status,
});

beforeEach(() => {
  result = {
    readyToExecute: false,
    credentials: [one('c1', 'Calendar', 'missing'), one('c2', 'Drive', 'configured')],
  };
  check = vi.fn<CredentialGateHelper['check']>(async () => result);
  gate = {
    check,
    connectPageUrl: (id, action, returnTo) =>
      `https://app.example/credential-connect/${id}?action=${action}&returnTo=${encodeURIComponent(returnTo)}`,
  };
  tokens = new Map([['tok', { kind: 'form-user', userId: USER.id, tenantId: 't1', workflowId: 'wf-1' }]]);
  formAuth = {
    signInUrl: (returnTo) => `/sign-in?to=${encodeURIComponent(returnTo)}`,
    exchangeCode: async () => null,
    verifyToken: async (token) => (tokens.get(token)?.userId === USER.id ? USER : null),
    canExecute: async () => true,
  };
  void HOUR;
});

function contextOf(method: 'GET' | 'POST', parameters: DataObject = {}, services: { credentialGate?: CredentialGateHelper } = { credentialGate: gate }) {
  const workflow = new Workflow(
    {
      id: 'wf-1',
      name: 'forms',
      nodes: [
        node('Form', 'core.formTrigger', {
          formTitle: 'Who',
          authentication: 'n8nUserAuth',
          formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] },
          ...parameters,
        }),
      ],
      connections: {},
      settings: {},
    },
    nodeTypes,
  );
  const request: WebhookRequest = {
    method,
    url: FORM_URL,
    headers: { cookie: 'ncb-form-auth-wf-wf-1=tok', 'x-auth-token': 'tok' },
    query: {},
    params: {},
    body: method === 'POST' ? { 'field-0': 'Ann' } : {},
  };
  return createWebhookContext(
    {
      workflow,
      node: workflow.nodes.Form,
      services: testServices(
        {},
        {
          tenantId: 't1',
          mode: 'webhook',
          formAuth,
          formTokens: { sign: () => 'x', verify: (t: string) => tokens.get(t) ?? null },
          ...services,
        },
      ),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    },
    request,
    method === 'GET' ? 'setup' : 'default',
  );
}

const call = (method: 'GET' | 'POST', parameters?: DataObject, services?: { credentialGate?: CredentialGateHelper }): Promise<WebhookResponseData> =>
  nodeTypes.get('core.formTrigger')!.webhook!(contextOf(method, parameters, services));

const pageOf = (data: WebhookResponseData) => String(data.webhookResponse?.body);

describe('the form page (GET)', () => {
  it('lists the accounts, the count and a connect link per account, and disables submit', async () => {
    const page = pageOf(await call('GET'));
    expect(page).toContain('Connect your accounts');
    expect(page).toContain('1 of 2 connected');
    expect(page).toContain('Calendar');
    expect(page).toContain('Drive');
    expect(page).toContain(
      `href="https://app.example/credential-connect/c1?action=connect&amp;returnTo=${encodeURIComponent(FORM_URL)}"`,
    );
    // a connected account can be disconnected, a missing one cannot
    expect(page).toContain('action=disconnect&amp;returnTo=');
    expect(page.match(/action=disconnect/g)).toHaveLength(1);
    expect(page).toMatch(/<button type="submit" id="form-submit" disabled>/);
    expect(check).toHaveBeenCalledWith(USER.id);
  });

  it('carries its own CSP: nothing loads from outside', async () => {
    const page = pageOf(await call('GET'));
    expect(page).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;;/);
    expect(page).toContain('base-uri &#39;none&#39;');
  });

  it('enables submit when every account is connected', async () => {
    result = { readyToExecute: true, credentials: [one('c1', 'Calendar', 'configured')] };
    const page = pageOf(await call('GET'));
    expect(page).toContain('1 of 1 connected');
    expect(page).toMatch(/<button type="submit" id="form-submit">/);
  });

  it('shows no panel when the run reaches no private credential, or the host has no gate', async () => {
    result = { readyToExecute: true, credentials: [] };
    expect(pageOf(await call('GET'))).not.toContain('class="connect-panel"');
    expect(pageOf(await call('GET', {}, {}))).not.toContain('class="connect-panel"');
  });

  it('says so and blocks submit when the check throws, without the error text', async () => {
    check.mockRejectedValue(new Error('secret database detail'));
    const page = pageOf(await call('GET'));
    expect(page).toContain(
      `<p class="connect-error" role="alert">We couldn't check your connected accounts. Try again later.</p>`,
    );
    expect(page).not.toContain('secret database detail');
    expect(page).toMatch(/<button type="submit" id="form-submit" disabled>/);
  });

  it('escapes a credential name and type with markup', async () => {
    result = {
      readyToExecute: false,
      credentials: [one('c1', '<img src=x onerror=alert(1)>"\'', 'missing', '<script>x</script>')],
    };
    const page = pageOf(await call('GET'));
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain('<script>x</script>');
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('never puts a session or a token in a link', async () => {
    const page = pageOf(await call('GET'));
    const links = page.match(/href="[^"]*credential-connect[^"]*"/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).not.toMatch(/token|session|cookie|tok\b|code=/i);
  });

  it('reads the new answers in its script: 428 asks to connect, 503 says the check failed', async () => {
    const page = pageOf(await call('GET'));
    expect(page).toContain('response.status === 428');
    expect(page).toContain('response.status === 503');
  });
});

describe('the submit (POST)', () => {
  it('names the signed-in user as the trigger user, also with Include User off', async () => {
    const on = await call('POST');
    expect(on.triggerUserId).toBe(USER.id);
    expect(on.workflowData?.[0][0].json.user).toMatchObject({ id: USER.id });
    const off = await call('POST', { options: { includeUserInOutput: false } });
    expect(off.triggerUserId).toBe(USER.id);
    expect(off.workflowData?.[0][0].json.user).toBeUndefined();
  });

  it('names no trigger user without user auth', async () => {
    const none = await call('POST', { authentication: 'none' });
    expect(none.workflowData).toBeDefined();
    expect(none.triggerUserId).toBeUndefined();
  });
});

describe('loadConnectPanel', () => {
  it('builds the panel from the gate and the request path', async () => {
    const panel = await loadConnectPanel(contextOf('GET'), USER.id, FORM_URL);
    expect(panel).toMatchObject({ ready: false, failed: false, connected: 1, total: 2 });
    expect(panel?.items.map((i) => [i.name, i.connected])).toEqual([
      ['Calendar', false],
      ['Drive', true],
    ]);
  });

  it('does not link a script address', () => {
    const html = renderConnectPanelHtml({
      ready: false,
      failed: false,
      connected: 0,
      total: 1,
      items: [
        { credentialId: 'c1', name: 'A', type: 't', connected: false, connectUrl: 'javascript:alert(1)', disconnectUrl: '' },
      ],
    });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
  });
});
