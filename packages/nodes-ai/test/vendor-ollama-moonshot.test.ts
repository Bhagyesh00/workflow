/**
 * P5-34 Ollama and Moonshot vendor nodes: one recorded call per operation (text.message and image.analyze),
 * with and without tools, the options mapping, the credential's host and key, and the model pickers. Replies
 * are fixtures written from the Ollama API and the Moonshot chat API reference; they prove the request we send.
 */
import { NodeTypes } from '@workflow/core';
import type { AiTool, DataObject, Item, NodeType } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { MoonshotNode } from '../src/nodes/vendors/moonshot/Moonshot.node';
import { OllamaNode } from '../src/nodes/vendors/ollama/Ollama.node';
import {
  connect,
  type FakeHandler,
  FakeHttpClient,
  type FakeReply,
  type Link,
  node,
  run,
  services,
  testNodes,
} from './harness';

const OLLAMA_URL = 'http://ollama.test:11434';
const MOON_KEY = 'sk-moonshot-test-key-0123456789abcdef';
const MOON_URL = 'https://api.moonshot.cn/v1';

const calls: DataObject[] = [];

const toolNode = (name: string, canWait: boolean): NodeType => ({
  description: {
    name,
    displayName: name,
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Tool' },
    inputs: [],
    outputs: ['ai_tool'],
    properties: [],
  },
  async supplyData() {
    const tool: AiTool = {
      kind: 'tool',
      name: 'lookup',
      description: 'Looks a value up',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      ...(canWait ? { canWait: true } : {}),
      invoke: async (args) => {
        calls.push(args);
        return `found ${String(args.q)}`;
      },
    };
    return { response: tool };
  },
});

const types = new NodeTypes([
  ...nodes,
  ...testNodes,
  toolNode('test.lookupTool', false),
  toolNode('test.waitTool', true),
]);

const b64 = (text: string) => Buffer.from(text).toString('base64');
const bytes = (text: string) => new TextEncoder().encode(text);

const binaryItem = (binary: Record<string, { text: string; mimeType: string; fileName?: string }>): Item => ({
  json: {},
  binary: Object.fromEntries(
    Object.entries(binary).map(([name, v]) => [
      name,
      { data: b64(v.text), mimeType: v.mimeType, fileName: v.fileName, fileSize: v.text.length },
    ]),
  ),
});

interface RunOptions {
  handler?: FakeHandler;
  items?: Item[];
  tool?: 'test.lookupTool' | 'test.waitTool';
  onError?: 'continueRegularOutput';
}

async function runVendor(
  type: 'ai.ollama' | 'ai.moonshot',
  credType: string,
  creds: DataObject,
  params: DataObject,
  handler: FakeHandler,
  options: RunOptions,
) {
  const fake = new FakeHttpClient(options.handler ?? handler);
  const list = [
    node('Trigger', 'test.trigger'),
    node('Vendor', type, params, {
      credentials: { [credType]: { id: 'c', name: 'c' } },
      ...(options.onError ? { onError: options.onError } : {}),
    }),
    ...(options.tool ? [node('Tool', options.tool)] : []),
  ];
  const result = await run(
    list,
    connect(['Trigger', 'Vendor'], ...(options.tool ? [['Tool', 'Vendor', 'ai_tool'] as Link] : [])),
    {
      nodeTypes: types,
      triggerItems: options.items,
      services: services({ nodeTypes: types, creds: { [credType]: creds }, http: fake }),
    },
  );
  return { result, fake, out: result.output('Vendor') };
}

// ---------------------------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------------------------

const ollamaReply = (content: string, extra: DataObject = {}): FakeReply => ({
  body: {
    model: 'llama3.2',
    created_at: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 5,
    eval_count: 3,
    ...extra,
  },
});

const runOllama = (params: DataObject, options: RunOptions = {}) =>
  runVendor(
    'ai.ollama',
    'ollamaApi',
    { baseUrl: `${OLLAMA_URL}/`, apiKey: '' },
    params,
    () => ollamaReply('ok'),
    options,
  );

const model = (value = 'llama3.2') => ({ __rl: true, mode: 'id', value });
const message = (content: string, role = 'user') => ({ messages: { values: [{ role, content }] } });
const ollamaText = (params: DataObject = {}) => ({
  resource: 'text',
  operation: 'message',
  modelId: model(),
  ...message('Hello'),
  ...params,
});
const ollamaImage = (params: DataObject = {}) => ({
  resource: 'image',
  operation: 'analyze',
  modelId: model('llava'),
  text: 'Describe it',
  inputType: 'binary',
  binaryPropertyName: 'data',
  ...params,
});

