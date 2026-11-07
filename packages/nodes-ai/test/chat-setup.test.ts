/**
 * The Chat Trigger's shared surface (chat-setup.ts): the setup GET, the Origin rule, the limits and the
 * upload rules, as C0 moved them out of ChatTrigger.node.ts. Lane L2 extends this file for the hosted page.
 */
import { createWebhookContext } from '@workflow/core';
import {
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

function chatContext(
  parameters: DataObject,
  request: Partial<WebhookRequest>,
  options: { mode?: ExecutionMode; webhookName?: string } = {},
): WebhookContext {
  const trigger = node('Chat', 'ai.chatTrigger', parameters, { webhookId: 'hook-1' });
  const workflow = new Workflow({ name: 'chat', nodes: [trigger], connections: {} }, nodeTypes);
  return createWebhookContext(
    {
      workflow,
      node: trigger,
      services: services({ mode: options.mode ?? 'webhook' }),
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

describe('Chat setup', () => {
  it('serves the chat setup with initial messages', async () => {
    const result = await callWebhook(
      {
        public: true,
        initialMessages: 'Hi!\n\nAsk me anything.',
        options: { title: 'Support', responseMode: 'streaming' },
      },
      { method: 'GET', headers: { origin: 'https://site.example' } },
      { webhookName: 'setup' },
    );
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse).toMatchObject({
      statusCode: 200,
      headers: { 'access-control-allow-origin': 'https://site.example' },
      body: { initialMessages: ['Hi!', 'Ask me anything.'], title: 'Support', responseMode: 'streaming' },
    });
  });

  it('handleChatSetup answers the defaults and grants only the origin it is given', async () => {
    const ctx = chatContext({ public: true }, { method: 'GET' }, { webhookName: 'setup' });
    const open = await handleChatSetup(ctx, {});
    expect(open.webhookResponse).toEqual({
      statusCode: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: {
        initialMessages: ['Hi there!', 'How can I help you today?'],
        title: 'Hi there!',
        subtitle: '',
        inputPlaceholder: '',
        allowFileUploads: false,
        responseMode: 'lastNode',
      },
    });
    const granted = await handleChatSetup(ctx, { corsOrigin: 'https://a.example' });
    expect(granted.webhookResponse?.headers).toMatchObject({
      'access-control-allow-origin': 'https://a.example',
      vary: 'Origin',
    });
  });

  it('chatResponse adds the Basic challenge on a 401 only', () => {
    expect(chatResponse(401, {}).webhookResponse?.headers?.['www-authenticate']).toBe('Basic realm="Chat"');
    expect(chatResponse(403, {}).webhookResponse?.headers?.['www-authenticate']).toBeUndefined();
  });
});

describe('chatOriginAllowed', () => {
  const ctx = chatContext({ public: true }, {});

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
