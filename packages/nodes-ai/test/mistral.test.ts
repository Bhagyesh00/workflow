/**
 * Phase 5 S1 P5-22: Mistral Cloud chat model and embeddings. Replies are fixtures written from the
 * Mistral API reference; they prove the request we send.
 */
import { createBaseContext, type ExecutionServices } from '@workflow/core';
import {
  type DataObject,
  ExpressionEvaluator,
  type LoadOptionsContext,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { connect, FakeHttpClient, node, nodeTypes, run, sequence, services } from './harness';

const CREDS = { mistralCloudApi: { apiKey: 'mistral-test-key' } };

const withCreds = (n: WorkflowNode): WorkflowNode => ({
  ...n,
  credentials: { mistralCloudApi: { id: 'cred-1', name: 'mistralCloudApi' } },
});

async function runAgent(http: FakeHttpClient, params: DataObject, stream = false) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', {
        promptType: 'define',
        text: 'What is 6 times 7?',
        systemMessage: 'You are a calculator assistant.',
        options: { enableStreaming: stream },
      }),
      withCreds(node('Mistral', 'ai.lmChatMistralCloud', params)),
    ],
    connect(['Trigger', 'Agent'], ['Mistral', 'Agent', 'ai_languageModel']),
    { services: services({ creds: CREDS, http }) },
  );
}

const completion = (content: unknown): { body: unknown } => ({
  body: {
    id: 'cmpl-1',
    model: 'mistral-small-latest',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  },
});

const sse = (...chunks: unknown[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;

function loadOptionsContext(type: string, svc: ExecutionServices): LoadOptionsContext {
  const n = withCreds(node('Node', type));
  const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, nodeTypes);
  const base = createBaseContext({
    workflow,
    node: n,
    services: svc,
    evaluator: new ExpressionEvaluator(),
    signal: new AbortController().signal,
  });
  const { getNodeParameter: _omit, ...rest } = base;
  return { ...rest, getCurrentNodeParameter: () => undefined };
}

describe('Mistral Cloud chat model', () => {
  it('sends a chat completions request with safe prompt, seed and no stream_options', async () => {
    const http = new FakeHttpClient(sequence(completion('42')));
    const r = await runAgent(http, {
      model: 'mistral-large-latest',
      options: { maxTokens: 300, temperature: 0.2, topP: 0.9, safeMode: true, randomSeed: 7 },
    });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: '42' }]);
    const [req] = http.requests;
    expect(req.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(req.headers?.authorization).toBe('Bearer mistral-test-key');
    expect(req.body).toMatchObject({
      model: 'mistral-large-latest',
      max_tokens: 300,
      temperature: 0.2,
      top_p: 0.9,
      safe_prompt: true,
      random_seed: 7,
      messages: [
        { role: 'system', content: 'You are a calculator assistant.' },
        { role: 'user', content: 'What is 6 times 7?' },
      ],
    });
    expect(Object.keys(req.body as object)).not.toContain('stream_options');
    expect(Object.keys(req.body as object)).not.toContain('max_completion_tokens');
    expect(JSON.stringify(req.headers)).not.toMatch(/openai-platform|n8n/i);
  });

  it('leaves safe_prompt and random_seed out when the options are not set', async () => {
    const http = new FakeHttpClient(sequence(completion('42')));
    await runAgent(http, { model: 'mistral-small-latest' });
    const body = http.bodies[0] as DataObject;
    expect(body.safe_prompt).toBeUndefined();
    expect(body.random_seed).toBeUndefined();
    expect(body.model).toBe('mistral-small-latest');
  });

  it('gives the answer of a Magistral reply whose content is an array with thinking blocks', async () => {
    const http = new FakeHttpClient(
      sequence(
        completion([
          { type: 'thinking', thinking: [{ type: 'text', text: 'Six times seven...' }] },
          { type: 'text', text: 'The answer ' },
          { type: 'text', text: 'is 42.' },
        ]),
      ),
    );
    const r = await runAgent(http, { model: 'magistral-medium-latest' });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'The answer is 42.' }]);
  });

  it('streams without stream_options and skips thinking chunks', async () => {
    const body = sse(
      {
        model: 'magistral-small-latest',
        choices: [{ delta: { content: [{ type: 'thinking', thinking: [] }] } }],
      },
      { choices: [{ delta: { content: [{ type: 'text', text: 'It is ' }] } }] },
      {
        choices: [{ delta: { content: '42.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
    );
    const http = new FakeHttpClient(sequence({ body }));
    const r = await runAgent(http, { model: 'magistral-small-latest' }, true);
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'It is 42.' }]);
    const sent = http.bodies[0] as DataObject;
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toBeUndefined();
    expect(http.requests[0].headers?.accept).toBe('text/event-stream');
  });

  it('lists chat models only: embedding, moderation and OCR models are left out', async () => {
    const http = new FakeHttpClient(() => ({
      body: {
        data: [
          { id: 'mistral-large-latest', capabilities: { completion_chat: true } },
          { id: 'mistral-embed', capabilities: { completion_chat: false } },
          { id: 'codestral-embed', capabilities: { completion_chat: false } },
          { id: 'mistral-moderation-latest' },
          { id: 'mistral-ocr-latest' },
          { id: 'magistral-medium-latest', capabilities: { completion_chat: true } },
          { id: 'tool-less-model', capabilities: { completion_chat: false } },
        ],
      },
    }));
    const type = nodeTypes.get('ai.lmChatMistralCloud')!;
    const ctx = loadOptionsContext('ai.lmChatMistralCloud', services({ creds: CREDS, http }));
    expect(await type.methods!.loadOptions!.listModels(ctx)).toEqual([
      { name: 'magistral-medium-latest', value: 'magistral-medium-latest' },
      { name: 'mistral-large-latest', value: 'mistral-large-latest' },
    ]);
    expect(http.requests[0].url).toBe('https://api.mistral.ai/v1/models');
    expect(http.requests[0].headers?.authorization).toBe('Bearer mistral-test-key');
  });
});