beforeEach(() => {
  calls.length = 0;
});

describe('Ollama node shell', () => {
  it('is usable as a tool, has text and image, and shows the Tools port only with Hide Tools = Show', () => {
    expect(OllamaNode.description.usableAsTool).toBe(true);
    const resource = OllamaNode.description.properties.find((p) => p.name === 'resource');
    expect(((resource?.options ?? []) as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'text',
      'image',
    ]);
    const body = String(OllamaNode.description.inputs).slice(3, -2);
    const evaluate = (p: DataObject) => new Function('$parameter', `return ${body}`)(p) as unknown[];
    expect(evaluate({ resource: 'text', operation: 'message', hideTools: 'hide' })).toEqual(['main']);
    expect(evaluate({ resource: 'text', operation: 'message', hideTools: 'show' })).toHaveLength(2);
    expect(evaluate({ resource: 'image', operation: 'analyze', hideTools: 'show' })).toEqual(['main']);
  });

  it('offers the 20 options of the chat model, with no Timeout or Max Retries', () => {
    const options = OllamaNode.description.properties.find(
      (p) => p.name === 'options' && p.displayOptions?.show?.operation?.[0] === 'message',
    )!;
    const names = (options.options as Array<{ name: string }>).map((o) => o.name);
    for (const name of [
      'think',
      'temperature',
      'topP',
      'topK',
      'numPredict',
      'numCtx',
      'keepAlive',
      'format',
    ]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain('timeout');
    expect(names).not.toContain('maxRetries');
    expect(names).toContain('system');
  });

  it('lists the models of /api/tags for the picker', async () => {
    const seen: Array<{ url: string }> = [];
    const ctx = {
      getCredentials: async () => ({ baseUrl: `${OLLAMA_URL}/` }),
      helpers: {
        httpRequestWithAuthentication: async (_type: string, request: { url: string }) => {
          seen.push(request);
          return { models: [{ name: 'llama3.2:latest' }, { name: 'llava:7b' }] };
        },
      },
    };
    const all = await OllamaNode.methods!.listSearch!.modelSearch!(ctx as never);
    expect(all.results.map((r) => r.value)).toEqual(['llama3.2:latest', 'llava:7b']);
    const filtered = await OllamaNode.methods!.listSearch!.modelSearch!(ctx as never, 'llava');
    expect(filtered.results.map((r) => r.value)).toEqual(['llava:7b']);
    expect(seen[0]!.url).toBe(`${OLLAMA_URL}/api/tags`);
  });
});

describe('Ollama text.message', () => {
  it('posts the messages to /api/chat on the credential host without tools', async () => {
    const { fake, out } = await runOllama(ollamaText());
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request.url).toBe(`${OLLAMA_URL}/api/chat`);
    expect(request.method).toBe('POST');
    expect(request.body).toMatchObject({
      model: 'llama3.2',
      stream: false,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect((request.body as DataObject).tools).toBeUndefined();
    expect(request.headers?.authorization).toBeUndefined();
    for (const name of Object.keys(request.headers ?? {})) expect(name.toLowerCase()).not.toContain('n8n');
    expect(out).toEqual([{ role: 'assistant', content: 'ok' }]);
  });

  it('maps the options to the Ollama options object and the system message', async () => {
    const { fake } = await runOllama(
      ollamaText({
        messages: {
          values: [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Yo' },
            { role: 'user', content: 'Again' },
          ],
        },
        options: {
          system: 'Be brief',
          think: false,
          temperature: 0.2,
          topP: 0.5,
          topK: 30,
          numPredict: 256,
          numCtx: 8192,
          keepAlive: '10m',
          repeatPenalty: 1.3,
          lowVram: true,
          numGpu: 2,
          format: 'json',
        },
      }),
    );
    const body = fake.requests[0]!.body as DataObject;
    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(body).toMatchObject({ think: false, keep_alive: '10m', format: 'json' });
    expect(body.options).toMatchObject({
      temperature: 0.2,
      top_p: 0.5,
      top_k: 30,
      num_predict: 256,
      num_ctx: 8192,
      repeat_penalty: 1.3,
      low_vram: true,
      num_gpu: 2,
    });
  });

  it('returns the raw reply when Simplify Output is off', async () => {
    const { out } = await runOllama(ollamaText({ simplify: false }));
    expect(out[0]).toMatchObject({ model: 'llama3.2', done: true, message: { content: 'ok' } });
  });

  it('runs a tool turn when Hide Tools is Show: tools in the body, tool result sent back', async () => {
    const { fake, out } = await runOllama(ollamaText({ hideTools: 'show' }), {
      tool: 'test.lookupTool',
      handler: (_request, index) =>
        index === 0
          ? ollamaReply('', {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ function: { name: 'lookup', arguments: { q: 'cats' } } }],
              },
            })
          : ollamaReply('Found cats'),
    });
    expect(calls).toEqual([{ q: 'cats' }]);
    expect(fake.requests).toHaveLength(2);
    const first = fake.requests[0]!.body as DataObject;
    expect((first.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual([
      'lookup',
    ]);
    const second = (fake.requests[1]!.body as any).messages as Array<{ role: string; content: string }>;
    expect(second.at(-1)).toMatchObject({ role: 'tool', content: 'found cats', tool_name: 'lookup' });
    expect(out).toEqual([{ role: 'assistant', content: 'Found cats' }]);
  });

  it('sends no tool and does not refuse a waiting tool while Hide Tools is Hide', async () => {
    const { fake, result } = await runOllama(ollamaText({ hideTools: 'hide' }), { tool: 'test.waitTool' });
    expect(result.status).toBe('success');
    expect(fake.requests).toHaveLength(1);
    expect((fake.requests[0]!.body as DataObject).tools).toBeUndefined();
  });

  it('refuses a tool that waits before anything is sent', async () => {
    const { fake, result } = await runOllama(ollamaText({ hideTools: 'show' }), { tool: 'test.waitTool' });
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('Nodes that wait for an answer cannot be used as tools');
    expect(fake.requests).toHaveLength(0);
  });

  it('turns a failed call into an item with continue on fail', async () => {
    const { out } = await runOllama(ollamaText(), {
      onError: 'continueRegularOutput',
      handler: () => ({ status: 500, body: { error: 'model not found' } }),
    });
    expect(String(out[0]!.error)).toBeTruthy();
  });
});

describe('Ollama image.analyze', () => {
  it('sends a binary image as base64 in images of /api/chat, with the question', async () => {
    const { fake, out } = await runOllama(ollamaImage(), {
      items: [binaryItem({ data: { text: 'PNGBYTES', mimeType: 'image/png', fileName: 'a.png' } })],
    });
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request.url).toBe(`${OLLAMA_URL}/api/chat`);
    expect(request.body).toMatchObject({
      model: 'llava',
      messages: [{ role: 'user', content: 'Describe it', images: [b64('PNGBYTES')] }],
    });
    expect((request.body as DataObject).tools).toBeUndefined();
    expect(out).toEqual([{ role: 'assistant', content: 'ok' }]);
  });

  it('downloads an image URL through the guard, without the credential, and sends it', async () => {
    const { fake } = await runOllama(
      ollamaImage({ inputType: 'url', url: 'https://cdn.example.com/x.png' }),
      {
        handler: (request) =>
          request.method === 'GET'
            ? { body: bytes('URLBYTES'), headers: { 'content-type': 'image/png' } }
            : ollamaReply('a cat'),
      },
    );
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]!.url).toBe('https://cdn.example.com/x.png');
    expect(fake.requests[1]!.body).toMatchObject({ messages: [{ images: [b64('URLBYTES')] }] });
  });

  it('refuses a file that is not an image before anything is sent', async () => {
    const { fake, result } = await runOllama(ollamaImage(), {
      items: [binaryItem({ data: { text: 'PDF', mimeType: 'application/pdf' } })],
    });
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('is not an image');
    expect(fake.requests).toHaveLength(0);
  });

  it('names the missing binary field', async () => {
    const { result } = await runOllama(ollamaImage({ binaryPropertyName: 'nope' }), {
      items: [{ json: {} }],
    });
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('"nope"');
  });
});

