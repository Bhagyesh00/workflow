/**
 * The Chat Trigger's shared surface (chat-setup.ts): the setup GET (the hosted page in `hostedChat` mode,
 * 404 in `webhook` mode), the Origin rule with the page and test tokens, the limits and the upload rules.
 */
import { createWebhookContext } from '@workflow/core';
import {
  type ChatPageConfig,
  type DataObject,
  type ExecutionMode,
  ExpressionEvaluator,
  type WebhookContext,
  type WebhookRequest,
  type WebhookResponseData,
  Workflow,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { ChatTriggerNode } from '../src/nodes/trigger/ChatTrigger.node';
import {
  chatOriginAllowed,
  chatResponse,
  handleChatSetup,
  MAX_CHAT_INPUT,
  MAX_SESSION_ID,
  readChatFiles,
} from '../src/nodes/trigger/chat-setup';
import { node, nodeTypes, services } from './harness';

/** a token store standing in for the server's HMAC tokens: the token is an index, the claims are kept */
function fakeTokens() {
  const issued: Array<{ payload: DataObject; ttl: number }> = [];
  return {
    issued,
    sign(payload: DataObject, ttl: number) {
      issued.push({ payload: { ...payload }, ttl });
      return `tok-${issued.length - 1}`;
    },
    verify(token: string): DataObject | null {
      const entry = /^tok-(\d+)$/.exec(token) ? issued[Number(token.slice(4))] : undefined;
      return entry ? { ...entry.payload } : null;
    },
  };
}

const tokens = fakeTokens();

function chatContext(
  parameters: DataObject,
  request: Partial<WebhookRequest>,
  options: { mode?: ExecutionMode; webhookName?: string; tenantId?: string } = {},
): WebhookContext {
  const trigger = node('Chat', 'ai.chatTrigger', parameters, { webhookId: 'hook-1' });
  const workflow = new Workflow({ id: 'wf-1', name: 'chat', nodes: [trigger], connections: {} }, nodeTypes);
  return createWebhookContext(
    {
      workflow,
      node: trigger,
      services: services({
        mode: options.mode ?? 'webhook',
        tenantId: options.tenantId ?? 't1',
        formTokens: tokens,
      }),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    },
    { method: 'POST', headers: {}, query: {}, params: {}, body: {}, ...request },
    options.webhookName ?? 'default',
  );
}

async function callWebhook(
  parameters: DataObject,
  request: Partial<WebhookRequest>,
  options: { mode?: ExecutionMode; webhookName?: string } = {},
): Promise<WebhookResponseData> {
  return ChatTriggerNode.webhook!(chatContext(parameters, request, options));
}

const file = (mimeType: string, fileName = 'a.txt') => ({
  fieldName: 'f',
  fileName,
  mimeType,
  data: new TextEncoder().encode('hi'),
});

const BLOB = /<script type="application\/json" id="chat-config">([^<]*)<\/script>/;
const pageConfigOf = (result: WebhookResponseData) =>
  JSON.parse(BLOB.exec(String(result.webhookResponse?.body))?.[1] ?? 'null') as ChatPageConfig;

const sign = (payload: DataObject) => tokens.sign(payload, 60);
const pageClaims = { kind: 'chat-page', tenantId: 't1', workflowId: 'wf-1', node: 'Chat' };
const testClaims = { kind: 'chat-test', tenantId: 't1', workflowId: 'wf-1', node: 'Chat', listenId: 'l1' };

describe('Chat setup: hosted page', () => {
  it('answers the hosted page through the node, uncached, with a signed page token', async () => {
    const before = tokens.issued.length;
    const result = await callWebhook(
      { public: true, initialMessages: 'Hi!\n\nAsk me anything.', options: { title: 'Support' } },
      { method: 'GET', url: '/webhook/acme/hook-1/chat?x=1' },
      { webhookName: 'setup' },
    );
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse?.statusCode).toBe(200);
    expect(result.webhookResponse?.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    expect(result.webhookResponse?.headers).not.toHaveProperty('set-cookie');
    const page = pageConfigOf(result);
    expect(page.webhookUrl).toBe('/webhook/acme/hook-1/chat');
    expect(page.initialMessages).toEqual(['Hi!', 'Ask me anything.']);
    expect(page.title).toBe('Support');
    // the token: kind, tenant, workflow and node for 60 minutes
    expect(tokens.issued.length).toBe(before + 1);
    expect(tokens.issued[before]).toEqual({ payload: pageClaims, ttl: 3600 });
    expect(tokens.verify(page.pageToken)).toEqual(pageClaims);
    expect(page).not.toHaveProperty('authToken');
  });

  it('reads every page field from the node options', async () => {
    const ctx = chatContext(
      {
        public: true,
        options: {
          title: 'T',
          subtitle: 'S',
          inputPlaceholder: 'P',
          getStarted: 'Go',
          showWelcomeScreen: true,
          loadPreviousSession: 'memory',
          allowFileUploads: true,
          allowedFilesMimeTypes: 'image/*',
          responseMode: 'streaming',
          customCss: '.chat-header{color:red}',
        },
      },
      { method: 'GET', url: '/webhook/acme/hook-1/chat' },
      { webhookName: 'setup' },
    );
    const page = pageConfigOf(await handleChatSetup(ctx, { authToken: 'auth-1' }));
    expect(page).toMatchObject({
      authToken: 'auth-1',
      title: 'T',
      subtitle: 'S',
      inputPlaceholder: 'P',
      getStarted: 'Go',
      initialMessages: ['Hi there!', 'How can I help you today?'],
      showWelcomeScreen: true,
      loadPreviousSession: true,
      allowFileUploads: true,
      allowedFilesMimeTypes: 'image/*',
      enableStreaming: true,
      customCss: '.chat-header{color:red}',
    });
  });

  it('uses the defaults when the options are empty', async () => {
    const ctx = chatContext({ public: true }, { method: 'GET', url: '/c' }, { webhookName: 'setup' });
    const page = pageConfigOf(await handleChatSetup(ctx, {}));
    expect(page).toMatchObject({
      title: 'Hi there!',
      subtitle: "Start a chat. We're here to help you 24/7.",
      inputPlaceholder: 'Type your question…',
      getStarted: 'New Conversation',
      showWelcomeScreen: false,
      loadPreviousSession: false,
      allowFileUploads: false,
      allowedFilesMimeTypes: '*',
      enableStreaming: false,
      customCss: '',
    });
    const notSupported = chatContext(
      { public: true, options: { loadPreviousSession: 'notSupported' } },
      { method: 'GET' },
      { webhookName: 'setup' },
    );
    expect(pageConfigOf(await handleChatSetup(notSupported, {})).loadPreviousSession).toBe(false);
  });

  it('has no page in embedded (webhook) mode', async () => {
    const result = await callWebhook(
      { public: true, mode: 'webhook' },
      { method: 'GET', headers: { origin: 'https://site.example' } },
      { webhookName: 'setup' },
    );
    expect(result.webhookResponse).toEqual({
      statusCode: 404,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': 'https://site.example',
        vary: 'Origin',
      },
      body: { message: 'This chat is not available' },
    });
  });

  it('chatResponse adds the Basic challenge on a 401 only', () => {
    expect(chatResponse(401, {}).webhookResponse?.headers?.['www-authenticate']).toBe('Basic realm="Chat"');
    expect(chatResponse(403, {}).webhookResponse?.headers?.['www-authenticate']).toBeUndefined();
  });
});