describe('Embeddings Mistral Cloud', () => {
  const embeddingsFor = async (http: FakeHttpClient, params: DataObject) => {
    const type = nodeTypes.get('ai.embeddingsMistralCloud')!;
    const n = withCreds(node('Emb', 'ai.embeddingsMistralCloud', params));
    const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, nodeTypes);
    const base = createBaseContext({
      workflow,
      node: n,
      services: services({ creds: CREDS, http }),
      evaluator: new ExpressionEvaluator(),
      signal: new AbortController().signal,
    });
    const logs: unknown[] = [];
    const ctx = {
      ...base,
      getInputData: () => [],
      getInputConnectionData: async () => undefined,
      runCode: async () => [],
      executeWorkflow: async () => ({ executionId: '', data: null }),
      getToolParameter: () => undefined,
      logSubNodeRun: (input: DataObject, output: DataObject) => void logs.push({ input, output }),
    };
    const { response } = await type.supplyData!(ctx, 0);
    return response as {
      embedDocuments(t: string[]): Promise<number[][]>;
      embedQuery(t: string): Promise<number[]>;
    };
  };

  it('uses mistral-embed by default and keeps the result order', async () => {
    const http = new FakeHttpClient((req) => {
      const input = (req.body as { input: string[] }).input;
      return { body: { data: input.map((t, index) => ({ index, embedding: [t.length] })).reverse() } };
    });
    const embeddings = await embeddingsFor(http, {});
    expect(await embeddings.embedDocuments(['a', 'bb', 'ccc'])).toEqual([[1], [2], [3]]);
    expect(http.requests[0].url).toBe('https://api.mistral.ai/v1/embeddings');
    expect(http.requests[0].headers?.authorization).toBe('Bearer mistral-test-key');
    expect(http.bodies[0]).toEqual({ model: 'mistral-embed', input: ['a', 'bb', 'ccc'] });
  });

  it('batches by 512 texts', async () => {
    const http = new FakeHttpClient((req) => ({
      body: {
        data: (req.body as { input: string[] }).input.map((_t, index) => ({ index, embedding: [1, 2] })),
      },
    }));
    const embeddings = await embeddingsFor(http, {});
    const texts = Array.from({ length: 1100 }, (_v, i) => `t${i}`);
    const vectors = await embeddings.embedDocuments(texts);
    expect(vectors).toHaveLength(1100);
    expect(http.bodies.map((b) => b.input.length)).toEqual([512, 512, 76]);
  });

  it('caps the batch size at 512 and uses the chosen model', async () => {
    const http = new FakeHttpClient((req) => ({
      body: { data: (req.body as { input: string[] }).input.map((_t, index) => ({ index, embedding: [0] })) },
    }));
    const embeddings = await embeddingsFor(http, { model: 'codestral-embed', options: { batchSize: 5000 } });
    await embeddings.embedDocuments(Array.from({ length: 600 }, (_v, i) => String(i)));
    expect(http.bodies.map((b) => b.input.length)).toEqual([512, 88]);
    expect(http.bodies[0].model).toBe('codestral-embed');
  });

  it('lists only the embedding models', async () => {
    const http = new FakeHttpClient(() => ({
      body: { data: [{ id: 'mistral-large-latest' }, { id: 'mistral-embed' }, { id: 'codestral-embed' }] },
    }));
    const type = nodeTypes.get('ai.embeddingsMistralCloud')!;
    const ctx = loadOptionsContext('ai.embeddingsMistralCloud', services({ creds: CREDS, http }));
    expect(await type.methods!.loadOptions!.listModels(ctx)).toEqual([
      { name: 'codestral-embed', value: 'codestral-embed' },
      { name: 'mistral-embed', value: 'mistral-embed' },
    ]);
  });
});
