/**
 * Phase 5 S1 C0d2: `toolChoice` and file parts per provider, array content, the new OpenAI config
 * fields. Requests are recorded at the authenticated HTTP helper of a real `HttpChatModel`.
 */
import type {
  AiChatRequest,
  AiChatResponse,
  DataObject,
  HttpRequestOptions,
  SupplyDataContext,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { anthropicAdapter } from '../src/providers/anthropic';
import { bedrockAdapter } from '../src/providers/bedrock';
import { cohereAdapter } from '../src/providers/cohere';
import { geminiAdapter } from '../src/providers/gemini';
import { ollamaAdapter } from '../src/providers/ollama';
import { type OpenAiChatConfig, openAiAdapter } from '../src/providers/openai';
import { openAiResponsesAdapter } from '../src/providers/openai-responses';
import { type ChatAdapter, HttpChatModel } from '../src/shared/chat-model';

const OPENAI_REPLY = {
  model: 'gpt',
  choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
};
const ANTHROPIC_REPLY = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
const GEMINI_REPLY = { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] };

const openAi = (extra: Partial<OpenAiChatConfig> = {}) =>
  openAiAdapter({
    baseUrl: 'https://llm.test/v1/',
    model: 'gpt',
    credentialType: 'openAiApi',
    maxTokensField: 'max_tokens',
    responseFormatMode: 'none',
    ...extra,
  });
const anthropic = () =>
  anthropicAdapter({
    baseUrl: 'https://anthropic.test',
    model: 'claude',
    maxTokens: 100,
    promptCaching: false,
    refusalFallback: false,
  });
const gemini = () => geminiAdapter({ host: 'https://gemini.test', model: 'gemini' });
const ollama = () => ollamaAdapter({ baseUrl: 'https://ollama.test', model: 'llama' });

/** A real model on a fake context: every request is recorded, every reply is `reply`. */
function recordingModel(adapter: ChatAdapter, reply: unknown) {
  const requests: HttpRequestOptions[] = [];
  const ctx = {
    helpers: {
      httpRequestWithAuthentication: async (_type: string, options: HttpRequestOptions) => {
        requests.push(options);
        return reply;
      },
    },
    logSubNodeRun: () => {},
    getNode: () => ({ name: 'Model' }),
  } as unknown as SupplyDataContext;
  const model = new HttpChatModel(ctx, adapter, { timeoutMs: 1000, maxRetries: 0, itemIndex: 0 });
  return { model, requests };
}

async function recordedBody(
  adapter: ChatAdapter,
  reply: unknown,
  request: AiChatRequest,
): Promise<DataObject> {
  const { model, requests } = recordingModel(adapter, reply);
  await model.chat(request);
  return requests[0]!.body as DataObject;
}

const sse = (...chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');

const TOOLS: AiChatRequest['tools'] = [
  { name: 'calc', description: 'Adds', parameters: { type: 'object', properties: {} } },
];
const FORCED: AiChatRequest = {
  messages: [{ role: 'user', content: 'Add' }],
  tools: TOOLS,
  toolChoice: 'any',
};
const PLAIN: AiChatRequest = { messages: [{ role: 'user', content: 'Add' }], tools: TOOLS };
const FILE: AiChatRequest = {
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read this' },
        { type: 'file', data: 'QUJD', mimeType: 'application/pdf', fileName: 'a.pdf' },
      ],
    },
  ],
};

