import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';
import { nodesAiPackage } from '@workflow/nodes-ai';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { AiChatResponse, DataObject, NodePackage, WorkflowNode } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createContext, type ServerContext } from '../src/context';
import { createWorkflow, node, resetDatabase, setNode, signup, testConfig, testPackage } from './helpers';

/** a chat model that answers with its `text` parameter, word by word when `streaming` is on */
const modelPackage: NodePackage = {
  name: 'chat-streaming-tests',
  credentials: [],
  nodes: [
    {
      description: {
        name: 'test.scriptedChatModel',
        displayName: 'Scripted Chat Model',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Model' },
        inputs: [],
        outputs: ['ai_languageModel'],
        properties: [
          { displayName: 'Text', name: 'text', type: 'string', default: 'Hello' },
          { displayName: 'Streaming', name: 'streaming', type: 'boolean', default: false },
          { displayName: 'Fail', name: 'fail', type: 'boolean', default: false },
          { displayName: 'Hang', name: 'hang', type: 'boolean', default: false },
        ],
      },
      async supplyData(ctx, itemIndex) {
        const text = String(ctx.getNodeParameter('text', itemIndex, 'Hello'));
        const fail = Boolean(ctx.getNodeParameter('fail', itemIndex, false));
        const hang = Boolean(ctx.getNodeParameter('hang', itemIndex, false));
        const chat = async (): Promise<AiChatResponse> => {
          if (fail) throw new Error('The model is down');
          return { message: { role: 'assistant', content: text }, stopReason: 'stop' };
        };
        return {
          response: {
            kind: 'chatModel',
            provider: 'test',
            model: 'scripted',
            chat,
            ...(ctx.getNodeParameter('streaming', itemIndex, false)
              ? {
                  async stream(request: { signal?: AbortSignal }, onDelta: (delta: string) => void) {
                    const response = await chat();
                    const words = text.split(/(?<= )/);
                    onDelta(words[0]);
                    // a hanging model sends its first word and then waits until the run is stopped
                    if (hang) {
                      await new Promise((_resolve, reject) => {
                        const { signal } = request;
                        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
                      });
                    }
                    for (const word of words.slice(1)) onDelta(word);
                    return response;
                  },
                }
              : {}),
          },
        };
      },
    },
  ],
};

let ctx: ServerContext;
let app: FastifyInstance;
let dir: string;
let baseUrl: string;

beforeAll(async () => {
  // a small body limit keeps the oversized-body test cheap
  const config = testConfig({ BODY_LIMIT_MB: '1' });
  dir = config.binaryData.dir;
  ctx = await createContext({
    config,
    nodePackages: [nodesBasePackage, testPackage, nodesAiPackage, modelPackage],
    http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] } }),
  });
  await resetDatabase(ctx);
  app = await buildApp(ctx);
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await ctx.startMain();
});
afterAll(async () => {
  await app.close();
  await ctx.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDatabase(ctx);
});

const WIDGET = 'https://shop.example.com';

const chatTrigger = (options: DataObject) =>
  node('Chat', 'ai.chatTrigger', { public: true, options }, [0, 0], { webhookId: 'chat-id' });

function link(from: string, to: string, type = 'main') {
  return { [from]: { [type]: [[{ node: to, type, index: 0 }]] } };
}

async function chatWorkflow(nodes: WorkflowNode[], connections: Record<string, unknown>) {
  const { client, tenant } = await signup(app);
  const wf = await createWorkflow(client, { nodes, connections } as never);
  const activated = await client.post(`/rest/workflows/${wf.id}/activate`);
  expect(activated.statusCode, activated.body).toBe(200);
  return { url: `/webhook/${tenant.slug}/chat-id/chat`, tenant, client, workflowId: wf.id as string };
}

async function agentChat(options: DataObject, model: DataObject, agent: DataObject = {}) {
  return chatWorkflow(
    [chatTrigger(options), node('Agent', 'ai.agent', agent, [200, 0]), node('Model', 'test.scriptedChatModel', model)],
    { ...link('Chat', 'Agent'), ...link('Model', 'Agent', 'ai_languageModel') },
  );
}

const lines = (body: string) =>
  body
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as DataObject);

const send = (url: string) =>
  app.inject({ method: 'POST', url, headers: { origin: WIDGET }, payload: { sessionId: 's1', chatInput: 'Hi' } });

function expectSandboxed(headers: Record<string, unknown>) {
  expect(headers['content-security-policy']).toMatch(/^sandbox /);
  expect(headers['x-content-type-options']).toBe('nosniff');
}

