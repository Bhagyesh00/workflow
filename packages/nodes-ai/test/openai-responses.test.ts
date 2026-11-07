/**
 * Phase 5 S1 P5-23: OpenAI Responses API adapter and the OpenAI node's Responses mode and options.
 * Replies are fixtures written from the Responses API reference; they prove the request we send.
 */
import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { parseOpenAiResponses, parseOpenAiResponsesStream } from '../src/providers/openai-responses';
import { connect, FakeHttpClient, type FakeReply, node, run, sequence, services } from './harness';

const CREDS = {
  openAiApi: { apiKey: 'sk-test-key', baseUrl: 'https://api.openai.com/v1', organization: 'org-1' },
};

const withCreds = (n: WorkflowNode): WorkflowNode => ({
  ...n,
  credentials: { openAiApi: { id: 'cred-1', name: 'openAiApi' } },
});

async function runAgent(
  http: FakeHttpClient,
  params: DataObject,
  opts: { tools?: boolean; parser?: boolean; stream?: boolean } = {},
) {
  const model = withCreds(node('OpenAI', 'ai.lmChatOpenAi', params));
  const nodes = [
    node('Trigger', 'test.trigger'),
    node('Agent', 'ai.agent', {
      promptType: 'define',
      text: 'What is 6 times 7?',
      systemMessage: 'You are a calculator assistant.',
      options: { enableStreaming: opts.stream === true },
    }),
    model,
  ];
  const links: Parameters<typeof connect> = [
    ['Trigger', 'Agent'],
    ['OpenAI', 'Agent', 'ai_languageModel'],
  ];
  if (opts.tools !== false) {
    nodes.push(node('Calculator', 'ai.toolCalculator'));
    links.push(['Calculator', 'Agent', 'ai_tool']);
  }
  if (opts.parser) {
    nodes.push(node('Parser', 'ai.outputParserStructured', { jsonSchemaExample: '{"result": 42}' }));
    links.push(['Parser', 'Agent', 'ai_outputParser']);
  }
  return run(nodes, connect(...links), { services: services({ creds: CREDS, http }) });
}

const toolCallReply: FakeReply = {
  body: {
    id: 'resp_1',
    status: 'completed',
    model: 'gpt-5-mini-2025',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'web_search_call', id: 'ws_1', status: 'completed' },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'Calculator',
        arguments: '{"input":"6*7"}',
        status: 'completed',
      },
    ],
    usage: { input_tokens: 50, output_tokens: 10 },
  },
};
const textReply = (text: string): FakeReply => ({
  body: {
    id: 'resp_2',
    status: 'completed',
    model: 'gpt-5-mini-2025',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [
          { type: 'output_text', text, annotations: [] },
          { type: 'output_text', text: ' Done.', annotations: [] },
        ],
      },
    ],
    usage: { input_tokens: 70, output_tokens: 8 },
  },
});