describe('toolChoice per provider', () => {
  it('OpenAI sends tool_choice required, and nothing when not forced', async () => {
    expect((await recordedBody(openAi(), OPENAI_REPLY, FORCED)).tool_choice).toBe('required');
    expect(await recordedBody(openAi(), OPENAI_REPLY, PLAIN)).not.toHaveProperty('tool_choice');
  });

  it('Anthropic sends tool_choice any, and nothing when not forced', async () => {
    expect((await recordedBody(anthropic(), ANTHROPIC_REPLY, FORCED)).tool_choice).toEqual({ type: 'any' });
    expect(await recordedBody(anthropic(), ANTHROPIC_REPLY, PLAIN)).not.toHaveProperty('tool_choice');
  });

  it('Gemini sends function calling mode ANY, and nothing when not forced', async () => {
    expect((await recordedBody(gemini(), GEMINI_REPLY, FORCED)).toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY' },
    });
    expect(await recordedBody(gemini(), GEMINI_REPLY, PLAIN)).not.toHaveProperty('toolConfig');
  });

  it('no provider forces a tool when the request offers none', async () => {
    const noTools: AiChatRequest = { messages: [{ role: 'user', content: 'Add' }], toolChoice: 'any' };
    expect(await recordedBody(openAi(), OPENAI_REPLY, noTools)).not.toHaveProperty('tool_choice');
    expect(await recordedBody(anthropic(), ANTHROPIC_REPLY, noTools)).not.toHaveProperty('tool_choice');
    expect(await recordedBody(gemini(), GEMINI_REPLY, noTools)).not.toHaveProperty('toolConfig');
  });

  it('Ollama fails clearly before any request', async () => {
    const { model, requests } = recordingModel(ollama(), {});
    await expect(model.chat(FORCED)).rejects.toThrow('This Ollama model cannot be forced to call a tool');
    expect(requests).toHaveLength(0);
  });
});

describe('file part per provider', () => {
  it('OpenAI sends a file block with a data URL', async () => {
    const body = await recordedBody(openAi(), OPENAI_REPLY, FILE);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read this' },
          { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,QUJD' } },
        ],
      },
    ]);
  });

  it('OpenAI still names a file that has no name, and images stay image_url', async () => {
    const body = await recordedBody(openAi(), OPENAI_REPLY, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'file', data: 'QUJD', mimeType: 'application/pdf' },
            { type: 'image', data: 'REVG', mimeType: 'image/png' },
          ],
        },
      ],
    });
    expect((body.messages as DataObject[])[0]!.content).toEqual([
      { type: 'file', file: { filename: 'file', file_data: 'data:application/pdf;base64,QUJD' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,REVG' } },
    ]);
  });

  it('Anthropic sends a document block', async () => {
    const body = await recordedBody(anthropic(), ANTHROPIC_REPLY, FILE);
    expect((body.messages as DataObject[])[0]!.content).toEqual([
      { type: 'text', text: 'Read this' },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' },
        title: 'a.pdf',
      },
    ]);
  });

  it('Gemini sends inlineData', async () => {
    const body = await recordedBody(gemini(), GEMINI_REPLY, FILE);
    expect((body.contents as DataObject[])[0]!.parts).toEqual([
      { text: 'Read this' },
      { inlineData: { mimeType: 'application/pdf', data: 'QUJD' } },
    ]);
  });

  it('Ollama fails clearly before any request', async () => {
    const { model, requests } = recordingModel(ollama(), {});
    await expect(model.chat(FILE)).rejects.toThrow('Ollama cannot read files here');
    expect(requests).toHaveLength(0);
  });
});