describe('chatOriginAllowed', () => {
  const ctx = chatContext({ public: true }, {});
  const withHeaders = (
    headers: Record<string, string>,
    options: { mode?: ExecutionMode; tenantId?: string } = {},
  ) => chatContext({ public: true }, { headers }, options);

  it('grants any origin for * or an empty list', () => {
    expect(chatOriginAllowed(ctx, '*', 'https://x.example')).toBe('https://x.example');
    expect(chatOriginAllowed(ctx, '*', undefined)).toBe('*');
    expect(chatOriginAllowed(ctx, ' , ', 'https://x.example')).toBe('https://x.example');
  });

  it('checks a list by scheme, host and port, ignoring case and trailing slashes', () => {
    const list = 'https://Shop.example.com/, https://help.example.com';
    expect(chatOriginAllowed(ctx, list, 'https://shop.example.com')).toBe('https://shop.example.com');
    expect(chatOriginAllowed(ctx, list, 'https://evil.example')).toBe(false);
    expect(chatOriginAllowed(ctx, list, 'http://help.example.com')).toBe(false);
    // server-to-server call without an Origin header
    expect(chatOriginAllowed(ctx, list, undefined)).toBeUndefined();
  });

  it('grants Origin null only with a valid page token of this tenant, workflow and node', () => {
    const list = 'https://shop.example.com';
    expect(chatOriginAllowed(ctx, list, 'null')).toBe(false);
    const page = { 'x-chat-page': sign(pageClaims) };
    expect(chatOriginAllowed(withHeaders(page), list, 'null')).toBe('null');
    expect(
      chatOriginAllowed(withHeaders({ 'x-chat-page': sign({ ...pageClaims, node: 'Other' }) }), list, 'null'),
    ).toBe(false);
    expect(chatOriginAllowed(withHeaders(page, { tenantId: 't2' }), list, 'null')).toBe(false);
    expect(
      chatOriginAllowed(
        withHeaders({ 'x-chat-page': sign({ ...pageClaims, workflowId: 'wf-2' }) }),
        list,
        'null',
      ),
    ).toBe(false);
    expect(
      chatOriginAllowed(
        withHeaders({ 'x-chat-page': sign({ ...pageClaims, kind: 'chat-test' }) }),
        list,
        'null',
      ),
    ).toBe(false);
    expect(chatOriginAllowed(withHeaders({ 'x-chat-page': 'forged' }), list, 'null')).toBe(false);
    // the page token grants the opaque origin only
    expect(chatOriginAllowed(withHeaders(page), list, 'https://evil.example')).toBe(false);
  });

  it('never trusts a bare null entry in the list; * answers an opaque origin with *', () => {
    expect(chatOriginAllowed(ctx, 'null', 'null')).toBe(false);
    expect(chatOriginAllowed(ctx, 'https://a.example, null', 'null')).toBe(false);
    expect(chatOriginAllowed(ctx, '*', 'null')).toBe('*');
  });

  it('grants the caller origin to a valid test token in a test run only', () => {
    const list = 'https://shop.example.com';
    const test = { 'x-chat-test-token': sign(testClaims) };
    expect(chatOriginAllowed(withHeaders(test, { mode: 'manual' }), list, 'https://editor.example')).toBe(
      'https://editor.example',
    );
    expect(chatOriginAllowed(withHeaders(test, { mode: 'webhook' }), list, 'https://editor.example')).toBe(
      false,
    );
    const pageAsTest = { 'x-chat-test-token': sign(pageClaims) };
    expect(
      chatOriginAllowed(withHeaders(pageAsTest, { mode: 'manual' }), list, 'https://editor.example'),
    ).toBe(false);
  });
});

