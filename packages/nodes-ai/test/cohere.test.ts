/**
 * Phase 5 S1 P5-24: Cohere chat model and embeddings. Replies are fixtures written from the Cohere
 * v2 API reference; they prove the request we send.
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
import { cohereAdapter } from '../src/providers/cohere';
import { connect, FakeHttpClient, node, nodeTypes, run, sequence, services } from './harness';

const CREDS = { cohereApi: { apiKey: 'cohere-test-key', url: 'https://api.cohere.ai' } };

const withCreds = (n: WorkflowNode): WorkflowNode => ({
  ...n,
  credentials: { cohereApi: { id: 'cred-1', name: 'cohereApi' } },
});

async function runAgent(
  http: FakeHttpClient,
  params: DataObject,
  opts: { stream?: boolean; tools?: boolean; creds?: Record<string, DataObject> } = {},
) {
  return run(
    [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', {
        promptType: 'define',
        text: 'What is 6 times 7?',
        systemMessage: 'You are a calculator assistant.',
        options: { enableStreaming: opts.stream ?? false },
      }),
      withCreds(node('Cohere', 'ai.lmChatCohere', params)),
      ...(opts.tools ? [node('Calculator', 'ai.toolCalculator')] : []),
    ],
    connect(
      ['Trigger', 'Agent'],
      ['Cohere', 'Agent', 'ai_languageModel'],
      ...(opts.tools ? [['Calculator', 'Agent', 'ai_tool'] as [string, string, 'ai_tool']] : []),
    ),
    { services: services({ creds: opts.creds ?? CREDS, http }) },
  );
}

const answer = (text: string): { body: unknown } => ({
  body: {
    id: 'c1',
    finish_reason: 'COMPLETE',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: {
      billed_units: { input_tokens: 9, output_tokens: 3 },
      tokens: { input_tokens: 12, output_tokens: 4 },
    },
  },
});

const sse = (...events: Array<Record<string, unknown>>) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function ctxFor(type: string, svc: ExecutionServices, params: DataObject = {}) {
  const n = withCreds(node('Node', type, params));
  const workflow = new Workflow({ name: 'w', nodes: [n], connections: {} }, nodeTypes);
  const base = createBaseContext({
    workflow,
    node: n,
    services: svc,
    evaluator: new ExpressionEvaluator(),
    signal: new AbortController().signal,
  });
  return base;
}

describe('Cohere chat model', () => {
  it('sends a v2 chat request and reads the answer', async () => {
    const http = new FakeHttpClient(sequence(answer('42')));
    const r = await runAgent(http, {
      model: 'command-r-plus-08-2024',
      options: { maxTokens: 300, temperature: 0.2, topP: 0.9 },
    });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: '42' }]);
    const [req] = http.requests;
    expect(req.url).toBe('https://api.cohere.ai/v2/chat');
    expect(req.method).toBe('POST');
    expect(req.headers?.authorization).toBe('Bearer cohere-test-key');
    expect(req.body).toMatchObject({
      model: 'command-r-plus-08-2024',
      max_tokens: 300,
      temperature: 0.2,
      p: 0.9,
      messages: [
        { role: 'system', content: 'You are a calculator assistant.' },
        { role: 'user', content: 'What is 6 times 7?' },
      ],
    });
    expect((req.body as DataObject).stream).toBeUndefined();
    expect((req.body as DataObject).tools).toBeUndefined();
    expect(JSON.stringify(req.headers)).not.toMatch(/openai-platform|n8n/i);
  });

  it('keeps Top P inside the range Cohere takes', async () => {
    const body = async (topP: number) => {
      const http = new FakeHttpClient(sequence(answer('42')));
      await runAgent(http, { options: { topP } });
      return http.requests[0].body as { p?: number };
    };
    expect((await body(1)).p).toBe(0.99);
    expect((await body(0)).p).toBe(0.01);
    expect((await body(0.5)).p).toBe(0.5);
  });

  it('defaults to command-a-03-2025 and leaves unset options out', async () => {
    const http = new FakeHttpClient(sequence(answer('42')));
    await runAgent(http, {});
    const body = http.bodies[0] as DataObject;
    expect(body.model).toBe('command-a-03-2025');
    for (const key of ['temperature', 'p', 'max_tokens']) expect(body[key]).toBeUndefined();
  });

  it('sends tools, runs the tool call and sends the result back as a tool message', async () => {
    const http = new FakeHttpClient(
      sequence(
        {
          body: {
            finish_reason: 'TOOL_CALL',
            message: {
              role: 'assistant',
              tool_plan: 'I will use the calculator.',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'Calculator', arguments: '{"input":"6*7"}' },
                },
              ],
            },
            usage: { tokens: { input_tokens: 30, output_tokens: 10 } },
          },
        },
        answer('The result is 42.'),
      ),
    );
    const r = await runAgent(http, {}, { tools: true });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'The result is 42.' }]);
    const first = http.bodies[0] as any;
    expect(first.tools).toEqual([
      {
        type: 'function',
        function: expect.objectContaining({
          name: 'Calculator',
          parameters: expect.objectContaining({ type: 'object' }),
        }),
      },
    ]);
    const second = http.bodies[1] as any;
    const roles = second.messages.map((m: any) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(second.messages[2]).toMatchObject({
      role: 'assistant',
      tool_plan: 'I will use the calculator.',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'Calculator', arguments: '{"input":"6*7"}' } },
      ],
    });
    expect(second.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: '42' });
  });

  it('streams text deltas and rebuilds a streamed tool call', async () => {
    const body = sse(
      { type: 'message-start', id: 's1', delta: { message: { role: 'assistant' } } },
      { type: 'content-start', index: 0, delta: { message: { content: { type: 'text', text: '' } } } },
      { type: 'content-delta', index: 0, delta: { message: { content: { text: 'It is ' } } } },
      { type: 'content-delta', index: 0, delta: { message: { content: { text: '42.' } } } },
      { type: 'content-end', index: 0 },
      {
        type: 'message-end',
        delta: { finish_reason: 'COMPLETE', usage: { tokens: { input_tokens: 5, output_tokens: 3 } } },
      },
    );
    const http = new FakeHttpClient(sequence({ body }));
    const r = await runAgent(http, {}, { stream: true });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'It is 42.' }]);
    expect((http.bodies[0] as DataObject).stream).toBe(true);
    expect(http.requests[0].headers?.accept).toBe('text/event-stream');

    const toolStream = sse(
      { type: 'message-start', id: 's2' },
      { type: 'tool-plan-delta', delta: { message: { tool_plan: 'Calling ' } } },
      { type: 'tool-plan-delta', delta: { message: { tool_plan: 'the tool.' } } },
      {
        type: 'tool-call-start',
        index: 0,
        delta: {
          message: {
            tool_calls: { id: 'call_9', type: 'function', function: { name: 'Calculator', arguments: '' } },
          },
        },
      },
      {
        type: 'tool-call-delta',
        index: 0,
        delta: { message: { tool_calls: { function: { arguments: '{"input":' } } } },
      },
      {
        type: 'tool-call-delta',
        index: 0,
        delta: { message: { tool_calls: { function: { arguments: '"6*7"}' } } } },
      },
      { type: 'tool-call-end', index: 0 },
      { type: 'message-end', delta: { finish_reason: 'TOOL_CALL' } },
    );
    const http2 = new FakeHttpClient(
      sequence(
        { body: toolStream },
        {
          body: sse(
            { type: 'content-delta', index: 0, delta: { message: { content: { text: '42' } } } },
            { type: 'message-end', delta: { finish_reason: 'COMPLETE' } },
          ),
        },
      ),
    );
    const r2 = await runAgent(http2, {}, { stream: true, tools: true });
    expect(r2.status).toBe('success');
    expect(r2.output('Agent')).toEqual([{ output: '42' }]);
    expect((http2.bodies[1] as any).messages[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_9',
      content: '42',
    });
  });

  it('honours the credential URL', async () => {
    const http = new FakeHttpClient(sequence(answer('42')));
    await runAgent(
      http,
      {},
      { creds: { cohereApi: { apiKey: 'k', url: 'https://cohere.proxy.example.com/' } } },
    );
    expect(http.requests[0].url).toBe('https://cohere.proxy.example.com/v2/chat');
  });

  it('maps toolChoice, response format and images, and refuses files', () => {
    const adapter = cohereAdapter({ baseUrl: 'https://api.cohere.ai', model: 'command-a-03-2025' });
    const tools = [{ name: 't', description: 'd', parameters: { properties: { a: { type: 'string' } } } }];
    const forced = adapter.buildRequest(
      { messages: [{ role: 'user', content: 'x' }], tools, toolChoice: 'any' },
      false,
    );
    expect((forced.body as DataObject).tool_choice).toBe('REQUIRED');
    const noTools = adapter.buildRequest(
      { messages: [{ role: 'user', content: 'x' }], toolChoice: 'any' },
      false,
    );
    expect((noTools.body as DataObject).tool_choice).toBeUndefined();
    const json = adapter.buildRequest(
      {
        messages: [{ role: 'user', content: 'x' }],
        responseFormat: { type: 'json', schema: { type: 'object', properties: { a: { type: 'string' } } } },
      },
      false,
    );
    expect((json.body as DataObject).response_format).toEqual({
      type: 'json_object',
      json_schema: { type: 'object', properties: { a: { type: 'string' } } },
    });
    const image = adapter.buildRequest(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'see' },
              { type: 'image', data: 'QUJD', mimeType: 'image/png' },
            ],
          },
        ],
      },
      false,
    );
    expect((image.body as any).messages[0].content).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
    expect(() =>
      adapter.buildRequest(
        {
          messages: [
            { role: 'user', content: [{ type: 'file', data: 'QUJD', mimeType: 'application/pdf' }] },
          ],
        },
        false,
      ),
    ).toThrow('Cohere cannot read files here');
  });

  it('turns an ERROR finish reason into an error and lists chat models from the credential URL', async () => {
    const http = new FakeHttpClient(
      sequence({ body: { finish_reason: 'ERROR', message: { role: 'assistant', content: [] } } }),
    );
    const r = await runAgent(http, { options: { maxRetries: 0 } });
    expect(r.status).toBe('error');

    const listHttp = new FakeHttpClient(() => ({
      body: { models: [{ name: 'command-r' }, { name: 'command-a-03-2025' }, {}] },
    }));
    const type = nodeTypes.get('ai.lmChatCohere')!;
    const base = ctxFor('ai.lmChatCohere', services({ creds: CREDS, http: listHttp }));
    const { getNodeParameter: _omit, ...rest } = base;
    const ctx: LoadOptionsContext = { ...rest, getCurrentNodeParameter: () => undefined };
    expect(await type.methods!.loadOptions!.listModels(ctx)).toEqual([
      { name: 'command-a-03-2025', value: 'command-a-03-2025' },
      { name: 'command-r', value: 'command-r' },
    ]);
    expect(listHttp.requests[0].url).toBe('https://api.cohere.ai/v1/models');
    expect(listHttp.requests[0].qs).toMatchObject({ endpoint: 'chat' });
  });
});

describe('Embeddings Cohere', () => {
  const embeddingsFor = async (
    http: FakeHttpClient,
    params: DataObject,
    creds: Record<string, DataObject> = CREDS,
  ) => {
    const type = nodeTypes.get('ai.embeddingsCohere')!;
    const base = ctxFor('ai.embeddingsCohere', services({ creds, http }), params);
    const ctx = {
      ...base,
      getInputData: () => [],
      getInputConnectionData: async () => undefined,
      runCode: async () => [],
      executeWorkflow: async () => ({ executionId: '', data: null }),
      getToolParameter: () => undefined,
      logSubNodeRun: () => undefined,
    };
    const { response } = await type.supplyData!(ctx as any, 0);
    return response as {
      embedDocuments(t: string[]): Promise<number[][]>;
      embedQuery(t: string): Promise<number[]>;
    };
  };

  const floatReply = (req: { body?: unknown }) => ({
    body: { embeddings: { float: (req.body as { texts: string[] }).texts.map((t) => [t.length, 1]) } },
  });

  it('calls /v2/embed with input_type and float embeddings', async () => {
    const http = new FakeHttpClient(floatReply);
    const embeddings = await embeddingsFor(http, {});
    expect(await embeddings.embedDocuments(['a', 'bb'])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(http.requests[0].url).toBe('https://api.cohere.ai/v2/embed');
    expect(http.requests[0].headers?.authorization).toBe('Bearer cohere-test-key');
    expect(http.bodies[0]).toEqual({
      model: 'embed-english-v2.0',
      texts: ['a', 'bb'],
      input_type: 'search_document',
      embedding_types: ['float'],
    });
    expect(await embeddings.embedQuery('hello')).toEqual([5, 1]);
    expect(http.bodies[1]).toMatchObject({ texts: ['hello'], input_type: 'search_query' });
  });

  it('batches by 96 texts, uses the chosen model and the credential URL', async () => {
    const http = new FakeHttpClient(floatReply);
    const embeddings = await embeddingsFor(
      http,
      { model: 'embed-multilingual-v3.0', options: { batchSize: 1000 } },
      { cohereApi: { apiKey: 'k', url: 'https://cohere.proxy.example.com' } },
    );
    const vectors = await embeddings.embedDocuments(Array.from({ length: 200 }, (_v, i) => `t${i}`));
    expect(vectors).toHaveLength(200);
    expect(http.bodies.map((b) => b.texts.length)).toEqual([96, 96, 8]);
    expect(http.bodies[0].model).toBe('embed-multilingual-v3.0');
    expect(http.requests[0].url).toBe('https://cohere.proxy.example.com/v2/embed');
  });

  it('offers the fixed model list of seven models', () => {
    const type = nodeTypes.get('ai.embeddingsCohere')!;
    const model = type.description.properties.find((p) => p.name === 'model')!;
    expect(model.default).toBe('embed-english-v2.0');
    expect(model.options).toHaveLength(7);
  });
});