describe('OpenAI array content', () => {
  const blocks = [
    { type: 'thinking', thinking: [{ type: 'text', text: 'hidden reasoning' }] },
    { type: 'text', text: 'The answer ' },
    { type: 'reference', reference_ids: [1] },
    { type: 'text', text: 'is 42' },
  ];
  const ask: AiChatRequest = { messages: [{ role: 'user', content: 'Ask' }] };

  it('counts only text blocks in a whole response', async () => {
    const { model } = recordingModel(openAi(), {
      choices: [{ message: { role: 'assistant', content: blocks }, finish_reason: 'stop' }],
    });
    const response: AiChatResponse = await model.chat(ask);
    expect(response.message.content).toBe('The answer is 42');
    expect(response.stopReason).toBe('end');
  });

  it('counts only text blocks in a stream, as deltas', async () => {
    const { model } = recordingModel(
      openAi(),
      sse(
        { model: 'magistral', choices: [{ delta: { content: [blocks[0]] } }] },
        { choices: [{ delta: { content: [blocks[1]] } }] },
        { choices: [{ delta: { content: 'is ' } }] },
        { choices: [{ delta: { content: [{ type: 'text', text: '42' }] }, finish_reason: 'stop' }] },
      ),
    );
    const deltas: string[] = [];
    const response = await model.stream!(ask, (text) => deltas.push(text));
    expect(deltas).toEqual(['The answer ', 'is ', '42']);
    expect(response.message.content).toBe('The answer is 42');
  });

  it('a content filter stop with thinking only is a refusal, in both forms', async () => {
    const thinkingOnly = [blocks[0]];
    const whole = recordingModel(openAi(), {
      choices: [{ message: { content: thinkingOnly }, finish_reason: 'content_filter' }],
    });
    await expect(whole.model.chat(ask)).rejects.toThrow('content filter');
    const streamed = recordingModel(
      openAi(),
      sse({ choices: [{ delta: { content: thinkingOnly }, finish_reason: 'content_filter' }] }),
    );
    await expect(streamed.model.stream!(ask, () => {})).rejects.toThrow('content filter');
  });
});

describe('OpenAI config', () => {
  const ask: AiChatRequest = { messages: [{ role: 'user', content: 'Ask' }], temperature: 0.5 };
  const streamReply = sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] });

  it('asks for stream usage by default, and not with streamUsage false', async () => {
    const on = recordingModel(openAi(), streamReply);
    await on.model.stream!(ask, () => {});
    expect((on.requests[0]!.body as DataObject).stream_options).toEqual({ include_usage: true });

    const off = recordingModel(openAi({ streamUsage: false }), streamReply);
    await off.model.stream!(ask, () => {});
    expect((off.requests[0]!.body as DataObject).stream).toBe(true);
    expect(off.requests[0]!.body).not.toHaveProperty('stream_options');
  });

  it('keeps the default path and sends no query string unless asked', async () => {
    const { model, requests } = recordingModel(openAi(), OPENAI_REPLY);
    await model.chat(ask);
    expect(requests[0]!.url).toBe('https://llm.test/v1/chat/completions');
    expect(requests[0]!).not.toHaveProperty('qs');
  });

  it('chatPath and query shape the call', async () => {
    const { model, requests } = recordingModel(
      openAi({
        chatPath: '/openai/deployments/d1/chat/completions',
        query: { 'api-version': '2025-03-01-preview' },
      }),
      OPENAI_REPLY,
    );
    await model.chat(ask);
    expect(requests[0]!.url).toBe('https://llm.test/v1/openai/deployments/d1/chat/completions');
    expect(requests[0]!.qs).toEqual({ 'api-version': '2025-03-01-preview' });
  });

  it('a chatPath without a leading slash cannot change the host', async () => {
    const { model, requests } = recordingModel(openAi({ chatPath: 'custom/path' }), OPENAI_REPLY);
    await model.chat(ask);
    expect(requests[0]!.url).toBe('https://llm.test/v1/custom/path');
  });

  it('extraBody is merged last and wins on a collision', async () => {
    const body = await recordedBody(
      openAi({ extraBody: { safe_prompt: true, temperature: 0.1 } }),
      OPENAI_REPLY,
      ask,
    );
    expect(body.safe_prompt).toBe(true);
    expect(body.temperature).toBe(0.1);
  });
});

describe('adapters the lanes fill', () => {
  it('are exported with the ChatAdapter signature', () => {
    const adapters: Array<(config: never) => ChatAdapter> = [
      bedrockAdapter,
      cohereAdapter,
      openAiResponsesAdapter,
    ];
    for (const adapter of adapters) expect(adapter).toBeTypeOf('function');
  });
});