describe('chat streaming protocol', () => {
  it('writes each agent delta as one item line with text content, then one end line', async () => {
    const { url } = await agentChat({ responseMode: 'streaming' }, { text: 'Streaming works fine', streaming: true });
    const res = await send(url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(lines(res.body)).toEqual([
      { type: 'item', content: 'Streaming ' },
      { type: 'item', content: 'works ' },
      { type: 'item', content: 'fine' },
      { type: 'end' },
    ]);
  });

  it('delivers the answer of a model that cannot stream', async () => {
    const { url } = await agentChat({ responseMode: 'streaming' }, { text: 'The answer is 42' });
    const res = await send(url);
    expect(lines(res.body)).toEqual([{ type: 'item', content: 'The answer is 42' }, { type: 'end' }]);
  });

  it('delivers the answer of an agent with streaming turned off', async () => {
    const { url } = await agentChat(
      { responseMode: 'streaming' },
      { text: 'Quiet answer', streaming: true },
      { options: { enableStreaming: false } },
    );
    const res = await send(url);
    expect(lines(res.body)).toEqual([{ type: 'item', content: 'Quiet answer' }, { type: 'end' }]);
  });

  it('delivers the last node output when no node streamed', async () => {
    const { url } = await chatWorkflow(
      [chatTrigger({ responseMode: 'streaming' }), setNode('Set', 'total', 7)],
      link('Chat', 'Set'),
    );
    const res = await send(url);
    const [first, last] = lines(res.body);
    expect(first.type).toBe('item');
    expect(first.content).toMatchObject({ total: 7 });
    expect(last).toEqual({ type: 'end' });
  });

  it('stops the run when the client closes the stream before the answer ends', async () => {
    const { url, client, workflowId } = await agentChat(
      { responseMode: 'streaming' },
      { text: 'First word never followed', streaming: true, hang: true },
    );
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}${url}`, {
      method: 'POST',
      headers: { origin: WIDGET, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', chatInput: 'Hi' }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('First ');
    controller.abort();

    let status: string | undefined;
    for (let i = 0; i < 100 && status !== 'canceled'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const list = await client.data(client.get(`/rest/executions?workflowId=${workflowId}`));
      status = list[0]?.status;
    }
    expect(status).toBe('canceled');
  });

  it('ends with an error line when the workflow fails', async () => {
    const { url } = await agentChat({ responseMode: 'streaming' }, { fail: true });
    const res = await send(url);
    expect(lines(res.body)).toEqual([{ type: 'error', message: 'Error in workflow' }]);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('chat CORS', () => {
  it('answers a streaming chat with the allowed origin and the sandbox headers', async () => {
    const { url } = await agentChat(
      { responseMode: 'streaming', allowedOrigins: WIDGET },
      { text: 'ok', streaming: true },
    );
    const res = await send(url);
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET);
    expect(String(res.headers.vary)).toContain('Origin');
    expectSandboxed(res.headers);
  });

  it('matches allowed origins written with a trailing slash or another case', async () => {
    const { url } = await agentChat(
      { allowedOrigins: 'https://Shop.Example.com/, https://other.example.com' },
      { text: 'ok' },
    );
    const res = await send(url);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ output: 'ok' });
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET);
  });

  it('adds CORS headers to server errors for the chat', async () => {
    const { url } = await agentChat({ allowedOrigins: WIDGET }, { fail: true });
    const failed = await send(url);
    expect(failed.statusCode).toBe(500);
    expect(failed.headers['access-control-allow-origin']).toBe(WIDGET);
    expectSandboxed(failed.headers);

    const malformed = await app.inject({
      method: 'POST',
      url,
      headers: { origin: WIDGET, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('bad_request');
    expect(malformed.headers['access-control-allow-origin']).toBe(WIDGET);
    expectSandboxed(malformed.headers);
  });

  it('adds CORS headers to a body larger than the limit', async () => {
    const { url } = await agentChat({ allowedOrigins: WIDGET }, { text: 'ok' });
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { origin: WIDGET, 'content-type': 'application/json' },
      payload: JSON.stringify({ sessionId: 's1', chatInput: 'x'.repeat(ctx.config.bodyLimitBytes) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('payload_too_large');
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET);
    expectSandboxed(res.headers);
  });

  it('evaluates allowed origins written as an expression, for the preflight and the answer', async () => {
    const { url, client } = await agentChat({ allowedOrigins: '={{ $vars.CHAT_ORIGINS }}' }, { text: 'ok' });
    await client.data(client.post('/rest/variables', { key: 'CHAT_ORIGINS', value: `${WIDGET}/` }));
    const preflight = await app.inject({
      method: 'OPTIONS',
      url,
      headers: { origin: WIDGET, 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(WIDGET);

    const res = await send(url);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ output: 'ok' });
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET);

    const denied = await app.inject({
      method: 'OPTIONS',
      url,
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers the preflight with the node origin and lists the requested headers, Authorization included', async () => {
    const { url } = await agentChat({ allowedOrigins: `${WIDGET}/` }, { text: 'ok' });
    const res = await app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: WIDGET,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    const allowed = String(res.headers['access-control-allow-headers']).split(/,\s*/);
    expect(allowed).toEqual(expect.arrayContaining(['authorization', 'content-type']));
    expect(allowed).not.toContain('*');
    expect(String(res.headers.vary)).toMatch(/Origin/);
    expect(String(res.headers.vary)).toMatch(/Access-Control-Request-Headers/);
    expectSandboxed(res.headers);
  });

  it('gives no CORS grant to a preflight from an origin that is not allowed', async () => {
    const { url } = await agentChat({ allowedOrigins: WIDGET }, { text: 'ok' });
    const res = await app.inject({
      method: 'OPTIONS',
      url,
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('drops invalid header names from the preflight answer', async () => {
    const { url } = await agentChat({}, { text: 'ok' });
    const res = await app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: WIDGET,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-ok, bad header',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toBe('x-ok');
  });
});
