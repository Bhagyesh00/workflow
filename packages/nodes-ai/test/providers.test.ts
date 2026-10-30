import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { parseAnthropicStream, toAnthropicMessages } from '../src/providers/anthropic';
import { parseGeminiStream } from '../src/providers/gemini';
import { parseOpenAiStream } from '../src/providers/openai';
import { markToolError } from '../src/shared/markers';
import { connect, FakeHttpClient, type FakeReply, node, run, sequence, services } from './harness';

const OPENAI_CREDS = {
  openAiApi: { apiKey: 'sk-test-key', baseUrl: 'https://api.openai.com/v1', organization: 'org-1' },
};
const ANTHROPIC_CREDS = { anthropicApi: { apiKey: 'ant-test-key', baseUrl: 'https://api.anthropic.com' } };
const GEMINI_CREDS = {
  googleGeminiApi: { apiKey: 'gem-test-key', host: 'https://generativelanguage.googleapis.com' },
};

function withCreds(n: WorkflowNode, type: string): WorkflowNode {
  return { ...n, credentials: { [type]: { id: 'cred-1', name: type } } };
}

/** Trigger -> Agent (+ calculator tool, optional parser) with the given model node. */
async function runAgent(
  model: WorkflowNode,
  http: FakeHttpClient,
  creds: Record<string, DataObject>,
  options: { parser?: boolean; tools?: boolean; agentOptions?: DataObject } = {},
) {
  const nodes = [
    node('Trigger', 'test.trigger'),
    node('Agent', 'ai.agent', {
      promptType: 'define',
      text: 'What is 6 times 7?',
      systemMessage: 'You are a calculator assistant.',
      options: { enableStreaming: false, ...(options.agentOptions ?? {}) },
    }),
    model,
  ];
  const links: Parameters<typeof connect> = [
    ['Trigger', 'Agent'],
    [model.name, 'Agent', 'ai_languageModel'],
  ];
  if (options.tools !== false) {
    nodes.push(node('Calculator', 'ai.toolCalculator'));
    links.push(['Calculator', 'Agent', 'ai_tool']);
  }
  if (options.parser) {
    nodes.push(node('Parser', 'ai.outputParserStructured', { jsonSchemaExample: '{"result": 42}' }));
    links.push(['Parser', 'Agent', 'ai_outputParser']);
  }
  return run(nodes, connect(...links), { services: services({ creds, http }) });
}

// ---------------------------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------------------------

const openAiToolCall: FakeReply = {
  body: {
    model: 'gpt-5-mini-2025',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'Calculator', arguments: '{"input":"6*7"}' },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 10 },
  },
};
const openAiText = (content: string): FakeReply => ({
  body: {
    model: 'gpt-5-mini-2025',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 70, completion_tokens: 8 },
  },
});