describe('message limits and uploads', () => {
  it('keeps the limits', () => {
    expect(MAX_CHAT_INPUT).toBe(100_000);
    expect(MAX_SESSION_ID).toBe(200);
  });

  it('readChatFiles applies the upload rules with the same texts', async () => {
    const read = (options: DataObject, files: ReturnType<typeof file>[]) =>
      readChatFiles(chatContext({ public: true }, { files }), options);
    expect(await read({}, [])).toEqual({ binary: {} });
    expect(await read({}, [file('text/plain')])).toEqual({
      status: 400,
      message: 'File uploads are not allowed',
    });
    expect(
      await read({ allowFileUploads: true, allowedFilesMimeTypes: 'image/*' }, [file('text/plain')]),
    ).toEqual({ status: 415, message: 'Files of type "text/plain" are not allowed' });
    const accepted = await read({ allowFileUploads: true, allowedFilesMimeTypes: 'text/*, image/png' }, [
      file('text/plain'),
      file('IMAGE/PNG', 'b.png'),
    ]);
    expect('binary' in accepted && Object.keys(accepted.binary)).toEqual(['data0', 'data1']);
    expect('binary' in accepted && accepted.binary.data0).toMatchObject({
      mimeType: 'text/plain',
      fileName: 'a.txt',
    });
  });
});