describe('OpenAI Responses mode', () => {
  it('sends a Responses request with a function tool and the built-in tools, and reads the turn back', async () => {
    const http = new FakeHttpClient(sequence(toolCallReply, textReply('It is 42.')));
    const r = await runAgent(http, {
      useResponsesApi: true,
      builtInTools: {
        webSearch: { searchContextSize: 'high', country: 'US' },
        fileSearch: { vectorStoreIds: 'vs_1, vs_2', maxResults: 3 },
        codeInterpreter: {},
      },
      options: { maxTokens: 300, verbosity: 'low', reasoningEffort: 'low' },
    });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'It is 42. Done.' }]);

    const [first, second] = http.requests;
    expect(first.url).toBe('https://api.openai.com/v1/responses');
    expect(first.headers?.authorization).toBe('Bearer sk-test-key');
    expect(first.body).toMatchObject({
      model: 'gpt-5-mini',
      max_output_tokens: 300,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
      input: [
        { role: 'system', content: 'You are a calculator assistant.' },
        { role: 'user', content: 'What is 6 times 7?' },
      ],
    });
    const tools = (first.body as any).tools;
    expect(tools[0]).toMatchObject({ type: 'function', name: 'Calculator', strict: false });
    expect(tools.slice(1)).toEqual([
      {
        type: 'web_search',
        search_context_size: 'high',
        user_location: { type: 'approximate', country: 'US' },
      },
      { type: 'file_search', vector_store_ids: ['vs_1', 'vs_2'], max_num_results: 3 },
      { type: 'code_interpreter', container: { type: 'auto' } },
    ]);
    expect((first.body as any).messages).toBeUndefined();
    // the second call replays the call and its result as items
    expect((second.body as any).input.slice(-2)).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'Calculator',
        arguments: '{"input":"6*7"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '42' },
    ]);
    const logs = r.runData.OpenAI.map((t) => t.data.ai_languageModel[0][0].json);
    expect(logs[0].tokenUsage).toEqual({ inputTokens: 50, outputTokens: 10 });
  });

  it('sends no partner or n8n header', async () => {
    const http = new FakeHttpClient(sequence(textReply('hi')));
    await runAgent(http, { useResponsesApi: true }, { tools: false });
    const seen = http.requests.flatMap((q) => Object.entries(q.headers ?? {}));
    for (const [name, value] of seen) {
      expect(name.toLowerCase()).not.toContain('openai-platform');
      expect(name.toLowerCase()).not.toContain('n8n');
      expect(String(value).toLowerCase()).not.toContain('n8n');
    }
    expect(http.requests[0].headers?.['openai-organization']).toBe('org-1');
  });

  it('forces a tool call with tool_choice required and asks for a JSON schema for a parser', async () => {
    const http = new FakeHttpClient(sequence(textReply('{"result": 42}')));
    const r = await runAgent(http, { useResponsesApi: true }, { parser: true, tools: false });
    expect(r.output('Agent')).toEqual([{ output: { result: 42 } }]);
    const body = http.bodies[0] as any;
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'response' });
    expect(body.tool_choice).toBeUndefined();
  });

  it('sends the node options: service tier, metadata, logprobs, cache key, safety id, conversation, stored prompt, extra body', async () => {
    const http = new FakeHttpClient(sequence(textReply('hi')));
    await runAgent(
      http,
      {
        useResponsesApi: true,
        options: {
          baseURL: 'https://gateway.test/v1/',
          serviceTier: 'flex',
          metadata: '{"team":"a"}',
          topLogprobs: 3,
          promptCacheKey: 'cache-1',
          safetyIdentifier: 'user-hash',
          conversationId: 'conv_9',
          promptId: 'pmpt_1',
          promptVersion: '2',
          promptVariables: '{"city":"Pune"}',
          textFormat: 'json_schema',
          schemaName: 'answer',
          schema: '{"type":"object","properties":{"a":{"type":"string"}}}',
          extraBody: '{"store":false,"service_tier":"priority"}',
        },
      },
      { tools: false },
    );
    expect(http.requests[0].url).toBe('https://gateway.test/v1/responses');
    const body = http.bodies[0] as any;
    expect(body).toMatchObject({
      service_tier: 'priority', // extra body wins
      metadata: { team: 'a' },
      top_logprobs: 3,
      include: ['message.output_text.logprobs'],
      prompt_cache_key: 'cache-1',
      safety_identifier: 'user-hash',
      conversation: 'conv_9',
      prompt: { id: 'pmpt_1', version: '2', variables: { city: 'Pune' } },
      text: { format: { type: 'json_schema', name: 'answer' } },
      store: false,
    });
  });

  it('refuses an extra body that is not a JSON object', async () => {
    const http = new FakeHttpClient(sequence(textReply('hi')));
    const r = await runAgent(
      http,
      { useResponsesApi: true, options: { extraBody: '[1]' } },
      { tools: false },
    );
    expect(r.status).toBe('error');
    expect(http.requests).toHaveLength(0);
  });
});

