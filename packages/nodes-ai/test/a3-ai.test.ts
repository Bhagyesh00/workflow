import { HttpClient } from '@workflow/core';
import type { DataObject, WorkflowNode } from '@workflow/workflow';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearBufferMemory } from '../src/nodes/memory/memory.nodes';
import { parseAnthropicStream } from '../src/providers/anthropic';
import { parseGeminiStream } from '../src/providers/gemini';
import { parseOpenAiStream } from '../src/providers/openai';
import { httpStatusOf, isRetryable } from '../src/shared/retry';
import {
  connect,
  FakeHttpClient,
  modelRequests,
  node,
  PG_CREDENTIALS,
  run,
  scriptModel,
  sequence,
  services,
  toolCalls,
} from './harness';

beforeEach(() => {
  clearBufferMemory();
  modelRequests.clear();
});

describe('R29: output-parser retry keeps the tools', () => {
  it('sends the same tools on the retry and runs tool calls the retried answer makes', async () => {
    const requests = scriptModel('Model', [
      toolCalls(['Calculator', { input: '6*7' }]),
      'not json',
      toolCalls(['Calculator', { input: '6*7' }]),
      '{"result": 42}',
    ]);
    const r = await run(
      [
        node('Chat', 'ai.chatTrigger'),
        node('Agent', 'ai.agent', { options: { returnIntermediateSteps: true } }),
        node('Model', 'test.fakeChatModel'),
        node('Calculator', 'ai.toolCalculator'),
        node('Parser', 'ai.outputParserStructured', { jsonSchemaExample: '{"result": 42}' }),
      ],
      connect(
        ['Chat', 'Agent'],
        ['Model', 'Agent', 'ai_languageModel'],
        ['Calculator', 'Agent', 'ai_tool'],
        ['Parser', 'Agent', 'ai_outputParser'],
      ),
      { triggerItems: [{ json: { sessionId: 's', chatInput: 'six times seven', action: 'sendMessage' } }] },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(requests).toHaveLength(4);
    const toolNames = (i: number) => requests[i].tools?.map((t) => t.name);
    expect(toolNames(1)).toEqual(['Calculator']);
    expect(toolNames(3)).toEqual(['Calculator']);
    expect(requests[1].responseFormat).toEqual(requests[0].responseFormat);
    expect((r.output('Agent')[0] as any).output).toEqual({ result: 42 });
    expect((r.output('Agent')[0] as any).intermediateSteps).toHaveLength(2);
  });
});

describe('R30: Postgres chat table is not cached per process', () => {
  const table = `ai_chat_a3_${process.pid}_${Date.now()}`;
  const client = new pg.Client({ ...PG_CREDENTIALS });
  const creds = { postgres: PG_CREDENTIALS };
  const memory = node(
    'Memory',
    'ai.memoryPostgresChat',
    { tableName: table, contextWindowLength: 2 },
    { credentials: { postgres: { id: 'pg', name: 'pg' } } },
  );

  beforeAll(() => client.connect());
  afterAll(async () => {
    await client.query(`DROP TABLE IF EXISTS "${table}"`);
    await client.end();
  });

  async function converse(m: WorkflowNode, input: string) {
    scriptModel('Model', ['ok']);
    return run(
      [node('Chat', 'ai.chatTrigger'), node('Agent', 'ai.agent'), node('Model', 'test.fakeChatModel'), m],
      connect(['Chat', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], [m.name, 'Agent', 'ai_memory']),
      {
        triggerItems: [{ json: { sessionId: 's1', chatInput: input } }],
        services: services({ creds, http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }) }),
      },
    );
  }

  it('recreates the table after it was dropped', async () => {
    expect((await converse(memory, 'one')).status).toBe('success');
    await client.query(`DROP TABLE "${table}"`);
    const again = await converse(memory, 'two');
    expect(again.status, JSON.stringify(again.error)).toBe('success');
    const rows = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
    expect(rows.rows[0].n).toBe(2);
  });
});

describe('R32: mid-stream provider errors are retried like HTTP errors', () => {
  const sse = (events: Array<[string, unknown]>) =>
    events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const start = [
    'message_start',
    { type: 'message_start', message: { model: 'm', usage: { input_tokens: 1 } } },
  ];
  const textStart = [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ];
  const textDelta = (text: string) => [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  ];

  function thrownBy(fn: () => unknown): unknown {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it('maps stream error events to retryable HTTP statuses', () => {
    const overloaded = sse([
      start,
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
    ] as Array<[string, unknown]>);
    const caught = thrownBy(() => parseAnthropicStream(overloaded, () => {}));
    expect(httpStatusOf(caught)).toBe(529);
    expect(isRetryable(caught)).toBe(true);

    const apiError = sse([['error', { type: 'error', error: { type: 'api_error', message: 'Internal' } }]]);
    expect(httpStatusOf(thrownBy(() => parseAnthropicStream(apiError, () => {})))).toBe(500);
    const invalid = sse([
      ['error', { type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }],
    ]);
    const rejected = thrownBy(() => parseAnthropicStream(invalid, () => {}));
    expect(rejected).toBeInstanceOf(Error);
    expect(isRetryable(rejected)).toBe(false);

    const openAi = `data: ${JSON.stringify({ error: { type: 'server_error', message: 'The server had an error' } })}\n\n`;
    expect(httpStatusOf(thrownBy(() => parseOpenAiStream(openAi, () => {})))).toBe(500);
    const limited = `data: ${JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } })}\n\n`;
    expect(httpStatusOf(thrownBy(() => parseOpenAiStream(limited, () => {})))).toBe(429);

    const gemini = `data: ${JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } })}\n\n`;
    expect(httpStatusOf(thrownBy(() => parseGeminiStream(gemini, () => {})))).toBe(503);
  });

  it('retries an Anthropic stream that ends in overloaded_error, without duplicate chunks', async () => {
    const failing = sse([
      start,
      textStart,
      textDelta('partial'),
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
    ] as Array<[string, unknown]>);
    const good = sse([
      start,
      textStart,
      textDelta('done'),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      ],
      ['message_stop', { type: 'message_stop' }],
    ] as Array<[string, unknown]>);
    const http = new FakeHttpClient(sequence({ body: failing }, { body: good }));
    const chunks: unknown[] = [];
    const model: WorkflowNode = {
      ...node('Claude', 'ai.lmChatAnthropic', { options: { maxRetries: 2 } }),
      credentials: { anthropicApi: { id: 'c', name: 'c' } },
    };
    const creds: Record<string, DataObject> = {
      anthropicApi: { apiKey: 'k', baseUrl: 'https://api.anthropic.com' },
    };
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Agent', 'ai.agent', { promptType: 'define', text: 'q' }),
        model,
      ],
      connect(['Trigger', 'Agent'], ['Claude', 'Agent', 'ai_languageModel']),
      { services: services({ creds, http, hooks: { sendChunk: (c) => void chunks.push(c) } }) },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(http.requests).toHaveLength(2);
    expect(http.bodies[0]).toMatchObject({ stream: true });
    expect(r.output('Agent')).toEqual([{ output: 'done' }]);
    expect(chunks).toEqual(['done']);
  }, 20_000);
});