describe('OpenAI chat model', () => {
  const model = () =>
    withCreds(
      node('OpenAI', 'ai.lmChatOpenAi', { options: { temperature: 0.2, maxTokens: 300 } }),
      'openAiApi',
    );

  it('maps messages, tools, tool calls and tool results', async () => {
    const http = new FakeHttpClient(sequence(openAiToolCall, openAiText('6 times 7 is 42.')));
    const r = await runAgent(model(), http, OPENAI_CREDS);
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: '6 times 7 is 42.' }]);

    const [first, second] = http.requests;
    expect(first.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(first.method).toBe('POST');
    expect(first.headers?.authorization).toBe('Bearer sk-test-key');
    expect(first.headers?.['openai-organization']).toBe('org-1');
    expect(first.body).toMatchObject({
      model: 'gpt-5-mini',
      temperature: 0.2,
      max_completion_tokens: 300,
      messages: [
        { role: 'system', content: 'You are a calculator assistant.' },
        { role: 'user', content: 'What is 6 times 7?' },
      ],
      tools: [{ type: 'function', function: { name: 'Calculator', parameters: { type: 'object' } } }],
    });
    expect((second.body as any).messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'Calculator', arguments: '{"input":"6*7"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '42' },
    ]);
    // AI logs: one entry per model call with token usage
    const logs = r.runData.OpenAI.map((t) => t.data.ai_languageModel[0][0].json);
    expect(logs[0].tokenUsage).toEqual({ inputTokens: 50, outputTokens: 10 });
    expect(logs[1].response).toMatchObject({ role: 'assistant', content: '6 times 7 is 42.' });
  });

  it('requests JSON-schema output for an output parser', async () => {
    const http = new FakeHttpClient(sequence(openAiText('{"result": 42}')));
    const r = await runAgent(model(), http, OPENAI_CREDS, { parser: true, tools: false });
    expect(r.output('Agent')).toEqual([{ output: { result: 42 } }]);
    expect((http.bodies[0] as any).response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'response',
        strict: false,
        schema: { type: 'object', properties: { result: { type: 'number' } }, required: ['result'] },
      },
    });
  });

  it('retries rate limits and server errors, honouring Retry-After', async () => {
    const http = new FakeHttpClient(
      sequence(
        { status: 429, body: { error: { message: 'Rate limit reached' } }, headers: { 'retry-after': '0' } },
        { status: 503, body: { error: { message: 'overloaded' } } },
        openAiText('done'),
      ),
    );
    const r = await runAgent(
      withCreds(node('OpenAI', 'ai.lmChatOpenAi', { options: { maxRetries: 2 } }), 'openAiApi'),
      http,
      OPENAI_CREDS,
      { tools: false },
    );
    expect(r.status).toBe('success');
    expect(http.requests).toHaveLength(3);
  });

  it('does not retry client errors and reports the API message', async () => {
    const http = new FakeHttpClient(
      sequence({ status: 401, body: { error: { message: 'Incorrect API key provided' } } }),
    );
    const r = await runAgent(model(), http, OPENAI_CREDS, { tools: false });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Incorrect API key provided');
    expect(r.error?.code).toBe('HTTP_401');
    expect(http.requests).toHaveLength(1);
    // the failed call is visible in the AI logs
    expect(r.runData.OpenAI[0].executionStatus).toBe('error');
  });

  it('gives up after max retries', async () => {
    const http = new FakeHttpClient(() => ({ status: 500, body: { error: { message: 'boom' } } }));
    const r = await runAgent(
      withCreds(node('OpenAI', 'ai.lmChatOpenAi', { options: { maxRetries: 1 } }), 'openAiApi'),
      http,
      OPENAI_CREDS,
      {
        tools: false,
      },
    );
    expect(r.status).toBe('error');
    expect(http.requests).toHaveLength(2);
  }, 10_000);

  it('streams through the agent when enabled, and accepts servers that ignore stream: true', async () => {
    const sse = [
      { model: 'm', choices: [{ delta: { content: 'Forty' } }] },
      { choices: [{ delta: { content: '-two' }, finish_reason: 'stop' }] },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join('');
    const http = new FakeHttpClient(sequence({ body: sse }, openAiText('plain JSON')));
    const chunks: any[] = [];
    const hooks = { sendChunk: (c: unknown) => void chunks.push(c) };
    const nodes = [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', { promptType: 'define', text: 'q' }),
      model(),
    ];
    const links = connect(['Trigger', 'Agent'], ['OpenAI', 'Agent', 'ai_languageModel']);
    const r = await run(nodes, links, { services: services({ creds: OPENAI_CREDS, http, hooks }) });
    expect(r.output('Agent')).toEqual([{ output: 'Forty-two' }]);
    expect(http.bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(http.requests[0].responseType).toBe('text');
    expect(chunks.filter((c) => c.type === 'item').map((c) => c.content)).toEqual(['Forty', '-two']);

    const again = await run(nodes, links, { services: services({ creds: OPENAI_CREDS, http }) });
    expect(again.output('Agent')).toEqual([{ output: 'plain JSON' }]);
  });

  it('rebuilds streamed responses with text deltas and tool calls', () => {
    const deltas: string[] = [];
    const sse = [
      { model: 'm', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Calc', arguments: '{"in' } }] } },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: 'put":"1+1"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .concat('data: [DONE]\n\n')
      .join('');
    const response = parseOpenAiStream(sse, (d) => deltas.push(d));
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(response.message).toEqual({
      role: 'assistant',
      content: 'Hello',
      toolCalls: [{ id: 'c1', name: 'Calc', arguments: { input: '1+1' } }],
    });
    expect(response.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(response.stopReason).toBe('tool_calls');
  });

  it('OpenAI-compatible endpoints use their base URL, optional key and max_tokens', async () => {
    const http = new FakeHttpClient(sequence(openAiText('hi from groq')));
    const r = await runAgent(
      withCreds(
        node('Groq', 'ai.lmChatOpenAiCompatible', { model: 'llama-3.3-70b', options: { maxTokens: 99 } }),
        'openAiCompatibleApi',
      ),
      http,
      { openAiCompatibleApi: { baseUrl: 'https://api.groq.com/openai/v1/', apiKey: 'gsk_1' } },
      { tools: false },
    );
    expect(r.output('Agent')).toEqual([{ output: 'hi from groq' }]);
    expect(http.requests[0].url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(http.requests[0].headers?.authorization).toBe('Bearer gsk_1');
    expect(http.bodies[0]).toMatchObject({ model: 'llama-3.3-70b', max_tokens: 99 });
  });
});

// ---------------------------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------------------------

const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };

describe('Anthropic chat model', () => {
  const model = (options: DataObject = {}) =>
    withCreds(node('Claude', 'ai.lmChatAnthropic', { options }), 'anthropicApi');

  it('maps system, tools, tool_use / tool_result and replays thinking blocks', async () => {
    const http = new FakeHttpClient(
      sequence(
        {
          body: {
            model: 'claude-sonnet-5-5',
            stop_reason: 'tool_use',
            content: [
              thinking,
              { type: 'text', text: 'Let me calculate.' },
              { type: 'tool_use', id: 'toolu_1', name: 'Calculator', input: { input: '6*7' } },
              { type: 'tool_use', id: 'toolu_2', name: 'Calculator', input: { input: '6*' } },
            ],
            usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30 },
          },
        },
        {
          body: {
            model: 'claude-sonnet-5-5',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: '42' }],
            usage: { input_tokens: 150, output_tokens: 2 },
          },
        },
      ),
    );
    const r = await runAgent(model(), http, ANTHROPIC_CREDS, { agentOptions: { returnUsage: true } });
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([
      { output: '42', usage: { inputTokens: 280, outputTokens: 22, modelCalls: 2, toolCalls: 2 } },
    ]);

    const [first, second] = http.requests;
    expect(first.url).toBe('https://api.anthropic.com/v1/messages');
    expect(first.headers).toMatchObject({
      'x-api-key': 'ant-test-key',
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    });
    const body = first.body as any;
    expect(body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 16000,
      system: 'You are a calculator assistant.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What is 6 times 7?' }] }],
      tools: [{ name: 'Calculator', input_schema: { type: 'object', required: ['input'] } }],
      cache_control: { type: 'ephemeral' },
      fallbacks: 'default',
    });
    // sampling parameters are rejected by API version 2026-10-21
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();

    const messages = (second.body as any).messages;
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        thinking,
        { type: 'text', text: 'Let me calculate.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Calculator', input: { input: '6*7' } },
        { type: 'tool_use', id: 'toolu_2', name: 'Calculator', input: { input: '6*' } },
      ],
    });
    // both results in one user turn; the failed one flagged with is_error
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '42' },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_2',
        content: expect.stringMatching(/^Error: /),
        is_error: true,
      },
    ]);
  });

  it('uses output_config.format for structured output and effort', async () => {
    const http = new FakeHttpClient(
      sequence({
        body: {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"result":42}' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    );
    const r = await runAgent(
      model({ effort: 'low', promptCaching: false, refusalFallback: false }),
      http,
      ANTHROPIC_CREDS,
      {
        parser: true,
        tools: false,
      },
    );
    expect(r.output('Agent')).toEqual([{ output: { result: 42 } }]);
    const body = http.bodies[0] as any;
    expect(body.output_config).toEqual({
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { result: { type: 'number' } },
          required: ['result'],
          additionalProperties: false,
        },
      },
    });
    expect(body.cache_control).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
    expect(http.requests[0].headers?.['anthropic-beta']).toBeUndefined();
  });

  it('turns a refusal into a clear error', async () => {
    const http = new FakeHttpClient(
      sequence({
        body: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] },
      }),
    );
    const r = await runAgent(model(), http, ANTHROPIC_CREDS, { tools: false });
    expect(r.status).toBe('error');
    expect(r.error?.code).toBe('AI_REFUSAL');
    expect(r.error?.message).toContain('category: cyber');
  });

  it('retries overloaded (529) responses', async () => {
    const http = new FakeHttpClient(
      sequence(
        { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
        { body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } },
      ),
    );
    const r = await runAgent(model(), http, ANTHROPIC_CREDS, { tools: false });
    expect(r.output('Agent')).toEqual([{ output: 'ok' }]);
    expect(http.requests).toHaveLength(2);
  });

  it('does not send server fallbacks to a custom base URL', async () => {
    const http = new FakeHttpClient(
      sequence({ body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } }),
    );
    await runAgent(
      model(),
      http,
      { anthropicApi: { apiKey: 'k', baseUrl: 'https://gateway.example.com/' } },
      { tools: false },
    );
    expect(http.requests[0].url).toBe('https://gateway.example.com/v1/messages');
    expect((http.bodies[0] as any).fallbacks).toBeUndefined();
  });

  it('maps images and merges tool results without a cache', () => {
    const toolResult = markToolError({ role: 'tool', toolCallId: 't2', content: 'Error: x' });
    expect(
      toAnthropicMessages([
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', mimeType: 'image/png', data: 'AAA=' },
          ],
        },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 't1', name: 'a', arguments: {} },
            { id: 't2', name: 'b', arguments: { x: 1 } },
          ],
        },
        { role: 'tool', toolCallId: 't1', content: 'one' },
        toolResult,
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'a', input: {} },
          { type: 'tool_use', id: 't2', name: 'b', input: { x: 1 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'one' },
          { type: 'tool_result', tool_use_id: 't2', content: 'Error: x', is_error: true },
        ],
      },
    ]);
  });

  it('rebuilds a streamed message including thinking signatures and tool input', () => {
    const events = [
      {
        type: 'message_start',
        message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 12, output_tokens: 1 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking ' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'now' } },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'tu', name: 'Calc', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"input":' },
      },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"1+1"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    ];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    const deltas: string[] = [];
    const response = parseAnthropicStream(sse, (d) => deltas.push(d));
    expect(deltas).toEqual(['Checking ', 'now']);
    expect(response.message).toEqual({
      role: 'assistant',
      content: 'Checking now',
      toolCalls: [{ id: 'tu', name: 'Calc', arguments: { input: '1+1' } }],
    });
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 30 });
    expect(response.stopReason).toBe('tool_calls');
  });
});

