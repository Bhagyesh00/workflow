/**
 * P5-57 against the real app on an ephemeral port: a Simple Memory node wired to both the Agent and the Chat
 * Trigger. Two messages, then `loadPreviousSession` answers them in order from the memory the Agent wrote;
 * a long message with Auto-save Highlighted Data is kept in the run's custom data, capped at 255.
 */
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';
import { nodesAiPackage } from '@workflow/nodes-ai';
import { nodesBasePackage } from '@workflow/nodes-base';
import {
  type AiChatRequest,
  type AiChatResponse,
  type DataObject,
  HIGHLIGHTED_SESSION_KEY,
  highlightedInputKey,
  type NodePackage,
  type WorkflowNode,
} from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createContext, type ServerContext } from '../src/context';
import { createWorkflow, node, resetDatabase, signup, testConfig, testPackage } from './helpers';

/** the model the Agent talks to: it answers `Pong` and records every request */
const requests: AiChatRequest[] = [];
const modelPackage: NodePackage = {
  name: 'chat-reload-tests',
  credentials: [],
  nodes: [
    {
      description: {
        name: 'test.reloadChatModel',
        displayName: 'Scripted Chat Model',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Model' },
        inputs: [],
        outputs: ['ai_languageModel'],
        properties: [],
      },
      async supplyData() {
        return {
          response: {
            kind: 'chatModel',
            provider: 'test',
            model: 'scripted',
            async chat(request: AiChatRequest): Promise<AiChatResponse> {
              requests.push(request);
              return { message: { role: 'assistant', content: 'Pong' }, stopReason: 'end' };
            },
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
  const config = testConfig();
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
  requests.length = 0;
});

const edge = (node: string, type: string, index = 0) => ({ node, type, index });

/** Chat -> Agent <- Model; one Simple Memory wired to both the Agent and the Chat Trigger */
async function reloadChat(options: DataObject, wireTrigger = true) {
  const { client, tenant } = await signup(app);
  const nodes: WorkflowNode[] = [
    node('Chat', 'ai.chatTrigger', { public: true, options }, [0, 0], { webhookId: 'chat-id' }),
    node('Agent', 'ai.agent', {}, [200, 0]),
    node('Model', 'test.reloadChatModel', {}, [200, 200]),
    node('Memory', 'ai.memoryBufferWindow', {}, [400, 200]),
  ];
  const wf = await createWorkflow(client, {
    nodes,
    connections: {
      Chat: { main: [[edge('Agent', 'main')]] },
      Model: { ai_languageModel: [[edge('Agent', 'ai_languageModel')]] },
      Memory: {
        ai_memory: [[edge('Agent', 'ai_memory'), ...(wireTrigger ? [edge('Chat', 'ai_memory')] : [])]],
      },
    },
  } as never);
  const activated = await client.post(`/rest/workflows/${wf.id}/activate`);
  expect(activated.statusCode, activated.body).toBe(200);
  return { client, workflowId: wf.id as string, url: `${baseUrl}/webhook/${tenant.slug}/chat-id/chat` };
}

const send = (url: string, body: DataObject) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface History {
  data: Array<{ id: string[]; kwargs: { content: string } }>;
}
const shape = (history: History) => history.data.map((m) => [m.id.at(-1), m.kwargs.content]);

describe('loadPreviousSession from memory', () => {
  it('returns the two messages and their answers in order', async () => {
    const { url } = await reloadChat({ loadPreviousSession: 'memory' });
    const first = await send(url, { sessionId: 's1', chatInput: 'first question' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ output: 'Pong' });
    expect((await send(url, { sessionId: 's1', chatInput: 'second question' })).status).toBe(200);

    const res = await send(url, { sessionId: 's1', action: 'loadPreviousSession' });
    expect(res.status).toBe(200);
    expect(shape((await res.json()) as History)).toEqual([
      ['HumanMessage', 'first question'],
      ['AIMessage', 'Pong'],
      ['HumanMessage', 'second question'],
      ['AIMessage', 'Pong'],
    ]);
    // no model call and no run for the load
    expect(requests).toHaveLength(2);
  });

  it('keeps each session apart and answers an empty list for a new one', async () => {
    const { url } = await reloadChat({ loadPreviousSession: 'memory' });
    await send(url, { sessionId: 's1', chatInput: 'mine' });
    const other = await send(url, { sessionId: 's2', action: 'loadPreviousSession' });
    expect(await other.json()).toEqual({ data: [] });
  });

  it('answers an empty list when the trigger has no memory wired', async () => {
    const { url } = await reloadChat({ loadPreviousSession: 'memory' }, false);
    await send(url, { sessionId: 's1', chatInput: 'mine' });
    const res = await send(url, { sessionId: 's1', action: 'loadPreviousSession' });
    expect(await res.json()).toEqual({ data: [] });
  });

  it('answers an empty list when it is off', async () => {
    const { url } = await reloadChat({});
    await send(url, { sessionId: 's1', chatInput: 'mine' });
    const res = await send(url, { sessionId: 's1', action: 'loadPreviousSession' });
    expect(await res.json()).toEqual({ data: [] });
  });
});

describe('Auto-save Highlighted Data', () => {
  it('stores the message and the session id as custom data by default, capped at 255 (n8n: on unless off)', async () => {
    const { client, workflowId, url } = await reloadChat({});
    const long = 'x'.repeat(1000);
    expect((await send(url, { sessionId: 's1', chatInput: long })).status).toBe(200);
    const [row] = (await client.data(client.get(`/rest/executions?workflowId=${workflowId}`))) as Array<{
      id: string;
    }>;
    const detail = await client.data<{ customData: Record<string, string> }>(
      client.get(`/rest/executions/${row.id}`),
    );
    expect(detail.customData[highlightedInputKey('Chat')]).toBe('x'.repeat(255));
    expect(detail.customData[HIGHLIGHTED_SESSION_KEY]).toBe('s1');
  });

  it('stores nothing when it is off', async () => {
    const { client, workflowId, url } = await reloadChat({ autoSaveHighlightedData: false });
    expect((await send(url, { sessionId: 's1', chatInput: 'hello' })).status).toBe(200);
    const [row] = (await client.data(client.get(`/rest/executions?workflowId=${workflowId}`))) as Array<{
      id: string;
    }>;
    const detail = await client.data<{ customData: Record<string, string> }>(
      client.get(`/rest/executions/${row.id}`),
    );
    // the trigger saves neither the message nor the session id (the Agent keeps its own response key)
    expect(Object.keys(detail.customData)).not.toContain(highlightedInputKey('Chat'));
    expect(Object.keys(detail.customData)).not.toContain(HIGHLIGHTED_SESSION_KEY);
  });
});
