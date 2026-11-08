/** P5-57: Chat Trigger parity: authentication, availability, user key, files, history and highlighted data. */
import { createWebhookContext, createWebhookSubNodes, type ExecutionServices } from '@workflow/core';
import {
  type AiChatMessage,
  type AiMemory,
  type DataObject,
  type ExecutionMode,
  ExpressionEvaluator,
  evaluatePortExpression,
  type FormAuthHelper,
  HIGHLIGHTED_SESSION_KEY,
  highlightedInputKey,
  resolveNodeParameters,
  resolvePorts,
  type WebhookRequest,
  type WebhookResponseData,
  Workflow,
} from '@workflow/workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBufferMemory } from '../src/nodes/memory/memory.nodes';
import { ChatTriggerNode } from '../src/nodes/trigger/ChatTrigger.node';
import { connect, node, nodeTypes, services } from './harness';

const USER = { id: 'u1', email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee' };
const CHAT_URL = '/webhook/acme/hook-1/chat';
const message = { sessionId: 'abc', chatInput: 'Hello bot' };
const basic = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;
const CREDS = { httpBasicAuth: { user: 'ada', password: 's3cret' } };

/** tokens the way the host signs them: readable payloads, no secret */
const formTokens: NonNullable<ExecutionServices['formTokens']> = {
  sign: (payload) => `tok:${JSON.stringify(payload)}`,
  verify: (token) => {
    if (!token.startsWith('tok:')) return null;
    try {
      return JSON.parse(token.slice(4)) as DataObject;
    } catch {
      return null;
    }
  },
};
const claims = (kind: string, extra: DataObject = {}) =>
  formTokens.sign({ kind, tenantId: 't1', workflowId: 'wf-1', node: 'Chat', ...extra }, 60);

let formAuth: FormAuthHelper;
beforeEach(() => {
  formAuth = {
    signInUrl: (returnTo) => `/form-auth?redirect=${encodeURIComponent(returnTo)}`,
    exchangeCode: async () => null,
    verifyToken: async (token) => (formTokens.verify(token)?.userId === USER.id ? USER : null),
    canExecute: vi.fn(async () => true),
  };
});

interface CallOptions {
  mode?: ExecutionMode;
  webhookName?: string;
  /** false: the node has no credential entry */
  credential?: boolean;
  services?: Partial<ExecutionServices>;
  creds?: Record<string, DataObject>;
  memory?: unknown;
}

async function call(
  parameters: DataObject,
  request: Partial<WebhookRequest>,
  options: CallOptions = {},
): Promise<WebhookResponseData> {
  const trigger = node('Chat', 'ai.chatTrigger', parameters, {
    webhookId: 'hook-1',
    ...(options.credential === false ? {} : { credentials: { httpBasicAuth: { id: 'b', name: 'b' } } }),
  });
  const workflow = new Workflow({ id: 'wf-1', name: 'chat', nodes: [trigger], connections: {} }, nodeTypes);
  const svc = services({
    creds: options.creds ?? CREDS,
    mode: options.mode ?? 'webhook',
    formTokens,
    formAuth,
    ...options.services,
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
    { getInputConnectionData: async () => options.memory },
  );
  return ChatTriggerNode.webhook!(ctx);
}

const statusOf = (r: WebhookResponseData) => r.webhookResponse?.statusCode ?? 200;
const messageOf = (r: WebhookResponseData) => (r.webhookResponse?.body as { message?: string })?.message;
const itemOf = (r: WebhookResponseData) => r.workflowData?.[0][0];

const CONFIG = /<script type="application\/json" id="chat-config">([^<]*)<\/script>/;
const configOf = (r: WebhookResponseData) =>
  JSON.parse(CONFIG.exec(String(r.webhookResponse?.body))?.[1] ?? 'null') as DataObject;

describe('parameters', () => {
  const properties = ChatTriggerNode.description.properties;
  const named = (name: string) => properties.find((p) => p.name === name);
  const optionOf = (name: string) =>
    (
      (named('options')?.options ?? []) as Array<{ name: string; default?: unknown; options?: unknown[] }>
    ).find((o) => o.name === name);
  const values = (p: { options?: unknown[] } | undefined) =>
    (p?.options ?? []).map((o) => (o as { value: unknown }).value);

  it('adds Workspace sign-in with its three fields', () => {
    expect(values(named('authentication'))).toEqual(['none', 'basicAuth', 'n8nUserAuth']);
    expect(values(named('trustedSource'))).toEqual(['workspaceSignIn']);
    for (const name of ['trustedSource', 'requireExecuteAccess', 'includeUserInOutput']) {
      expect(named(name)?.displayOptions).toEqual({
        show: { public: [true], authentication: ['n8nUserAuth'] },
      });
    }
    expect(named('requireExecuteAccess')?.default).toBe(false);
    expect(named('includeUserInOutput')?.default).toBe(true);
  });

  it('adds the page and history options', () => {
    expect(optionOf('showWelcomeScreen')?.default).toBe(false);
    expect(optionOf('getStarted')?.default).toBe('New Conversation');
    expect(optionOf('customCss')?.default).toBe('');
    // n8n: on unless turned off
    expect(optionOf('autoSaveHighlightedData')?.default).toBe(true);
    expect(optionOf('loadPreviousSession')?.default).toBe('notSupported');
    expect(values(optionOf('loadPreviousSession'))).toEqual(['notSupported', 'memory', 'manually']);
  });

  it('takes one memory input only for loadPreviousSession memory', () => {
    const inputs = ChatTriggerNode.description.inputs as string;
    expect(typeof inputs).toBe('string');
    expect(inputs).toContain("$parameter.options?.loadPreviousSession === 'memory'");
    expect(inputs).toContain("type: 'ai_memory'");
    expect(inputs).toContain('maxConnections: 1');
    const ports = (loadPreviousSession: string) =>
      resolvePorts(
        inputs,
        {
          ...node('Chat', 'ai.chatTrigger'),
          parameters: resolveNodeParameters(
            ChatTriggerNode.description.properties,
            { options: { loadPreviousSession } },
            { nodeVersion: 1 },
          ),
        },
        evaluatePortExpression,
      );
    expect(ports('memory')).toEqual([{ type: 'ai_memory', displayName: 'Memory', maxConnections: 1 }]);
    expect(ports('notSupported')).toEqual([]);
  });
});

describe('Basic auth', () => {
  const params = { public: true, authentication: 'basicAuth' };

  it('lets a valid Basic login through', async () => {
    const r = await call(params, { body: message, headers: { authorization: basic('ada:s3cret') } });
    expect(itemOf(r)?.json.chatInput).toBe('Hello bot');
  });

  it('lets a valid x-auth-token through, the one the page got from its GET', async () => {
    const page = await call(
      params,
      { method: 'GET', headers: { authorization: basic('ada:s3cret') } },
      { webhookName: 'setup' },
    );
    expect(statusOf(page)).toBe(200);
    const token = String(configOf(page).authToken);
    expect(token).toBeTruthy();
    const r = await call(params, { body: message, headers: { 'x-auth-token': token } });
    expect(itemOf(r)).toBeDefined();
  });

  it('answers 401 without credentials and the browser login on the page', async () => {
    const r = await call(params, { body: message });
    expect(statusOf(r)).toBe(401);
    expect(messageOf(r)).toBe('Authorization is required!');
    const page = await call(params, { method: 'GET' }, { webhookName: 'setup' });
    expect(statusOf(page)).toBe(401);
    expect(page.webhookResponse?.headers?.['www-authenticate']).toContain('Basic');
  });

  it('answers 403 for a wrong Basic login', async () => {
    for (const authorization of [basic('ada:wrong'), basic('eve:s3cret'), basic('nocolon')]) {
      const r = await call(params, { body: message, headers: { authorization } });
      expect(statusOf(r)).toBe(403);
      expect(messageOf(r)).toBe('Authorization data is wrong!');
    }
  });

  it('reads the Basic scheme in any case', async () => {
    const login = Buffer.from('ada:s3cret').toString('base64');
    for (const authorization of [`basic ${login}`, `BASIC ${login}`, `  Basic   ${login} `]) {
      const r = await call(params, { body: message, headers: { authorization } });
      expect(itemOf(r)?.json.chatInput).toBe('Hello bot');
    }
  });

  it('takes a header of another scheme as no login: 401 with the browser login', async () => {
    for (const authorization of ['Bearer abc', 'Digest x', '']) {
      const r = await call(params, { body: message, headers: { authorization } });
      expect(statusOf(r)).toBe(401);
      expect(messageOf(r)).toBe('Authorization is required!');
      expect(r.webhookResponse?.headers?.['www-authenticate']).toContain('Basic');
    }
    // the page's token still works beside it
    const page = await call(
      params,
      { method: 'GET', headers: { authorization: basic('ada:s3cret') } },
      { webhookName: 'setup' },
    );
    const token = String(configOf(page).authToken);
    const r = await call(params, {
      body: message,
      headers: { authorization: 'Bearer abc', 'x-auth-token': token },
    });
    expect(itemOf(r)).toBeDefined();
  });

  it('answers 403 for a token that fails: another kind, node, workflow or credential', async () => {
    const r = await call(params, { body: message });
    expect(statusOf(r)).toBe(401);
    const good = await call(
      params,
      { method: 'GET', headers: { authorization: basic('ada:s3cret') } },
      { webhookName: 'setup' },
    );
    const real = formTokens.verify(String(configOf(good).authToken)) as DataObject;
    const forged = (patch: DataObject) => formTokens.sign({ ...real, ...patch }, 60);
    for (const token of [
      'garbage',
      forged({ kind: 'chat-page' }),
      forged({ kind: 'form-basic' }),
      forged({ node: 'Other' }),
      forged({ workflowId: 'wf-2' }),
      forged({ tenantId: 't2' }),
      forged({ credential: 'old-password' }),
    ]) {
      const denied = await call(params, { body: message, headers: { 'x-auth-token': token } });
      expect(statusOf(denied)).toBe(403);
      expect(messageOf(denied)).toBe('Authorization data is wrong!');
    }
    // the page's own GET never accepts a token: it asks for the login
    const page = await call(
      params,
      { method: 'GET', headers: { 'x-auth-token': String(configOf(good).authToken) } },
      { webhookName: 'setup' },
    );
    expect(statusOf(page)).toBe(401);
  });

  it('answers 500 when the node has no credential', async () => {
    const r = await call(
      params,
      { body: message, headers: { authorization: basic('ada:s3cret') } },
      { credential: false },
    );
    expect(statusOf(r)).toBe(500);
    expect(messageOf(r)).toBe('No authentication data defined on node!');
    const empty = await call(
      params,
      { body: message, headers: { authorization: basic(':') } },
      { creds: { httpBasicAuth: { user: '', password: '' } } },
    );
    expect(statusOf(empty)).toBe(500);
  });
});

describe('availability', () => {
  it('answers 404 on a public URL when public chats are off, and keeps test runs working', async () => {
    const off = { disablePublicChatTrigger: true };
    const closed = await call({ public: true }, { body: message }, { services: off });
    expect(statusOf(closed)).toBe(404);
    expect(closed.workflowData).toBeUndefined();
    const page = await call({ public: true }, { method: 'GET' }, { services: off, webhookName: 'setup' });
    expect(statusOf(page)).toBe(404);
    const test = await call({ public: true }, { body: message }, { services: off, mode: 'manual' });
    expect(itemOf(test)).toBeDefined();
  });

  it('opens a chat that is not public only to a test run with its test token', async () => {
    const hit = (headers: Record<string, string>, mode: ExecutionMode = 'manual') =>
      call({}, { body: message, headers }, { mode });
    expect(itemOf(await hit({ 'x-chat-test-token': claims('chat-test') }))).toBeDefined();
    expect(statusOf(await hit({}))).toBe(404);
    // wrong kind, another node, another workflow
    expect(statusOf(await hit({ 'x-chat-test-token': claims('chat-page') }))).toBe(404);
    expect(statusOf(await hit({ 'x-chat-test-token': claims('chat-test', { node: 'Other' }) }))).toBe(404);
    expect(statusOf(await hit({ 'x-chat-test-token': claims('chat-test', { workflowId: 'wf-2' }) }))).toBe(
      404,
    );
    // the token does not open a production URL
    expect(statusOf(await hit({ 'x-chat-test-token': claims('chat-test') }, 'webhook'))).toBe(404);
  });

  it('answers 404 before a refused Origin, so a closed chat never shows it exists', async () => {
    const params = { public: true, options: { allowedOrigins: 'https://a.example' } };
    const headers = { origin: 'https://b.example' };
    const off = { disablePublicChatTrigger: true };
    const closed = await call(params, { body: message, headers }, { services: off });
    expect(statusOf(closed)).toBe(404);
    expect(messageOf(closed)).toBe('This chat is not available');
    const notPublic = await call({ options: params.options }, { body: message, headers }, { mode: 'manual' });
    expect(statusOf(notPublic)).toBe(404);
    // an open chat still refuses the Origin, before any login
    const open = await call({ ...params, authentication: 'basicAuth' }, { body: message, headers });
    expect(statusOf(open)).toBe(403);
    expect(messageOf(open)).toBe('Origin not allowed');
  });

  it('lets an editor test a public chat with a login through its test token, as the canvas chat', async () => {
    const test = { 'x-chat-test-token': claims('chat-test') };
    for (const authentication of ['basicAuth', 'n8nUserAuth']) {
      const params = { public: true, authentication };
      const r = await call(params, { body: message, headers: test }, { mode: 'manual' });
      expect(itemOf(r)?.json).toEqual({ sessionId: 'abc', action: 'sendMessage', chatInput: 'Hello bot' });
      // without the token, or on the production URL, the login still applies
      expect(statusOf(await call(params, { body: message }, { mode: 'manual' }))).toBe(401);
      expect(statusOf(await call(params, { body: message, headers: test }))).toBe(401);
      const forged = { 'x-chat-test-token': claims('chat-test', { node: 'Other' }) };
      expect(statusOf(await call(params, { body: message, headers: forged }, { mode: 'manual' }))).toBe(401);
    }
  });
});

describe('the item', () => {
  it('always drops a caller `user` key', async () => {
    const r = await call({ public: true }, { body: { ...message, user: { id: 'evil' } } });
    expect(itemOf(r)?.json).toEqual({ sessionId: 'abc', action: 'sendMessage', chatInput: 'Hello bot' });
    const asked = await call(
      { public: true },
      { body: { ...message, action: 'loadPreviousSession', user: 1 } },
    );
    expect(JSON.stringify(asked.webhookResponse?.body)).not.toContain('evil');
  });

  it('adds the user only for Workspace sign-in with Include User in Output', async () => {
    const token = claims('chat-user', { node: undefined, userId: 'u1' });
    const params = { public: true, authentication: 'n8nUserAuth' };
    const body = { ...message, user: { id: 'evil' } };
    const headers = { 'x-auth-token': token };
    expect(itemOf(await call(params, { body, headers }))?.json.user).toEqual(USER);
    const hidden = await call({ ...params, includeUserInOutput: false }, { body, headers });
    expect(itemOf(hidden)?.json).not.toHaveProperty('user');
  });

  it('adds json.files beside binary', async () => {
    const files = [
      { fieldName: 'f', fileName: 'a.txt', mimeType: 'text/plain', data: new TextEncoder().encode('hi') },
      { fieldName: 'f', fileName: 'b.png', mimeType: 'image/png', data: new Uint8Array(4) },
    ];
    const r = await call({ public: true, options: { allowFileUploads: true } }, { body: message, files });
    const item = itemOf(r);
    expect(Object.keys(item?.binary ?? {})).toEqual(['data0', 'data1']);
    expect(item?.json.files).toMatchObject([
      { fileName: 'a.txt', fileSize: 2, mimeType: 'text/plain', binaryKey: 'data0' },
      { fileName: 'b.png', fileSize: 4, mimeType: 'image/png', binaryKey: 'data1' },
    ]);
    for (const file of (item?.json.files ?? []) as DataObject[]) {
      expect(Object.keys(file).sort()).toEqual(
        ['binaryKey', 'fileExtension', 'fileName', 'fileSize', 'fileType', 'mimeType'].sort(),
      );
    }
    expect(itemOf(await call({ public: true }, { body: message }))?.json).not.toHaveProperty('files');
  });

  it('keeps the message and session id as highlighted data unless auto-save is off, as n8n', async () => {
    const saved = {
      [highlightedInputKey('Chat')]: 'Hello bot',
      [HIGHLIGHTED_SESSION_KEY]: 'abc',
    };
    const on = await call({ public: true, options: { autoSaveHighlightedData: true } }, { body: message });
    expect(on.customData).toEqual(saved);
    expect((await call({ public: true }, { body: message })).customData).toEqual(saved);
    const off = await call({ public: true, options: { autoSaveHighlightedData: false } }, { body: message });
    expect(off.customData).toBeUndefined();
    const long = await call(
      { public: true, options: { autoSaveHighlightedData: true } },
      { body: { ...message, chatInput: 'x'.repeat(5000) } },
    );
    expect(long.customData?.[highlightedInputKey('Chat')]).toHaveLength(255);
  });
});

describe('Workspace sign-in', () => {
  const params = { public: true, authentication: 'n8nUserAuth' };

  it('sends the page to sign-in and gives a POST without a token a 401 the widget can show', async () => {
    const page = await call(params, { method: 'GET' }, { webhookName: 'setup' });
    expect(page.webhookResponse?.statusCode).toBe(302);
    expect(page.webhookResponse?.headers?.location).toBe(
      `/form-auth?redirect=${encodeURIComponent(CHAT_URL)}`,
    );
    const post = await call(params, { body: message });
    expect(statusOf(post)).toBe(401);
    expect(messageOf(post)).toContain('sign-in');
  });

  it('refuses a token of another kind, workflow or tenant', async () => {
    for (const token of [
      claims('form-user', { node: undefined, userId: 'u1' }),
      claims('chat-basic', { node: undefined, userId: 'u1' }),
      claims('chat-user', { node: undefined, userId: 'u1', workflowId: 'wf-2' }),
      claims('chat-user', { node: undefined, userId: 'u1', tenantId: 't2' }),
      claims('chat-user', { node: undefined, userId: 'nobody' }),
    ]) {
      const r = await call(params, { body: message, headers: { 'x-auth-token': token } });
      expect(statusOf(r)).toBe(401);
      expect(r.workflowData).toBeUndefined();
    }
  });
});

describe('loadPreviousSession', () => {
  const ask = { sessionId: 'abc', action: 'loadPreviousSession' };

  function fakeMemory(messages: AiChatMessage[]) {
    const memory = {
      kind: 'memory' as const,
      sessionId: 'abc__Memory',
      load: vi.fn(async () => messages.slice(-1)),
      loadAll: vi.fn(async (_id: string) => messages),
      append: vi.fn(),
      replace: vi.fn(),
      clear: vi.fn(),
    } satisfies AiMemory & { sessionId: string };
    return memory;
  }

  it('answers an empty list when it is off', async () => {
    const r = await call({ public: true }, { body: ask });
    expect(r.webhookResponse?.body).toEqual({ data: [] });
  });

  it('reads the whole history from memory, leaves out hidden messages and answers the serialised shape', async () => {
    const memory = fakeMemory([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'secret note', hideFromUI: true },
      { role: 'user', content: [{ type: 'text', text: 'Bye' }] },
    ]);
    const r = await call(
      { public: true, options: { loadPreviousSession: 'memory' } },
      { body: ask },
      { memory },
    );
    expect(memory.loadAll).toHaveBeenCalledWith('abc__Memory');
    expect(memory.load).not.toHaveBeenCalled();
    const data = ((r.webhookResponse?.body ?? {}) as { data: DataObject[] }).data;
    expect(data.map((m) => [(m.id as string[]).at(-1), (m.kwargs as DataObject).content])).toEqual([
      ['HumanMessage', 'Hi'],
      ['AIMessage', 'Hello!'],
      ['HumanMessage', 'Bye'],
    ]);
  });

  it('answers an empty list when no memory is connected', async () => {
    const r = await call({ public: true, options: { loadPreviousSession: 'memory' } }, { body: ask });
    expect(r.webhookResponse?.body).toEqual({ data: [] });
  });

  it('starts the run with the action item when it is manual', async () => {
    const r = await call({ public: true, options: { loadPreviousSession: 'manually' } }, { body: ask });
    expect(itemOf(r)?.json).toEqual({ sessionId: 'abc', action: 'loadPreviousSession' });
    expect(r.webhookResponse).toBeUndefined();
  });

  it('gives a memory keyed on $json.user.email the signed-in user, never the caller-sent one', async () => {
    clearBufferMemory();
    const trigger = node(
      'Chat',
      'ai.chatTrigger',
      { public: true, authentication: 'n8nUserAuth', options: { loadPreviousSession: 'memory' } },
      { webhookId: 'hook-1' },
    );
    const keyedMemory = node('Memory', 'ai.memoryBufferWindow', {
      sessionIdType: 'customKey',
      sessionKey: '={{ $json.user.email }}',
    });
    const workflow = new Workflow(
      {
        id: 'wf-1',
        name: 'chat',
        nodes: [trigger, keyedMemory],
        connections: connect(['Memory', 'Chat', 'ai_memory']),
      },
      nodeTypes,
    );
    const deps = {
      workflow,
      node: trigger,
      services: services({ mode: 'webhook', formTokens, formAuth }),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    };
    const memoryOf = (raw: unknown) => {
      const first = Array.isArray(raw) ? raw[0] : raw;
      return (Array.isArray(first) ? first[0] : first) as AiMemory & { sessionId: string };
    };
    // each member's history, written through the memory itself
    for (const [email, text] of [
      [USER.email, 'mine'],
      ['b@corp', 'theirs'],
    ]) {
      const subNodes = createWebhookSubNodes(deps, { json: { user: { email } } });
      const memory = memoryOf(await subNodes.callbacks.getInputConnectionData('ai_memory', 0));
      await memory.append(memory.sessionId, [{ role: 'user', content: text }]);
      await subNodes.close();
    }
    // as the server: the sub-nodes' item wraps the same body the node reads
    const reload = async (body: DataObject) => {
      const request: WebhookRequest = {
        method: 'POST',
        url: CHAT_URL,
        headers: { 'x-auth-token': claims('chat-user', { node: undefined, userId: 'u1' }) },
        query: {},
        params: {},
        body,
      };
      const subNodes = createWebhookSubNodes(deps, { json: body });
      try {
        return await ChatTriggerNode.webhook!(
          createWebhookContext(deps, request, 'default', subNodes.callbacks),
        );
      } finally {
        await subNodes.close();
      }
    };
    const texts = (r: WebhookResponseData) =>
      ((r.webhookResponse?.body as { data?: DataObject[] })?.data ?? []).map(
        (m) => (m.kwargs as DataObject).content,
      );
    const ask = { sessionId: 'x', action: 'loadPreviousSession' };
    const forged = await reload({ ...ask, user: { email: 'b@corp' } });
    expect(statusOf(forged)).toBe(200);
    expect(texts(forged)).toEqual(['mine']);
    const real = await reload({ ...ask });
    expect(statusOf(real)).toBe(200);
    expect(texts(real)).toEqual(['mine']);
  });

  it('is behind the same authentication as a message', async () => {
    const r = await call(
      { public: true, authentication: 'basicAuth', options: { loadPreviousSession: 'memory' } },
      { body: ask },
      { memory: fakeMemory([{ role: 'user', content: 'Hi' }]) },
    );
    expect(statusOf(r)).toBe(401);
  });
});
