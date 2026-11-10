/**
 * P6-87: a hosted Chat with Workspace sign-in shows a bar and a "Connect your accounts" dialog for the private
 * accounts a message needs, and names the signed-in user as the trigger user (the server gates the POST with 428).
 * The MCP Server Trigger names the OAuth user too. Through real webhook contexts with the host's gate faked.
 */
import { createWebhookContext, type ExecutionServices } from '@workflow/core';
import {
  type CredentialGateHelper,
  type CredentialGateResult,
  type DataObject,
  ExpressionEvaluator,
  type FormAuthHelper,
  type McpAuthHelper,
  type WebhookRequest,
  type WebhookResponseData,
  Workflow,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { injectChatConnectBar, renderChatConnectBar } from '../src/nodes/trigger/chat-page';
import { ChatTriggerNode } from '../src/nodes/trigger/ChatTrigger.node';
import { checkWorkspaceSignIn, MCP_SIGNIN_TEXTS } from '../src/nodes/trigger/mcp-trigger-signin';
import { McpTriggerNode } from '../src/nodes/trigger/McpTrigger.node';
import { node, nodeTypes, services } from './harness';

const USER = { id: 'u1', email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee' };
const CHAT_URL = '/webhook/acme/hook-1/chat';
const message = { sessionId: 'abc', chatInput: 'Hello bot' };

const formTokens: NonNullable<ExecutionServices['formTokens']> = {
  sign: (payload) => `tok:${JSON.stringify(payload)}`,
  verify: (token) => (token.startsWith('tok:') ? (JSON.parse(token.slice(4)) as DataObject) : null),
};
const userToken = formTokens.sign({ kind: 'chat-user', tenantId: 't1', workflowId: 'wf-1', userId: USER.id }, 60);

let result: CredentialGateResult;
let check: ReturnType<typeof vi.fn<CredentialGateHelper['check']>>;
let gate: CredentialGateHelper;
let formAuth: FormAuthHelper;

const entry = (id: string, name: string, status: 'configured' | 'missing', type = 'googleOAuth2Api') => ({
  credentialId: id,
  credentialName: name,
  credentialType: type,
  status,
});

beforeEach(() => {
  result = { readyToExecute: false, credentials: [entry('c1', 'Calendar', 'missing'), entry('c2', 'Drive', 'configured')] };
  check = vi.fn<CredentialGateHelper['check']>(async () => result);
  gate = {
    check,
    connectPageUrl: (id, action, returnTo) =>
      `https://app.example/credential-connect/${id}?action=${action}&returnTo=${encodeURIComponent(returnTo)}`,
  };
  formAuth = {
    signInUrl: (returnTo) => `/form-auth?redirect=${encodeURIComponent(returnTo)}`,
    exchangeCode: async () => null,
    verifyToken: async (token) => (formTokens.verify(token)?.userId === USER.id ? USER : null),
    canExecute: vi.fn(async () => true),
  };
});

async function call(
  parameters: DataObject,
  request: Partial<WebhookRequest>,
  options: { webhookName?: string; gate?: CredentialGateHelper | null } = {},
): Promise<WebhookResponseData> {
  const trigger = node('Chat', 'ai.chatTrigger', parameters, { webhookId: 'hook-1' });
  const workflow = new Workflow({ id: 'wf-1', name: 'chat', nodes: [trigger], connections: {} }, nodeTypes);
  const svc = services({
    mode: 'webhook',
    formTokens,
    formAuth,
    ...(options.gate === null ? {} : { credentialGate: options.gate ?? gate }),
  });
  const ctx = createWebhookContext(
    {
      workflow,
      node: trigger,
      services: svc,
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    },
    { method: 'POST', url: CHAT_URL, headers: {}, query: {}, params: {}, body: {}, ...request },
    options.webhookName ?? 'default',
    { getInputConnectionData: async () => undefined },
  );
  return ChatTriggerNode.webhook!(ctx);
}

const params = { public: true, authentication: 'n8nUserAuth' };
const signedIn = { 'x-auth-token': userToken };
const page = (options?: { gate?: CredentialGateHelper | null }) =>
  call(params, { method: 'GET', headers: signedIn }, { webhookName: 'setup', ...options });
const bodyOf = (r: WebhookResponseData) => String(r.webhookResponse?.body);

describe('the hosted page (GET)', () => {
  it('adds a bar and a dialog that lists the accounts, the count and a link per account', async () => {
    const html = bodyOf(await page());
    expect(html).toContain('id="connect-bar"');
    expect(html).toContain('Connect your accounts (1 of 2 connected)');
    expect(html).toContain('<dialog id="connect-dialog"');
    expect(html).toContain('Calendar');
    expect(html).toContain('Drive');
    expect(html).toContain(
      `href="https://app.example/credential-connect/c1?action=connect&amp;returnTo=${encodeURIComponent(CHAT_URL)}"`,
    );
    expect(html).toContain('action=disconnect');
    expect(check).toHaveBeenCalledWith(USER.id);
    // the chat page itself is still there
    expect(html).toContain('id="chat-config"');
  });

  it('opens the dialog by itself while an account is missing, not when every one is connected', async () => {
    expect(bodyOf(await page())).toContain(' data-open>');
    result = { readyToExecute: true, credentials: [entry('c1', 'Calendar', 'configured')] };
    const ready = bodyOf(await page());
    expect(ready).toContain('Connect your accounts (1 of 1 connected)');
    expect(ready).not.toContain(' data-open>');
  });

  it('adds nothing when the run reaches no private credential, or the host has no gate', async () => {
    result = { readyToExecute: true, credentials: [] };
    expect(bodyOf(await page())).not.toContain('connect-bar');
    expect(bodyOf(await page({ gate: null }))).not.toContain('connect-bar');
  });

  it('says so when the check throws, without the error text', async () => {
    check.mockRejectedValue(new Error('secret database detail'));
    const html = bodyOf(await page());
    expect(html).toContain("We couldn't check your connected accounts");
    expect(html).not.toContain('secret database detail');
  });

  it('escapes a credential name with markup, and has one fixed script', async () => {
    result = {
      readyToExecute: false,
      credentials: [entry('c1', '</script><img src=x onerror=alert(1)>', 'missing', '"><b>')],
    };
    const html = bodyOf(await page());
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('"><b>');
    expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;');
    // the chat's bootstrap and the dialog's script; no value of the panel is in either
    expect(html.match(/<script>/g)).toHaveLength(2);
  });

  it('never puts a session or a token in a link', async () => {
    const html = bodyOf(await page());
    for (const link of html.match(/href="[^"]*credential-connect[^"]*"/g) ?? []) {
      expect(link).not.toMatch(/token|session|cookie|tok:|code=/i);
    }
  });
});

describe('the helpers', () => {
  it('leaves a page without a head or body as it is', () => {
    const panel = { ready: true, failed: false, connected: 0, total: 0, items: [] };
    expect(injectChatConnectBar('plain text', panel)).toBe('plain text');
    expect(renderChatConnectBar(panel).markup).toContain('connect-dialog');
  });
});

describe('a message (POST)', () => {
  it('names the signed-in user as the trigger user, also with Include User off', async () => {
    const on = await call(params, { body: message, headers: signedIn });
    expect(on.triggerUserId).toBe(USER.id);
    expect(on.workflowData?.[0][0].json.user).toEqual(USER);
    const off = await call({ ...params, includeUserInOutput: false }, { body: message, headers: signedIn });
    expect(off.triggerUserId).toBe(USER.id);
    expect(off.workflowData?.[0][0].json).not.toHaveProperty('user');
  });

  it('names the user of a manual history load too, which starts a run', async () => {
    const r = await call(
      { ...params, options: { loadPreviousSession: 'manually' } },
      { body: { ...message, action: 'loadPreviousSession' }, headers: signedIn },
    );
    expect(r.workflowData).toBeDefined();
    expect(r.triggerUserId).toBe(USER.id);
  });

  it('names no trigger user without a sign-in, and a refused caller starts no run', async () => {
    const open = await call({ public: true }, { body: message });
    expect(open.workflowData).toBeDefined();
    expect(open.triggerUserId).toBeUndefined();
    const refused = await call(params, { body: message });
    expect(refused.workflowData).toBeUndefined();
    expect(refused.triggerUserId).toBeUndefined();
  });
});

describe('the MCP Server Trigger', () => {
  async function mcp(headers: Record<string, string>, parameters: DataObject = {}) {
    const mcpAuth: McpAuthHelper = {
      verifyAccessToken: async (token) => (token === 'wfo_at_ok' ? { user: USER, role: 'editor' } : null),
      canExecute: async () => true,
      challenge: (resource) => `Bearer resource_metadata="https://m.example${resource}"`,
    };
    const trigger = node('MCP', 'ai.mcpTrigger', { path: 'p', authentication: 'n8nOAuth2', ...parameters }, { webhookId: 'w' });
    const workflow = new Workflow({ id: 'wf-1', name: 'mcp', nodes: [trigger], connections: {} }, nodeTypes);
    const ctx = createWebhookContext(
      {
        workflow,
        node: trigger,
        services: services({ mode: 'webhook', mcpAuth }),
        evaluator: new ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      {
        method: 'POST',
        url: '/mcp/acme/p',
        headers: { 'content-type': 'application/json', ...headers },
        query: {},
        params: {},
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: {} } },
      },
      'default',
    );
    return McpTriggerNode.webhook!(ctx);
  }

  it('names the OAuth user as the trigger user, also with Include User off', async () => {
    const r = await mcp({ authorization: 'Bearer wfo_at_ok' });
    expect(r.triggerUserId).toBe(USER.id);
    const off = await mcp({ authorization: 'Bearer wfo_at_ok' }, { includeUserInOutput: false });
    expect(off.triggerUserId).toBe(USER.id);
    expect(off.workflowData?.[0][0].json).not.toHaveProperty('user');
  });

  it('names nobody for a refused token', async () => {
    const r = await mcp({ authorization: 'Bearer wfo_at_bad' });
    expect(r.webhookResponse?.statusCode).toBe(401);
    expect(r.triggerUserId).toBeUndefined();
  });

  it('keeps its sign-in import path: the code lives in nodes-base and the texts are the trigger\'s', () => {
    expect(typeof checkWorkspaceSignIn).toBe('function');
    expect(MCP_SIGNIN_TEXTS.required).toContain('MCP server');
  });
});