// ---------------------------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------------------------

describe('Google Gemini chat model', () => {
  const model = () =>
    withCreds(
      node('Gemini', 'ai.lmChatGoogleGemini', { options: { temperature: 0.1, maxTokens: 500 } }),
      'googleGeminiApi',
    );

  it('maps function declarations, calls and responses', async () => {
    const http = new FakeHttpClient(
      sequence(
        {
          body: {
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: { name: 'Calculator', args: { input: '6*7' } },
                      thoughtSignature: 'ts-1',
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 5 },
            modelVersion: 'gemini-2.5-flash',
          },
        },
        {
          body: {
            candidates: [
              { finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'It is 42.' }] } },
            ],
            usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 4 },
          },
        },
      ),
    );
    const r = await runAgent(model(), http, GEMINI_CREDS);
    expect(r.status).toBe('success');
    expect(r.output('Agent')).toEqual([{ output: 'It is 42.' }]);
    const [first, second] = http.requests;
    expect(first.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(first.headers?.['x-goog-api-key']).toBe('gem-test-key');
    expect(first.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'You are a calculator assistant.' }] },
      contents: [{ role: 'user', parts: [{ text: 'What is 6 times 7?' }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'Calculator',
              parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
    });
    const contents = (second.body as any).contents;
    // the model turn is replayed with its thought signature, the result as a functionResponse
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'Calculator', args: { input: '6*7' } }, thoughtSignature: 'ts-1' }],
    });
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'Calculator', response: { result: 42 } } }],
    });
  });

  it('uses JSON mode with a response schema when no tools are attached', async () => {
    const http = new FakeHttpClient(
      sequence({
        body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"result": 42}' }] } }] },
      }),
    );
    const r = await runAgent(model(), http, GEMINI_CREDS, { parser: true, tools: false });
    expect(r.output('Agent')).toEqual([{ output: { result: 42 } }]);
    expect((http.bodies[0] as any).generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties: { result: { type: 'number' } }, required: ['result'] },
    });
  });

  it('does not combine JSON mode with function calling', async () => {
    const http = new FakeHttpClient(
      sequence({
        body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"result": 42}' }] } }] },
      }),
    );
    const r = await runAgent(model(), http, GEMINI_CREDS, { parser: true });
    expect(r.status).toBe('success');
    expect((http.bodies[0] as any).generationConfig.responseMimeType).toBeUndefined();
  });

  it('reports blocked prompts and retries server errors', async () => {
    const blocked = new FakeHttpClient(sequence({ body: { promptFeedback: { blockReason: 'SAFETY' } } }));
    const r1 = await runAgent(model(), blocked, GEMINI_CREDS, { tools: false });
    expect(r1.error?.code).toBe('AI_REFUSAL');

    const flaky = new FakeHttpClient(
      sequence(
        { status: 500, body: { error: { message: 'internal' } } },
        { body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] } },
      ),
    );
    const r2 = await runAgent(model(), flaky, GEMINI_CREDS, { tools: false });
    expect(r2.output('Agent')).toEqual([{ output: 'ok' }]);

    const bad = new FakeHttpClient(
      sequence({ status: 400, body: { error: { message: 'API key not valid' } } }),
    );
    const r3 = await runAgent(model(), bad, GEMINI_CREDS, { tools: false });
    expect(r3.error?.message).toBe('API key not valid');
    expect(bad.requests).toHaveLength(1);
  });

  it('merges streamed chunks', () => {
    const sse = [
      { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
      {
        candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`)
      .join('');
    const deltas: string[] = [];
    const response = parseGeminiStream(sse, (d) => deltas.push(d));
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(response.message.content).toBe('Hello');
    expect(response.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
});

describe('Ollama chat model', () => {
  it('uses the native chat API with tools', async () => {
    const http = new FakeHttpClient(
      sequence(
        {
          body: {
            model: 'llama3.2',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'Calculator', arguments: { input: '6*7' } } }],
            },
            prompt_eval_count: 30,
            eval_count: 5,
          },
        },
        { body: { model: 'llama3.2', message: { role: 'assistant', content: '42' }, done_reason: 'stop' } },
      ),
    );
    const r = await runAgent(withCreds(node('Ollama', 'ai.lmChatOllama'), 'ollamaApi'), http, {
      ollamaApi: { baseUrl: 'https://ollama.example.com' },
    });
    expect(r.output('Agent')).toEqual([{ output: '42' }]);
    expect(http.requests[0].url).toBe('https://ollama.example.com/api/chat');
    expect(http.requests[0].headers?.authorization).toBeUndefined();
    expect((http.bodies[1] as any).messages.at(-1)).toEqual({
      role: 'tool',
      content: '42',
      tool_name: 'Calculator',
    });
  });
});
