import { createWebhookContext, type ExecutionServices } from '@workflow/core';
import {
  type DataObject,
  type ExecutionMode,
  ExpressionEvaluator,
  type WebhookRequest,
  type WebhookResponseData,
  Workflow,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { ChatTriggerNode } from '../src/nodes/trigger/ChatTrigger.node';
import { connect, node, nodeTypes, run, scriptModel, services } from './harness';

async function callWebhook(
  parameters: DataObject,
  request: Partial<WebhookRequest>,
  options: {
    mode?: ExecutionMode;
    webhookName?: string;
    creds?: Record<string, DataObject>;
    formTokens?: ExecutionServices['formTokens'];
  } = {},
): Promise<WebhookResponseData> {
  const trigger = node('Chat', 'ai.chatTrigger', parameters, {
    webhookId: 'hook-1',
    credentials: { httpBasicAuth: { id: 'b', name: 'b' } },
  });
  const workflow = new Workflow({ name: 'chat', nodes: [trigger], connections: {} }, nodeTypes);
  const svc: ExecutionServices = services({
    creds: options.creds,
    mode: options.mode ?? 'webhook',
    formTokens: options.formTokens,
  });
  const ctx = createWebhookContext(
    {
      workflow,
      node: trigger,
      services: svc,
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    },
    { method: 'POST', headers: {}, query: {}, params: {}, body: {}, ...request },
    options.webhookName ?? 'default',
  );
  return ChatTriggerNode.webhook!(ctx);
}

const message = { sessionId: 'abc', chatInput: 'Hello bot' };

/** tokens the way the host signs them: readable payloads, no secret */
const formTokens: ExecutionServices['formTokens'] = {
  sign: (payload) => `tok:${JSON.stringify(payload)}`,
  verify: (token) => (token.startsWith('tok:') ? (JSON.parse(token.slice(4)) as DataObject) : null),
};
/** the test token the editor's listen route hands a non-public chat (tenant t1, no workflow id, node Chat) */
const testToken = formTokens.sign({ kind: 'chat-test', tenantId: 't1', workflowId: '', node: 'Chat' }, 60);

describe('Chat Trigger', () => {
  it('declares a POST webhook and a GET setup endpoint', () => {
    expect(ChatTriggerNode.description.webhooks?.map((w) => [w.name, w.httpMethod, w.path])).toEqual([
      ['default', 'POST', 'chat'],
      ['setup', 'GET', 'chat'],
    ]);
  });

  it('offers the hosted and embedded modes and four response modes', () => {
    const properties = ChatTriggerNode.description.properties;
    const values = (p: { options?: unknown[] } | undefined) =>
      (p?.options ?? []).map((o) => (o as { value: unknown }).value);
    const mode = properties.find((p) => p.name === 'mode');
    expect(mode).toMatchObject({ default: 'hostedChat', displayOptions: { show: { public: [true] } } });
    expect(values(mode)).toEqual(['hostedChat', 'webhook']);
    const options = properties.find((p) => p.name === 'options');
    const responseMode = ((options?.options ?? []) as Array<{ name: string; options?: unknown[] }>).find(
      (o) => o.name === 'responseMode',
    );
    expect(values(responseMode)).toEqual(['lastNode', 'streaming', 'responseNode', 'responseNodes']);
  });

  it('starts the workflow with one sendMessage item', async () => {
    const result = await callWebhook(
      { public: true },
      { body: { ...message, metadata: { page: '/pricing' } } },
    );
    expect(result.workflowData).toEqual([
      [
        {
          json: {
            sessionId: 'abc',
            action: 'sendMessage',
            chatInput: 'Hello bot',
            metadata: { page: '/pricing' },
          },
        },
      ],
    ]);
  });

  it('accepts test messages from the editor when the chat is not public', async () => {
    const withToken = { body: message, headers: { 'x-chat-test-token': testToken } };
    expect((await callWebhook({}, withToken, { mode: 'manual', formTokens })).workflowData).toBeDefined();
    const closed = await callWebhook({}, withToken, { mode: 'webhook', formTokens });
    expect(closed.workflowData).toBeUndefined();
    expect(closed.webhookResponse?.statusCode).toBe(404);
    // a test run needs its token too: without it the chat is closed
    const bare = await callWebhook({}, { body: message }, { mode: 'manual', formTokens });
    expect(bare.webhookResponse?.statusCode).toBe(404);
  });

  it('validates the body strictly', async () => {
    const status = async (body: unknown) =>
      (await callWebhook({ public: true }, { body })).webhookResponse?.statusCode ?? 200;
    expect(await status('text')).toBe(400);
    expect(await status({ chatInput: 'x' })).toBe(400);
    expect(await status({ sessionId: 's', chatInput: '' })).toBe(400);
    expect(await status({ sessionId: 'x'.repeat(201), chatInput: 'hi' })).toBe(400);
    expect(await status({ sessionId: 's', chatInput: 'x'.repeat(100_001) })).toBe(413);
    expect(await status({ sessionId: 's', chatInput: 'hi', metadata: 'nope' })).toBe(400);
    expect(await status({ sessionId: 's', chatInput: 'hi', action: 'deleteEverything' })).toBe(400);
    expect(await status({ ...message, action: 'sendMessage' })).toBe(200);
  });

  it('enforces basic auth with constant-time comparison', async () => {
    const creds = { httpBasicAuth: { user: 'ada', password: 's3cret' } };
    const params = { public: true, authentication: 'basicAuth' };
    const basic = (v: string) => `Basic ${Buffer.from(v).toString('base64')}`;
    const denied = await callWebhook(
      params,
      { body: message, headers: { authorization: basic('ada:wrong') } },
      { creds },
    );
    expect(denied.webhookResponse?.statusCode).toBe(403);
    expect(denied.webhookResponse?.body).toEqual({ message: 'Authorization data is wrong!' });
    const missing = await callWebhook(params, { body: message }, { creds });
    expect(missing.webhookResponse?.statusCode).toBe(401);
    expect(missing.webhookResponse?.headers?.['www-authenticate']).toContain('Basic');
    expect(missing.webhookResponse?.body).toEqual({ message: 'Authorization is required!' });
    const ok = await callWebhook(
      params,
      { body: message, headers: { authorization: basic('ada:s3cret') } },
      { creds },
    );
    expect(ok.workflowData).toBeDefined();
  });

  it('checks the Origin against the allow-list', async () => {
    const params = {
      public: true,
      options: { allowedOrigins: 'https://shop.example.com, https://help.example.com' },
    };
    const blocked = await callWebhook(params, { body: message, headers: { origin: 'https://evil.example' } });
    expect(blocked.webhookResponse?.statusCode).toBe(403);
    const allowed = await callWebhook(params, {
      body: message,
      headers: { origin: 'https://help.example.com' },
    });
    expect(allowed.workflowData).toBeDefined();
    // no Origin header: server-to-server call
    expect((await callWebhook(params, { body: message })).workflowData).toBeDefined();
  });

  it('attaches uploaded files when allowed', async () => {
    const files = [
      { fieldName: 'f', fileName: 'a.txt', mimeType: 'text/plain', data: new TextEncoder().encode('hi') },
    ];
    const refused = await callWebhook({ public: true }, { body: message, files });
    expect(refused.webhookResponse?.statusCode).toBe(400);
    const wrongType = await callWebhook(
      { public: true, options: { allowFileUploads: true, allowedFilesMimeTypes: 'image/*' } },
      { body: message, files },
    );
    expect(wrongType.webhookResponse?.statusCode).toBe(415);
    const accepted = await callWebhook(
      { public: true, options: { allowFileUploads: true, allowedFilesMimeTypes: 'text/*' } },
      { body: message, files },
    );
    expect(accepted.workflowData?.[0][0].binary?.data0).toMatchObject({
      mimeType: 'text/plain',
      fileName: 'a.txt',
    });
  });

  it('passes its item to the agent when the workflow runs', async () => {
    scriptModel('Model', ['Hi! How can I help?']);
    const r = await run(
      [node('Chat', 'ai.chatTrigger'), node('Agent', 'ai.agent'), node('Model', 'test.fakeChatModel')],
      connect(['Chat', 'Agent'], ['Model', 'Agent', 'ai_languageModel']),
      { triggerItems: [{ json: { ...message, action: 'sendMessage' } }] },
    );
    expect(r.output('Chat')).toEqual([{ ...message, action: 'sendMessage' }]);
    expect(r.output('Agent')).toEqual([{ output: 'Hi! How can I help?' }]);
  });
});