describe('OpenAI Chat Completions mode keeps working and takes the new options', () => {
  it('stays on /chat/completions without the Responses switch and maps the options to body fields', async () => {
    const http = new FakeHttpClient(
      sequence({
        body: {
          model: 'gpt-5-mini',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        },
      }),
    );
    await runAgent(
      http,
      {
        options: {
          serviceTier: 'flex',
          topLogprobs: 2,
          promptCacheKey: 'k',
          safetyIdentifier: 's',
        },
      },
      { tools: false },
    );
    expect(http.requests[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(http.bodies[0]).toMatchObject({
      service_tier: 'flex',
      logprobs: true,
      top_logprobs: 2,
      prompt_cache_key: 'k',
      safety_identifier: 's',
    });
    expect(http.bodies[0].tools).toBeUndefined();
  });
});

describe('Responses parsing', () => {
  it('reads text, tool calls, usage and an incomplete reply', () => {
    const done = parseOpenAiResponses(textReply('a').body);
    expect(done).toMatchObject({
      message: { role: 'assistant', content: 'a Done.' },
      usage: { inputTokens: 70, outputTokens: 8 },
      stopReason: 'end',
    });
    const calls = parseOpenAiResponses(toolCallReply.body);
    expect(calls.stopReason).toBe('tool_calls');
    expect(calls.message.toolCalls).toEqual([
      { id: 'call_1', name: 'Calculator', arguments: { input: '6*7' } },
    ]);
    const cut = parseOpenAiResponses({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'part' }] }],
    });
    expect(cut.stopReason).toBe('max_tokens');
  });

  it('turns a refusal and a content filter into a refusal error', () => {
    expect(() =>
      parseOpenAiResponses({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }],
      }),
    ).toThrow(/declined/);
    expect(() =>
      parseOpenAiResponses({
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
        output: [],
      }),
    ).toThrow(/content filter/);
  });
});

describe('Responses streaming', () => {
  const sse = (...events: Array<[string, unknown]>) =>
    events
      .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...(d as object) })}\n\n`)
      .join('');

  it('reports text deltas and rebuilds a function call from the stream events', () => {
    const deltas: string[] = [];
    const response = parseOpenAiResponsesStream(
      sse(
        ['response.created', { response: { id: 'r' } }],
        ['response.output_text.delta', { delta: 'Hel' }],
        ['response.output_text.delta', { delta: 'lo' }],
        [
          'response.output_item.added',
          {
            output_index: 1,
            item: { type: 'function_call', call_id: 'c1', name: 'Calculator', arguments: '' },
          },
        ],
        ['response.function_call_arguments.delta', { output_index: 1, delta: '{"input":' }],
        ['response.function_call_arguments.delta', { output_index: 1, delta: '"1+1"}' }],
        [
          'response.output_item.done',
          {
            output_index: 1,
            item: { type: 'function_call', call_id: 'c1', name: 'Calculator', arguments: '{"input":"1+1"}' },
          },
        ],
      ),
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(response.message.content).toBe('Hello');
    expect(response.message.toolCalls).toEqual([
      { id: 'c1', name: 'Calculator', arguments: { input: '1+1' } },
    ]);
    expect(response.stopReason).toBe('tool_calls');
  });

  it('takes usage and the stop reason from the completed event', () => {
    const response = parseOpenAiResponsesStream(
      sse(
        ['response.output_text.delta', { delta: 'Hi' }],
        [
          'response.completed',
          {
            response: {
              status: 'completed',
              model: 'gpt',
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi' }] }],
              usage: { input_tokens: 4, output_tokens: 1 },
            },
          },
        ],
      ),
      () => {},
    );
    expect(response).toMatchObject({
      message: { content: 'Hi' },
      usage: { inputTokens: 4, outputTokens: 1 },
      stopReason: 'end',
      model: 'gpt',
    });
  });

  it('fails on an error event and on a failed response, with the HTTP status the retry policy reads', () => {
    expect(() =>
      parseOpenAiResponsesStream(sse(['error', { message: 'boom', code: 'server_error' }]), () => {}),
    ).toThrow(/boom/);
    try {
      parseOpenAiResponsesStream(
        sse([
          'response.failed',
          { response: { error: { message: 'slow down', code: 'rate_limit_exceeded' } } },
        ]),
        () => {},
      );
      expect.unreachable();
    } catch (e) {
      expect((e as { httpCode?: number }).httpCode).toBe(429);
    }
  });

  it('streams through the Agent: the request asks for text/event-stream and the deltas end up in the answer', async () => {
    const body = sse(
      ['response.output_text.delta', { delta: 'It is ' }],
      ['response.output_text.delta', { delta: '42.' }],
      [
        'response.completed',
        {
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'It is 42.' }] }],
            usage: { input_tokens: 3, output_tokens: 2 },
          },
        },
      ],
    );
    const http = new FakeHttpClient(sequence({ body }));
    const r = await runAgent(http, { useResponsesApi: true }, { tools: false, stream: true });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'It is 42.' }]);
    expect((http.bodies[0] as any).stream).toBe(true);
    expect(http.requests[0].headers?.accept).toBe('text/event-stream');
  });
});
