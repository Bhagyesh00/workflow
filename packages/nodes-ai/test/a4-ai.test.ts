import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearBufferMemory } from '../src/nodes/memory/memory.nodes';
import { parseOpenAiStream } from '../src/providers/openai';
import { ModelRefusalError, SseEventBuffer } from '../src/shared/chat-model';
import { parseSse } from '../src/shared/sse';
import { connect, FakeHttpClient, modelRequests, node, run, sequence, services } from './harness';

beforeEach(() => {
  clearBufferMemory();
  modelRequests.clear();
});

const OPENAI_CREDS = { openAiApi: { apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1' } };

const openAiSse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');

function agentRun(model: WorkflowNode, options: Parameters<typeof services>[0], chunks: unknown[] = []) {
  return run(
    [node('Trigger', 'test.trigger'), node('Agent', 'ai.agent', { promptType: 'define', text: 'q' }), model],
    connect(['Trigger', 'Agent'], [model.name, 'Agent', 'ai_languageModel']),
    { services: services({ ...options, hooks: { sendChunk: (c) => void chunks.push(c) } }) },
  );
}

const openAiModel = (options: DataObject = {}): WorkflowNode => ({
  ...node('OpenAI', 'ai.lmChatOpenAi', { options }),
  credentials: { openAiApi: { id: 'c', name: 'c' } },
});

describe('R56: streamed OpenAI refusals fail like non-streamed ones', () => {
  it('throws ModelRefusalError for a streamed refusal', () => {
    const body = openAiSse([
      { model: 'm', choices: [{ delta: { role: 'assistant', refusal: "I'm sorry, " } }] },
      { choices: [{ delta: { refusal: 'I cannot help with that.' }, finish_reason: 'stop' }] },
    ]);
    expect(() => parseOpenAiStream(body, () => {})).toThrow(ModelRefusalError);
    expect(() => parseOpenAiStream(body, () => {})).toThrow(
      "The model declined to answer: I'm sorry, I cannot help with that.",
    );
  });

  it('throws ModelRefusalError when the content filter stops an empty answer', () => {
    const body = openAiSse([
      { model: 'm', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
    ]);
    expect(() => parseOpenAiStream(body, () => {})).toThrow(ModelRefusalError);
    const partial = openAiSse([
      { model: 'm', choices: [{ delta: { content: 'Some text' } }] },
      { choices: [{ delta: {}, finish_reason: 'content_filter' }] },
    ]);
    expect(parseOpenAiStream(partial, () => {}).message.content).toBe('Some text');
  });

  it('fails a streaming agent with AI_REFUSAL instead of an empty answer', async () => {
    const body = openAiSse([
      { model: 'm', choices: [{ delta: { role: 'assistant', refusal: "I'm sorry." } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    const fake = new FakeHttpClient(sequence({ body }));
    const r = await agentRun(openAiModel(), { creds: OPENAI_CREDS, http: fake });
    expect(fake.bodies[0]).toMatchObject({ stream: true });
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain("The model declined to answer: I'm sorry.");
  });
});

describe('R57: model streams reach the caller while the provider is still answering', () => {
  /** the server sends the first event, then waits until `release` before it sends the rest */
  let release: () => void = () => {};
  let endedAt = 0;
  let port = 0;
  const bodies = {
    openai: [
      openAiSse([{ model: 'm', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] }]),
      openAiSse([{ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }]) + 'data: [DONE]\n\n',
    ],
    anthropic: [
      [
        'event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
      ].join(''),
      [
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(''),
    ],
    gemini: [
      `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }] })}\r\n\r\n`,
      `data: ${JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      })}\r\n\r\n`,
    ],
    // the first event comes in three writes, cut in its JSON, in a multi-byte character and in a CRLF
    split: [
      'data: {"model":"m","choices":[{"delta":{"content":"H\xC3',
      '\xA9l"}}]}\r',
      '\n\r\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
    ],
  };
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '';
    const pieces = url.includes('/split/')
      ? bodies.split
      : url.includes('/v1/messages')
        ? bodies.anthropic
        : url.includes('streamGenerateContent')
          ? bodies.gemini
          : bodies.openai;
    const bytes = pieces.map((p) => Buffer.from(p, url.includes('/split/') ? 'latin1' : 'utf8'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of bytes.slice(0, -1)) {
      res.write(piece);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const fallback = setTimeout(() => release(), 1000);
    release = () => {
      clearTimeout(fallback);
      release = () => {};
      endedAt = Date.now();
      res.end(bytes[bytes.length - 1]);
    };
  });

  beforeAll(async () => {
    port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
    );
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  type Creds = (base: string) => Record<string, DataObject>;
  const cases: Array<[string, WorkflowNode, Creds, string]> = [
    ['OpenAI', openAiModel(), (base) => ({ openAiApi: { apiKey: 'k', baseUrl: `${base}/v1` } }), 'Hello'],
    [
      'Anthropic',
      { ...node('Claude', 'ai.lmChatAnthropic'), credentials: { anthropicApi: { id: 'c', name: 'c' } } },
      (base) => ({ anthropicApi: { apiKey: 'k', baseUrl: base } }),
      'Hello',
    ],
    [
      'Gemini',
      { ...node('Gemini', 'ai.lmChatGoogleGemini'), credentials: { googleGeminiApi: { id: 'c', name: 'c' } } },
      (base) => ({ googleGeminiApi: { apiKey: 'k', host: base } }),
      'Hello',
    ],
    [
      'OpenAI (split chunks)',
      openAiModel(),
      (base) => ({ openAiApi: { apiKey: 'k', baseUrl: `${base}/split/v1` } }),
      'Héllo',
    ],
  ];

  it.each(cases)('%s: the first delta arrives before the response ends', async (_name, model, creds, output) => {
    const received: Array<{ chunk: unknown; at: number }> = [];
    const r = await run(
      [node('Trigger', 'test.trigger'), node('Agent', 'ai.agent', { promptType: 'define', text: 'q' }), model],
      connect(['Trigger', 'Agent'], [model.name, 'Agent', 'ai_languageModel']),
      {
        services: services({
          creds: creds(`http://127.0.0.1:${port}`),
          hooks: {
            sendChunk: (chunk) => {
              received.push({ chunk, at: Date.now() });
              if (received.length === 1) setTimeout(() => release(), 50);
            },
          },
        }),
      },
    );
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(r.output('Agent')).toEqual([{ output }]);
    expect(received.map((c) => c.chunk).join('')).toBe(output);
    expect(received.length).toBeGreaterThan(1);
    expect(received[0].at).toBeLessThan(endedAt);
  });

  it('does not retry a stream that fails after a delta was sent', async () => {
    const failing = openAiSse([
      { model: 'm', choices: [{ delta: { content: 'partial' } }] },
      { error: { type: 'server_error', message: 'The server had an error' } },
    ]);
    const good = openAiSse([{ model: 'm', choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]);
    const fake = new FakeHttpClient(sequence({ body: failing }, { body: good }));
    const chunks: unknown[] = [];
    const r = await agentRun(openAiModel({ maxRetries: 2 }), { creds: OPENAI_CREDS, http: fake }, chunks);
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('The server had an error');
    expect(fake.requests).toHaveLength(1);
    expect(chunks).toEqual(['partial']);
  });

  it('retries a stream that fails before any delta was sent', async () => {
    const failing = openAiSse([{ error: { type: 'server_error', message: 'The server had an error' } }]);
    const good = openAiSse([{ model: 'm', choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]);
    const fake = new FakeHttpClient(sequence({ body: failing }, { body: good }));
    const chunks: unknown[] = [];
    const r = await agentRun(openAiModel({ maxRetries: 2 }), { creds: OPENAI_CREDS, http: fake }, chunks);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0].responseType).toBe('stream');
    expect(r.output('Agent')).toEqual([{ output: 'done' }]);
    expect(chunks).toEqual(['done']);
  }, 20_000);

  // the model thinks longer than the timeout: the headers came at once, the body read times out
  const timedOutBody = (): AsyncIterable<Uint8Array> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    }),
  });

  it('retries a stream whose body times out before the first delta', async () => {
    const good = openAiSse([{ model: 'm', choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]);
    const fake = new FakeHttpClient(sequence({ body: timedOutBody() }, { body: good }));
    const chunks: unknown[] = [];
    const r = await agentRun(openAiModel({ maxRetries: 2 }), { creds: OPENAI_CREDS, http: fake }, chunks);
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(fake.requests).toHaveLength(2);
    expect(r.output('Agent')).toEqual([{ output: 'done' }]);
  }, 20_000);

  it('reports a body read that times out as a timed out request', async () => {
    const fake = new FakeHttpClient(sequence({ body: timedOutBody() }));
    const r = await agentRun(openAiModel({ maxRetries: 0 }), { creds: OPENAI_CREDS, http: fake });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('The request timed out');
  });
});

describe('A5: the streaming SSE buffer is linear in the bytes received', () => {
  const feedAll = (chunks: string[]) => {
    const buffer = new SseEventBuffer();
    return [...chunks.flatMap((c) => buffer.push(c)), ...buffer.end()];
  };

  it('treats a CRLF split across two chunks as one line break', () => {
    const whole = 'data: a\r\n\r\ndata: b\r\n\r\n';
    const split = feedAll(['data: a\r', '\n\r\ndata: b\r\n\r\n']);
    expect(split).toEqual(feedAll([whole]));
    expect(split.map((e) => e.data)).toEqual(['a', 'b']);
  });

  it('parses a body cut at every position exactly like the whole body', () => {
    const body =
      'event: x\r\ndata: one\r\n\r\n: note\ndata: two\r\rdata: three\n\ndata: four\r\n\r\n\r\ndata: tail';
    const expected = parseSse(body);
    for (let i = 0; i <= body.length; i++) {
      expect(feedAll([body.slice(0, i), body.slice(i)]), `cut at ${i}`).toEqual(expected);
    }
    expect(feedAll([...body]), 'one character at a time').toEqual(expected);
  });

  it('takes a long event with no blank line in linear time, then flushes it as one event', () => {
    const chunkSize = 16 * 1024;
    const count = 1024; // 16 MB in 16 KB chunks
    const buffer = new SseEventBuffer();
    const first = `data: ${'a'.repeat(chunkSize - 6)}`;
    const rest = 'a'.repeat(chunkSize);
    const started = performance.now();
    for (let i = 0; i < count; i++) {
      if (buffer.push(i === 0 ? first : rest).length) throw new Error('no event is complete yet');
    }
    expect(performance.now() - started).toBeLessThan(3000);
    const events = buffer.push('\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data.length).toBe(chunkSize * count - 6);
  }, 120_000);
});