// ---------------------------------------------------------------------------------------------
// Moonshot
// ---------------------------------------------------------------------------------------------

const chatReply = (content: string | null, extra: DataObject = {}): FakeReply => ({
  body: {
    id: 'cmpl-1',
    object: 'chat.completion',
    model: 'kimi-k2-0905-preview',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', ...extra }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  },
});

const runMoonshot = (params: DataObject, options: RunOptions = {}) =>
  runVendor(
    'ai.moonshot',
    'moonshotApi',
    { apiKey: MOON_KEY, url: `${MOON_URL}/` },
    params,
    () => chatReply('ok'),
    options,
  );

const kimi = (value = 'kimi-k2-0905-preview') => ({ __rl: true, mode: 'id', value });
const moonText = (params: DataObject = {}) => ({
  resource: 'text',
  operation: 'message',
  modelId: kimi(),
  ...message('Hello'),
  ...params,
});
const moonImage = (params: DataObject = {}) => ({
  resource: 'image',
  operation: 'analyze',
  modelId: kimi('moonshot-v1-8k-vision-preview'),
  text: 'Describe it',
  inputType: 'binary',
  binaryPropertyName: 'data',
  ...params,
});

describe('Moonshot node shell', () => {
  it('is usable as a tool, has text and image, and shows the Tools port only with Hide Tools = Show', () => {
    expect(MoonshotNode.description.usableAsTool).toBe(true);
    const body = String(MoonshotNode.description.inputs).slice(3, -2);
    const evaluate = (p: DataObject) => new Function('$parameter', `return ${body}`)(p) as unknown[];
    expect(evaluate({ resource: 'text', operation: 'message', hideTools: 'hide' })).toEqual(['main']);
    expect(evaluate({ resource: 'text', operation: 'message', hideTools: 'show' })).toHaveLength(2);
  });

  it('lists the models of /models on the credential URL for the picker', async () => {
    const seen: Array<{ url: string }> = [];
    const ctx = {
      getCredentials: async () => ({ url: MOON_URL }),
      helpers: {
        httpRequestWithAuthentication: async (_type: string, request: { url: string }) => {
          seen.push(request);
          return { data: [{ id: 'kimi-k2-0905-preview' }, { id: 'moonshot-v1-8k' }] };
        },
      },
    };
    const all = await MoonshotNode.methods!.listSearch!.modelSearch!(ctx as never, 'moonshot');
    expect(all.results.map((r) => r.value)).toEqual(['moonshot-v1-8k']);
    expect(seen[0]!.url).toBe(`${MOON_URL}/models`);
  });
});

describe('Moonshot text.message', () => {
  it('posts to /chat/completions on the credential region with the key and no tools', async () => {
    const { fake, out } = await runMoonshot(moonText());
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request.url).toBe(`${MOON_URL}/chat/completions`);
    expect(request.method).toBe('POST');
    expect(request.headers?.authorization).toBe(`Bearer ${MOON_KEY}`);
    for (const name of Object.keys(request.headers ?? {})) {
      expect(name.toLowerCase()).not.toContain('n8n');
      expect(name.toLowerCase()).not.toContain('openai-platform');
    }
    expect(request.body).toMatchObject({
      model: 'kimi-k2-0905-preview',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect((request.body as DataObject).tools).toBeUndefined();
    expect(out).toEqual([{ output: 'ok' }]);
  });

  it('sends the options and the system message, and adds the merged response', async () => {
    const { fake, out } = await runMoonshot(
      moonText({
        options: {
          system: 'Be brief',
          temperature: 0.3,
          frequencyPenalty: 0.5,
          maxTokens: 64,
          includeMergedResponse: true,
        },
      }),
    );
    const body = fake.requests[0]!.body as DataObject;
    expect(body).toMatchObject({ temperature: 0.3, frequency_penalty: 0.5, max_tokens: 64 });
    expect((body.messages as Array<{ role: string; content: string }>)[0]).toEqual({
      role: 'system',
      content: 'Be brief',
    });
    expect(out).toEqual([{ output: 'ok', merged_response: 'ok' }]);
  });

  it('returns the raw reply with the merged response when Simplify Output is off', async () => {
    const { out } = await runMoonshot(
      moonText({ simplify: false, options: { includeMergedResponse: true } }),
    );
    expect(out[0]).toMatchObject({ object: 'chat.completion', merged_response: 'ok' });
    expect((out[0]!.choices as unknown[]).length).toBe(1);
  });

  it('sends an attached image as an image part and refuses an attached PDF', async () => {
    const params = () =>
      moonText({
        messages: { values: [{ role: 'user', content: 'Look', attachmentFields: 'data' }] },
      });
    const ok = await runMoonshot(params(), {
      items: [binaryItem({ data: { text: 'PNGBYTES', mimeType: 'image/png', fileName: 'a.png' } })],
    });
    const content = (ok.fake.requests[0]!.body as any).messages.at(-1).content as DataObject[];
    expect(content[0]).toEqual({ type: 'text', text: 'Look' });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${b64('PNGBYTES')}` },
    });
    const bad = await runMoonshot(params(), {
      items: [binaryItem({ data: { text: 'PDF', mimeType: 'application/pdf' } })],
    });
    expect(bad.result.status).toBe('error');
    expect(bad.result.error?.message).toContain('cannot be sent to Kimi');
    expect(bad.fake.requests).toHaveLength(0);
  });

  it('sends no tool and does not refuse a waiting tool while Hide Tools is Hide', async () => {
    const { fake, result } = await runMoonshot(moonText({ hideTools: 'hide' }), { tool: 'test.waitTool' });
    expect(result.status).toBe('success');
    expect(fake.requests).toHaveLength(1);
    expect((fake.requests[0]!.body as DataObject).tools).toBeUndefined();
  });

  it('runs a tool turn when Hide Tools is Show', async () => {
    const { fake, out } = await runMoonshot(moonText({ hideTools: 'show' }), {
      tool: 'test.lookupTool',
      handler: (_request, index) =>
        index === 0
          ? {
              body: {
                id: 'c1',
                model: 'kimi',
                choices: [
                  {
                    index: 0,
                    finish_reason: 'tool_calls',
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'call_1',
                          type: 'function',
                          function: { name: 'lookup', arguments: '{"q":"cats"}' },
                        },
                      ],
                    },
                  },
                ],
              },
            }
          : chatReply('Found cats'),
    });
    expect(calls).toEqual([{ q: 'cats' }]);
    expect(fake.requests).toHaveLength(2);
    const first = fake.requests[0]!.body as DataObject;
    expect((first.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual([
      'lookup',
    ]);
    const second = (fake.requests[1]!.body as any).messages as Array<DataObject>;
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'found cats' });
    expect(out).toEqual([{ output: 'Found cats' }]);
  });

  it('stops a tool loop at Max Tool Calls Iterations', async () => {
    const { fake } = await runMoonshot(moonText({ hideTools: 'show', options: { maxToolsIterations: 1 } }), {
      tool: 'test.lookupTool',
      handler: () => ({
        body: {
          id: 'c1',
          model: 'kimi',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
                ],
              },
            },
          ],
        },
      }),
    });
    expect(fake.requests.length).toBeLessThanOrEqual(2);
  });

  it('refuses a tool that waits before anything is sent', async () => {
    const { fake, result } = await runMoonshot(moonText({ hideTools: 'show' }), { tool: 'test.waitTool' });
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('Nodes that wait for an answer cannot be used as tools');
    expect(fake.requests).toHaveLength(0);
  });

  it('keeps the key out of a failure message', async () => {
    const { out } = await runMoonshot(moonText(), {
      onError: 'continueRegularOutput',
      handler: () => ({ status: 401, body: { error: { message: `bad ${MOON_KEY}`, type: 'auth' } } }),
    });
    expect(String(out[0]!.error)).not.toContain(MOON_KEY);
  });
});

describe('Moonshot image.analyze', () => {
  it('sends the binary image fields as image parts with the question and Max Tokens', async () => {
    const { fake, out } = await runMoonshot(
      moonImage({ binaryPropertyName: 'a, b', options: { maxTokens: 200 } }),
      {
        items: [
          binaryItem({
            a: { text: 'ONE', mimeType: 'image/png', fileName: 'a.png' },
            b: { text: 'TWO', mimeType: 'image/jpeg', fileName: 'b.jpg' },
          }),
        ],
      },
    );
    const request = fake.requests[0]!;
    expect(request.url).toBe(`${MOON_URL}/chat/completions`);
    expect(request.body).toMatchObject({ max_tokens: 200, model: 'moonshot-v1-8k-vision-preview' });
    const content = (request.body as any).messages[0].content as DataObject[];
    expect(content[0]).toEqual({ type: 'text', text: 'Describe it' });
    expect(content.slice(1)).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64('ONE')}` } },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64('TWO')}` } },
    ]);
    expect((request.body as DataObject).tools).toBeUndefined();
    expect(out).toEqual([{ output: 'ok' }]);
  });

  it('downloads an image URL through the guard and sends it', async () => {
    const { fake } = await runMoonshot(
      moonImage({ inputType: 'url', url: 'https://cdn.example.com/x.png' }),
      {
        handler: (request) =>
          request.method === 'GET'
            ? { body: bytes('URLBYTES'), headers: { 'content-type': 'image/png' } }
            : chatReply('a cat'),
      },
    );
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]!.headers?.authorization).toBeUndefined();
    const content = (fake.requests[1]!.body as any).messages[0].content as DataObject[];
    expect(content[1]).toMatchObject({ type: 'image_url' });
  });

  it('refuses a file that is not an image before anything is sent', async () => {
    const { fake, result } = await runMoonshot(moonImage(), {
      items: [binaryItem({ data: { text: 'PDF', mimeType: 'application/pdf' } })],
    });
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('is not an image');
    expect(fake.requests).toHaveLength(0);
  });
});
