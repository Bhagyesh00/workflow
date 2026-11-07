/**
 * P5-31 OpenAI vendor node: one recorded call per operation (text, image, audio, file, conversation,
 * video), a tool turn, Simplify on and off, binary replies, the fixed error texts and no partner header.
 * Replies are fixtures written from the OpenAI API reference; they prove the request we send.
 */
import { NodeTypes } from '@workflow/core';
import type { AiTool, DataObject, Item, NodeType } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { OpenAiNode } from '../src/nodes/vendors/openai/OpenAi.node';
import { videoPoll } from '../src/nodes/vendors/openai/video';
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

const KEY = 'sk-test-key-0123456789abcdef';
const BASE = 'https://openai.test/v1';

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

const types = new NodeTypes([...nodes, ...testNodes, toolNode('test.lookupTool', false), toolNode('test.waitTool', true)]);

const responses = (text: string, extra: DataObject = {}): FakeReply => ({
  body: {
    id: 'resp_1',
    model: 'gpt-5-mini',
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 5, output_tokens: 3 },
    ...extra,
  },
});

const bytes = (text: string) => new TextEncoder().encode(text);
const b64 = (text: string) => Buffer.from(text).toString('base64');

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

async function runOpenAi(params: DataObject, options: RunOptions = {}) {
  const fake = new FakeHttpClient(options.handler ?? (() => responses('ok')));
  const list = [
    node('Trigger', 'test.trigger'),
    node('OpenAI', 'ai.openAi', params, {
      credentials: { openAiApi: { id: 'c', name: 'c' } },
      ...(options.onError ? { onError: options.onError } : {}),
    }),
    ...(options.tool ? [node('Tool', options.tool)] : []),
  ];
  const result = await run(
    list,
    connect(['Trigger', 'OpenAI'], ...(options.tool ? [['Tool', 'OpenAI', 'ai_tool'] as Link] : [])),
    {
      nodeTypes: types,
      triggerItems: options.items,
      services: services({
        nodeTypes: types,
        creds: { openAiApi: { apiKey: KEY, baseUrl: BASE, organization: 'org-1' } },
        http: fake,
      }),
    },
  );
  const main = (result.runData.OpenAI?.at(-1)?.data?.main?.[0] ?? []) as Item[];
  return { result, fake, out: result.output('OpenAI'), items: main };
}

const message = (content: string, role = 'user') => ({ messages: { values: [{ role, content }] } });
const response = (params: DataObject = {}) => ({
  resource: 'text',
  operation: 'response',
  modelId: { __rl: true, mode: 'id', value: 'gpt-5-mini' },
  ...message('Hello'),
  ...params,
});

const decode = (item: Item, field = 'data') => {
  const file = item.binary?.[field];
  return {
    mimeType: file?.mimeType,
    fileName: file?.fileName,
    text: file?.data ? Buffer.from(file.data, 'base64').toString('utf8') : undefined,
  };
};

beforeEach(() => {
  calls.length = 0;
  videoPoll.intervalMs = 5;
});
afterEach(() => {
  videoPoll.intervalMs = 5000;
});

describe('node shell', () => {
  it('is not usable as a tool and has the six resources', () => {
    expect(OpenAiNode.description.usableAsTool).toBeUndefined();
    const resource = OpenAiNode.description.properties.find((p) => p.name === 'resource');
    expect((resource?.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'text',
      'image',
      'audio',
      'file',
      'conversation',
      'video',
    ]);
  });

  it('puts the Tools port on Message a Model only once Hide Tools is Show', () => {
    const body = String(OpenAiNode.description.inputs).slice(3, -2);
    const evaluate = (p: DataObject) => new Function('$parameter', `return ${body}`)(p) as unknown[];
    expect(evaluate({ resource: 'text', operation: 'response', hideTools: 'hide' })).toEqual(['main']);
    expect(evaluate({ resource: 'text', operation: 'response', hideTools: 'show' })).toHaveLength(2);
    expect(evaluate({ resource: 'image', operation: 'generate', hideTools: 'show' })).toEqual(['main']);
  });

  it('lists models and files for the pickers', async () => {
    const ctx = {
      getCredentials: async () => ({ baseUrl: BASE }),
      helpers: {
        httpRequestWithAuthentication: async (_type: string, request: { url: string }) =>
          request.url.endsWith('/models')
            ? { data: [{ id: 'gpt-5-mini' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'o3' }] }
            : { data: [{ id: 'file-1', filename: 'a.txt' }, { id: 'file-2', filename: 'b.pdf' }] },
      },
    };
    const models = await OpenAiNode.methods!.listSearch!.modelSearch!(ctx as never);
    expect(models.results.map((r) => r.value)).toEqual(['gpt-5-mini', 'o3']);
    const mini = await OpenAiNode.methods!.listSearch!.modelSearch!(ctx as never, 'mini');
    expect(mini.results.map((r) => r.value)).toEqual(['gpt-5-mini']);
    const files = await OpenAiNode.methods!.listSearch!.fileSearch!(ctx as never, 'pdf');
    expect(files.results.map((r) => r.value)).toEqual(['file-2']);
  });
});

describe('text.response', () => {
  it('sends the messages to /responses with the key and no partner header', async () => {
    const { fake, out } = await runOpenAi(response());
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request.url).toBe(`${BASE}/responses`);
    expect(request.method).toBe('POST');
    expect(request.headers?.authorization).toBe(`Bearer ${KEY}`);
    expect(request.headers?.['openai-organization']).toBe('org-1');
    for (const name of Object.keys(request.headers ?? {})) {
      expect(name.toLowerCase()).not.toContain('openai-platform');
      expect(name.toLowerCase()).not.toContain('n8n');
    }
    expect(request.body).toMatchObject({ model: 'gpt-5-mini', input: [{ role: 'user', content: 'Hello' }] });
    expect(out[0]).toMatchObject({ text: 'ok', id: 'resp_1', model: 'gpt-5-mini' });
    expect(out[0]!.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it('returns the whole reply with Simplify Output off', async () => {
    const { out } = await runOpenAi(response({ simplify: false }));
    expect(out[0]).toMatchObject({ id: 'resp_1', status: 'completed', output_text: 'ok' });
    expect(Array.isArray(out[0]!.output)).toBe(true);
  });

  it('maps the options to the request', async () => {
    const { fake } = await runOpenAi(
      response({
        options: {
          instructions: 'Be brief',
          maxTokens: 64,
          temperature: 0.2,
          topP: 0.9,
          previousResponseId: 'resp_0',
          conversationId: 'conv_1',
          reasoning: { reasoningOptions: { effort: 'low', summary: 'auto' } },
          store: false,
          serviceTier: 'flex',
          promptCacheKey: 'k1',
          safetyIdentifier: 'u1',
          maxToolCalls: 3,
          parallelToolCalls: true,
          truncation: true,
          verbosity: 'low',
          include: 'code_interpreter_call.outputs',
          prompt: { promptOptions: { id: 'pmpt_1', version: '2', variables: '{"name":"Ada"}' } },
          textFormat: {
            values: { type: 'json_schema', name: 'answer', description: 'The answer', schema: '{"type":"object"}', strict: true },
          },
        },
      }),
    );
    const body = fake.requests[0]!.body as DataObject;
    expect(body).toMatchObject({
      max_output_tokens: 64,
      temperature: 0.2,
      top_p: 0.9,
      previous_response_id: 'resp_0',
      conversation: 'conv_1',
      reasoning: { effort: 'low', summary: 'auto' },
      store: false,
      service_tier: 'flex',
      prompt_cache_key: 'k1',
      safety_identifier: 'u1',
      max_tool_calls: 3,
      parallel_tool_calls: true,
      truncation: 'auto',
      include: ['code_interpreter_call.outputs'],
      prompt: { id: 'pmpt_1', version: '2', variables: { name: 'Ada' } },
      text: {
        verbosity: 'low',
        format: { type: 'json_schema', name: 'answer', description: 'The answer', strict: true },
      },
    });
    const input = body.input as DataObject[];
    expect(input[0]).toMatchObject({ role: 'system', content: 'Be brief' });
  });

  it('adds the built-in tools with their filters', async () => {
    const { fake } = await runOpenAi(
      response({
        builtInTools: {
          webSearch: { searchContextSize: 'high', allowedDomains: 'a.com, b.org', country: 'US', city: 'Austin' },
          fileSearch: { vectorStoreIds: 'vs_1, vs_2', maxResults: 4, filters: '{"type":"eq","key":"k","value":"v"}' },
          codeInterpreter: {},
        },
      }),
    );
    const tools = (fake.requests[0]!.body as DataObject).tools as DataObject[];
    expect(tools).toEqual([
      {
        type: 'web_search',
        search_context_size: 'high',
        user_location: { type: 'approximate', country: 'US', city: 'Austin' },
        filters: { allowed_domains: ['a.com', 'b.org'] },
      },
      {
        type: 'file_search',
        vector_store_ids: ['vs_1', 'vs_2'],
        max_num_results: 4,
        filters: { type: 'eq', key: 'k', value: 'v' },
      },
      { type: 'code_interpreter', container: { type: 'auto' } },
    ]);
  });

  it('runs a connected tool and sends its result back', async () => {
    const { fake, out } = await runOpenAi(response({ hideTools: 'show' }), {
      tool: 'test.lookupTool',
      handler: (_request, index) =>
        index === 0
          ? {
              body: {
                id: 'resp_a',
                status: 'completed',
                output: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }],
                usage: { input_tokens: 4, output_tokens: 2 },
              },
            }
          : responses('the answer is found x'),
    });
    expect(calls).toEqual([{ q: 'x' }]);
    expect(fake.requests).toHaveLength(2);
    const first = fake.requests[0]!.body as DataObject;
    expect((first.tools as DataObject[])[0]).toMatchObject({ type: 'function', name: 'lookup' });
    const second = (fake.requests[1]!.body as DataObject).input as DataObject[];
    expect(second.some((i) => i.type === 'function_call_output' && i.call_id === 'call_1' && i.output === 'found x')).toBe(
      true,
    );
    expect(out[0]!.text).toBe('the answer is found x');
    expect(out[0]!.usage).toEqual({ inputTokens: 9, outputTokens: 5 });
  });

  it('does not offer or run a connected tool while Hide Tools is Hide', async () => {
    const { fake, out } = await runOpenAi(response({ hideTools: 'hide' }), {
      tool: 'test.lookupTool',
      handler: () => responses('plain'),
    });
    expect((fake.requests[0]!.body as DataObject).tools).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(out[0]!.text).toBe('plain');
    // a saved waiting tool behind the hidden input does not stop the run
    const waiting = await runOpenAi(response(), { tool: 'test.waitTool' });
    expect(waiting.result.status).toBe('success');
    expect(waiting.fake.requests).toHaveLength(1);
  });

  it('refuses a tool that waits before anything is sent', async () => {
    const { fake, result } = await runOpenAi(response({ hideTools: 'show' }), { tool: 'test.waitTool' });
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('Nodes that wait for an answer cannot be used as tools');
    expect(fake.requests).toHaveLength(0);
  });

  it('reads a background response until it has finished', async () => {
    const { fake, out } = await runOpenAi(response({ options: { backgroundMode: true } }), {
      handler: (_request, index) => {
        if (index === 0) return { body: { id: 'resp_bg', status: 'queued', model: 'gpt-5-mini', output: [] } };
        if (index === 1) return { body: { id: 'resp_bg', status: 'in_progress', output: [] } };
        return responses('done later', { id: 'resp_bg' });
      },
    });
    expect((fake.requests[0]!.body as DataObject).background).toBe(true);
    expect(fake.requests[1]).toMatchObject({ method: 'GET', url: `${BASE}/responses/resp_bg` });
    expect(out[0]!.text).toBe('done later');
  });

  it('gives n8n texts for a spent quota and a rate limit', async () => {
    const quota = await runOpenAi(response(), {
      handler: () => ({ status: 429, body: { error: { code: 'insufficient_quota', message: `You exceeded ${KEY}` } } }),
    });
    expect(quota.result.status).toBe('error');
    expect(quota.result.error?.message).toContain('Insufficient quota detected');
    expect(JSON.stringify(quota.result.error)).not.toContain(KEY);
    const limit = await runOpenAi(response(), {
      handler: () => ({ status: 429, body: { error: { code: 'rate_limit_exceeded', message: 'slow down' } } }),
    });
    expect(limit.result.error?.message).toContain('OpenAI: Rate limit reached');
  });

  it('gives {error} for a failed item when continue on fail is on', async () => {
    const { out } = await runOpenAi(response(), {
      onError: 'continueRegularOutput',
      handler: () => ({ status: 500, body: { error: { message: `bad ${KEY}` } } }),
    });
    expect(out[0]!.error).toBeTypeOf('string');
    expect(String(out[0]!.error)).not.toContain(KEY);
  });
});

describe('text.classify', () => {
  const reply: FakeReply = {
    body: {
      id: 'modr-1',
      model: 'omni-moderation-latest',
      results: [{ flagged: true, categories: { violence: true }, category_scores: { violence: 0.9 } }],
    },
  };

  it('posts the text to /moderations with the omni model and returns the first result', async () => {
    const { fake, out } = await runOpenAi({ resource: 'text', operation: 'classify', input: 'bad words' }, { handler: () => reply });
    expect(fake.requests[0]).toMatchObject({ url: `${BASE}/moderations`, method: 'POST' });
    expect(fake.requests[0]!.body).toEqual({ input: 'bad words', model: 'omni-moderation-latest' });
    expect(out[0]).toEqual({
      flagged: true,
      categories: { violence: true },
      category_scores: { violence: 0.9 },
    });
  });

  it('simplifies to the flag, and has no Use Stable Model option', async () => {
    const { fake, out } = await runOpenAi(
      { resource: 'text', operation: 'classify', input: 'x', simplify: true, options: { useStableModel: true } },
      { handler: () => reply },
    );
    expect((fake.requests[0]!.body as DataObject).model).toBe('omni-moderation-latest');
    expect(out[0]).toEqual({ flagged: true });
    const names = OpenAiNode.description.properties
      .filter((p) => p.displayOptions?.show?.operation?.includes('classify'))
      .map((p) => p.name);
    expect(names).toEqual(['input', 'simplify']);
  });
});

describe('image', () => {
  it('generates with DALL-E 3 and returns a binary file', async () => {
    const { fake, items } = await runOpenAi(
      { resource: 'image', operation: 'generate', model: 'dall-e-3', prompt: 'a cat', options: { quality: 'hd', size: '1792x1024', style: 'natural', n: 1 } },
      { handler: () => ({ body: { created: 1, data: [{ b64_json: b64('PNGDATA'), revised_prompt: 'a nice cat' }] } }) },
    );
    expect(fake.requests[0]).toMatchObject({ url: `${BASE}/images/generations`, method: 'POST' });
    expect(fake.requests[0]!.body).toEqual({
      model: 'dall-e-3',
      prompt: 'a cat',
      n: 1,
      quality: 'hd',
      size: '1792x1024',
      style: 'natural',
      response_format: 'b64_json',
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.json).toEqual({ revised_prompt: 'a nice cat' });
    expect(decode(items[0]!)).toMatchObject({ mimeType: 'image/png', text: 'PNGDATA' });
  });

  it('asks a GPT Image model with no response format and gets every image', async () => {
    const { fake, items } = await runOpenAi(
      { resource: 'image', operation: 'generate', model: 'gpt-image-1', prompt: 'a dog', options: { n: 2, returnImageUrls: true } },
      { handler: () => ({ body: { output_format: 'webp', data: [{ b64_json: b64('A') }, { b64_json: b64('B') }] } }) },
    );
    expect(fake.requests[0]!.body).toEqual({ model: 'gpt-image-1', prompt: 'a dog', n: 2 });
    expect(items.map((i) => decode(i).text)).toEqual(['A', 'B']);
    expect(decode(items[0]!).mimeType).toBe('image/webp');
  });

  it('returns links when asked, and downloads a link without the key', async () => {
    const urlReply: FakeReply = { body: { data: [{ url: 'http://files.test/img.png' }] } };
    const links = await runOpenAi(
      { resource: 'image', operation: 'generate', model: 'dall-e-3', prompt: 'p', options: { returnImageUrls: true } },
      { handler: () => urlReply },
    );
    expect((links.fake.requests[0]!.body as DataObject).response_format).toBe('url');
    expect(links.out[0]).toEqual({ url: 'http://files.test/img.png' });

    // a reply with a link when files were asked for: the link is read with no credential
    const files = await runOpenAi(
      { resource: 'image', operation: 'generate', model: 'dall-e-2', prompt: 'p' },
      {
        handler: (request) =>
          request.url.startsWith('http://files.test')
            ? { body: bytes('IMG'), headers: { 'content-type': 'image/png' } }
            : urlReply,
      },
    );
    expect(files.fake.requests).toHaveLength(2);
    expect(files.fake.requests[1]!.url).toBe('http://files.test/img.png');
    expect(files.fake.requests[1]!.headers?.authorization).toBeUndefined();
    expect(decode(files.items[0]!).text).toBe('IMG');
  });

  it('analyzes an image from a URL with Detail on the image part', async () => {
    const { fake, out } = await runOpenAi(
      {
        resource: 'image',
        operation: 'analyze',
        modelId: { __rl: true, mode: 'id', value: 'gpt-4o' },
        text: 'Describe it',
        inputType: 'url',
        imageUrls: 'http://files.test/cat.png',
        options: { detail: 'high', maxTokens: 120 },
      },
      {
        handler: (request) =>
          request.url.startsWith('http://files.test')
            ? { body: bytes('CATPNG'), headers: { 'content-type': 'image/png' } }
            : responses('A cat.', { model: 'gpt-4o' }),
      },
    );
    const sent = fake.requests.find((r) => r.url === `${BASE}/responses`)!;
    expect(fake.requests.find((r) => r.url.startsWith('http://files.test'))!.headers?.authorization).toBeUndefined();
    const body = sent.body as DataObject;
    expect(body.model).toBe('gpt-4o');
    expect(body.max_output_tokens).toBe(120);
    expect((body.input as DataObject[])[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'Describe it' },
        { type: 'input_image', image_url: `data:image/png;base64,${b64('CATPNG')}`, detail: 'high' },
      ],
    });
    expect(out[0]).toEqual({ text: 'A cat.', model: 'gpt-4o' });
  });

  it('image analyze does not offer a connected tool', async () => {
    const { fake, result } = await runOpenAi(
      {
        resource: 'image',
        operation: 'analyze',
        modelId: { __rl: true, mode: 'id', value: 'gpt-4o' },
        text: 'Describe it',
        inputType: 'base64',
        binaryPropertyName: 'data',
      },
      {
        tool: 'test.waitTool',
        items: [binaryItem({ data: { text: 'IMG', mimeType: 'image/png' } })],
        handler: () => responses('A cat.', { model: 'gpt-4o' }),
      },
    );
    expect(result.status).toBe('success');
    expect((fake.requests[0]!.body as DataObject).tools).toBeUndefined();
  });

  it('analyzes a binary image and sends no detail for auto', async () => {
    const { fake } = await runOpenAi(
      {
        resource: 'image',
        operation: 'analyze',
        modelId: { __rl: true, mode: 'id', value: 'gpt-4o' },
        inputType: 'base64',
        binaryPropertyName: 'pic',
      },
      { items: [binaryItem({ pic: { text: 'JPG', mimeType: 'image/jpeg' } })] },
    );
    const content = ((fake.requests[0]!.body as DataObject).input as DataObject[])[0]!.content as DataObject[];
    expect(content[0]).toEqual({ type: 'input_text', text: "What's in this image?" });
    expect(content[1]).toEqual({ type: 'input_image', image_url: `data:image/jpeg;base64,${b64('JPG')}` });
  });

  it('edits images with a mask as multipart', async () => {
    const { fake, items } = await runOpenAi(
      {
        resource: 'image',
        operation: 'edit',
        model: 'gpt-image-1',
        prompt: 'add a hat',
        images: 'one, two',
        options: { n: 1, size: '1024x1024', quality: 'high', outputFormat: 'jpeg', outputCompression: 80, background: 'opaque', inputFidelity: 'high', mask: 'mask' },
      },
      {
        items: [
          binaryItem({
            one: { text: 'ONE', mimeType: 'image/png', fileName: 'one.png' },
            two: { text: 'TWO', mimeType: 'image/png' },
            mask: { text: 'MASK', mimeType: 'image/png', fileName: 'm.png' },
          }),
        ],
        handler: () => ({ body: { output_format: 'jpeg', data: [{ b64_json: b64('EDITED') }] } }),
      },
    );
    const request = fake.requests[0]!;
    expect(request).toMatchObject({ url: `${BASE}/images/edits`, method: 'POST', bodyType: 'multipart' });
    const body = request.body as Record<string, any>;
    expect(body.model).toBe('gpt-image-1');
    expect(body.prompt).toBe('add a hat');
    expect(body['image[]']).toHaveLength(2);
    expect(body['image[]'][0]).toMatchObject({ fileName: 'one.png', mimeType: 'image/png' });
    expect(Buffer.from(body['image[]'][0].data).toString()).toBe('ONE');
    expect(Buffer.from(body.mask.data).toString()).toBe('MASK');
    expect(body).toMatchObject({
      n: 1,
      size: '1024x1024',
      quality: 'high',
      output_format: 'jpeg',
      output_compression: 80,
      background: 'opaque',
      input_fidelity: 'high',
    });
    expect(decode(items[0]!)).toMatchObject({ mimeType: 'image/jpeg', text: 'EDITED' });
  });
});

describe('audio', () => {
  it('generates speech into a binary field', async () => {
    const { fake, items } = await runOpenAi(
      {
        resource: 'audio',
        operation: 'generate',
        model: 'tts-1-hd',
        input: 'Hi there',
        voice: 'nova',
        options: { response_format: 'wav', speed: 1.5, binaryPropertyOutput: 'speech' },
      },
      { handler: () => ({ body: bytes('WAVDATA'), headers: { 'content-type': 'audio/wav' } }) },
    );
    expect(fake.requests[0]).toMatchObject({ url: `${BASE}/audio/speech`, method: 'POST', responseType: 'arraybuffer' });
    expect(fake.requests[0]!.body).toEqual({
      model: 'tts-1-hd',
      input: 'Hi there',
      voice: 'nova',
      response_format: 'wav',
      speed: 1.5,
    });
    expect(decode(items[0]!, 'speech')).toMatchObject({ mimeType: 'audio/wav', text: 'WAVDATA' });
  });

  it('transcribes a recording with its language and temperature', async () => {
    const { fake, out } = await runOpenAi(
      { resource: 'audio', operation: 'transcribe', binaryPropertyName: 'rec', options: { language: 'de', temperature: 0.2 } },
      {
        items: [binaryItem({ rec: { text: 'SOUND', mimeType: 'audio/mpeg', fileName: 'a.mp3' } })],
        handler: () => ({ body: { text: 'Hallo Welt' } }),
      },
    );
    const request = fake.requests[0]!;
    expect(request).toMatchObject({ url: `${BASE}/audio/transcriptions`, bodyType: 'multipart' });
    const body = request.body as Record<string, any>;
    expect(body).toMatchObject({ model: 'whisper-1', language: 'de', temperature: 0.2 });
    expect(body.file).toMatchObject({ fileName: 'a.mp3', mimeType: 'audio/mpeg' });
    expect(Buffer.from(body.file.data).toString()).toBe('SOUND');
    expect(out[0]).toEqual({ text: 'Hallo Welt' });
  });

  it('translates a recording and sends no language', async () => {
    const { fake, out } = await runOpenAi(
      { resource: 'audio', operation: 'translate', options: { temperature: 0 } },
      {
        items: [binaryItem({ data: { text: 'SOUND', mimeType: 'audio/mpeg' } })],
        handler: () => ({ body: { text: 'Hello world' } }),
      },
    );
    expect(fake.requests[0]!.url).toBe(`${BASE}/audio/translations`);
    expect(Object.keys(fake.requests[0]!.body as object).sort()).toEqual(['file', 'model', 'temperature']);
    expect(out[0]).toEqual({ text: 'Hello world' });
  });
});

describe('file', () => {
  it('uploads a binary field with a purpose', async () => {
    const { fake, out } = await runOpenAi(
      { resource: 'file', operation: 'upload', options: { purpose: 'assistants' } },
      {
        items: [binaryItem({ data: { text: 'DOC', mimeType: 'application/pdf', fileName: 'doc.pdf' } })],
        handler: () => ({ body: { id: 'file-1', object: 'file', filename: 'doc.pdf', purpose: 'assistants' } }),
      },
    );
    const request = fake.requests[0]!;
    expect(request).toMatchObject({ url: `${BASE}/files`, method: 'POST', bodyType: 'multipart' });
    const body = request.body as Record<string, any>;
    expect(body.purpose).toBe('assistants');
    expect(body.file).toMatchObject({ fileName: 'doc.pdf', mimeType: 'application/pdf' });
    expect(out[0]).toMatchObject({ id: 'file-1' });
  });

  it('lists files page by page, with a purpose filter', async () => {
    const { fake, out } = await runOpenAi(
      { resource: 'file', operation: 'list', returnAll: true, options: { purpose: 'vision' } },
      {
        handler: (_request, index) =>
          index === 0
            ? { body: { data: [{ id: 'file-1' }, { id: 'file-2' }], has_more: true, last_id: 'file-2' } }
            : { body: { data: [{ id: 'file-3' }], has_more: false, last_id: 'file-3' } },
      },
    );
    expect(fake.requests[0]).toMatchObject({ url: `${BASE}/files`, method: 'GET', qs: { limit: 100, purpose: 'vision' } });
    expect(fake.requests[1]!.qs).toMatchObject({ after: 'file-2' });
    expect(out.map((o) => o.id)).toEqual(['file-1', 'file-2', 'file-3']);
  });

  it('stops at the limit and sends no purpose for Any', async () => {
    const { fake, out } = await runOpenAi(
      { resource: 'file', operation: 'list', returnAll: false, limit: 2, options: { purpose: 'any' } },
      { handler: () => ({ body: { data: [{ id: 'a' }, { id: 'b' }], has_more: true, last_id: 'b' } }) },
    );
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.qs).toEqual({ limit: 2 });
    expect(out).toHaveLength(2);
  });

  it('deletes a file by id', async () => {
    const { fake, out } = await runOpenAi(
      { resource: 'file', operation: 'deleteFile', fileId: { __rl: true, mode: 'id', value: 'file-9' } },
      { handler: () => ({ body: { id: 'file-9', object: 'file', deleted: true } }) },
    );
    expect(fake.requests[0]).toMatchObject({ url: `${BASE}/files/file-9`, method: 'DELETE' });
    expect(out[0]).toEqual({ id: 'file-9', object: 'file', deleted: true });
  });
});

describe('conversation', () => {
  it('creates a conversation with messages and metadata', async () => {
    const { fake, out } = await runOpenAi(
      {
        resource: 'conversation',
        operation: 'create',
        messages: { values: [{ role: 'system', content: 'Be kind' }, { role: 'user', content: 'Hi' }] },
        metadata: '{"topic":"demo"}',
      },
      { handler: () => ({ body: { id: 'conv_1', object: 'conversation', metadata: { topic: 'demo' } } }) },
    );
    expect(fake.requests[0]).toMatchObject({ url: `${BASE}/conversations`, method: 'POST' });
    expect(fake.requests[0]!.body).toEqual({
      items: [
        { type: 'message', role: 'system', content: 'Be kind' },
        { type: 'message', role: 'user', content: 'Hi' },
      ],
      metadata: { topic: 'demo' },
    });
    expect(out[0]).toMatchObject({ id: 'conv_1' });
  });

  it('gets, updates and removes a conversation', async () => {
    const get = await runOpenAi(
      { resource: 'conversation', operation: 'get', conversationId: 'conv_1' },
      { handler: () => ({ body: { id: 'conv_1' } }) },
    );
    expect(get.fake.requests[0]).toMatchObject({ url: `${BASE}/conversations/conv_1`, method: 'GET' });

    const update = await runOpenAi(
      { resource: 'conversation', operation: 'update', conversationId: 'conv_1', metadata: '{"a":"b"}' },
      { handler: () => ({ body: { id: 'conv_1', metadata: { a: 'b' } } }) },
    );
    expect(update.fake.requests[0]).toMatchObject({ url: `${BASE}/conversations/conv_1`, method: 'POST' });
    expect(update.fake.requests[0]!.body).toEqual({ metadata: { a: 'b' } });

    const remove = await runOpenAi(
      { resource: 'conversation', operation: 'remove', conversationId: 'conv_1' },
      { handler: () => ({ body: { id: 'conv_1', object: 'conversation.deleted', deleted: true } }) },
    );
    expect(remove.fake.requests[0]).toMatchObject({ url: `${BASE}/conversations/conv_1`, method: 'DELETE' });
    expect(remove.out[0]!.deleted).toBe(true);
  });

  it('refuses metadata that is not a JSON object', async () => {
    const { result } = await runOpenAi({ resource: 'conversation', operation: 'update', conversationId: 'c', metadata: '[1]' });
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('must be a JSON object');
  });
});

describe('video', () => {
  const params = { resource: 'video', operation: 'generate', model: 'sora-2', prompt: 'a wave', seconds: '8', size: '720x1280' };

  it('starts the job, waits for it and reads the file from the credential host', async () => {
    let polls = 0;
    const { fake, items } = await runOpenAi(params, {
      handler: (request) => {
        if (request.method === 'POST') return { body: { id: 'video_1', status: 'queued' } };
        if (request.url.endsWith('/content')) return { body: bytes('MP4DATA'), headers: { 'content-type': 'video/mp4' } };
        polls++;
        return polls < 3
          ? { body: { id: 'video_1', status: 'in_progress', progress: 40 } }
          : { body: { id: 'video_1', status: 'completed', model: 'sora-2', seconds: '8', size: '720x1280' } };
      },
    });
    expect(fake.requests[0]).toMatchObject({ url: `${BASE}/videos`, method: 'POST' });
    expect(fake.requests[0]!.body).toEqual({ model: 'sora-2', prompt: 'a wave', seconds: '8', size: '720x1280' });
    expect(polls).toBe(3);
    const content = fake.requests.at(-1)!;
    expect(content).toMatchObject({ url: `${BASE}/videos/video_1/content`, method: 'GET', responseType: 'arraybuffer' });
    expect(content.headers?.authorization).toBe(`Bearer ${KEY}`);
    expect(decode(items[0]!)).toMatchObject({ mimeType: 'video/mp4', text: 'MP4DATA' });
    expect(items[0]!.json).toMatchObject({ id: 'video_1', status: 'completed' });
  });

  it('a content link that redirects to another host is fetched there with no key and no custom header', async () => {
    const seen: Array<{ url: string; headers: Record<string, unknown> }> = [];
    const fake = new FakeHttpClient((request): FakeReply => {
      seen.push({ url: request.url, headers: { ...(request.headers ?? {}) } });
      if (request.method === 'POST') return { body: { id: 'video_9', status: 'queued' } };
      if (request.url === `${BASE}/videos/video_9/content`) {
        return { status: 302, headers: { location: 'https://storage.other.test/video_9.mp4' } };
      }
      if (request.url === 'https://storage.other.test/video_9.mp4') {
        return { body: bytes('MP4DATA'), headers: { 'content-type': 'video/mp4' } };
      }
      return { body: { id: 'video_9', status: 'completed' } };
    });
    const list = [
      node('Trigger', 'test.trigger'),
      node('OpenAI', 'ai.openAi', params, { credentials: { openAiApi: { id: 'c', name: 'c' } } }),
    ];
    const result = await run(list, connect(['Trigger', 'OpenAI']), {
      nodeTypes: types,
      services: services({
        nodeTypes: types,
        creds: {
          openAiApi: {
            apiKey: KEY,
            baseUrl: BASE,
            organization: 'org-1',
            header: true,
            headerName: 'api-key',
            headerValue: 'gateway-secret-value',
          },
        },
        http: fake,
      }),
    });
    expect(result.status).toBe('success');
    const content = fake.requests.find((r) => r.url === `${BASE}/videos/video_9/content`)!;
    expect(content.followRedirects).toBe(false);
    expect(content.headers?.authorization).toBe(`Bearer ${KEY}`);
    const landed = seen.find((r) => r.url === 'https://storage.other.test/video_9.mp4')!;
    expect(JSON.stringify(landed.headers)).not.toContain(KEY);
    expect(JSON.stringify(landed.headers)).not.toContain('gateway-secret-value');
    expect(JSON.stringify(landed.headers)).not.toContain('org-1');
    const delivered = result.runData.OpenAI!.at(-1)!.data!.main![0]![0] as Item;
    expect(decode(delivered)).toMatchObject({ text: 'MP4DATA' });
  });

  it('sends a reference image as multipart', async () => {
    const { fake } = await runOpenAi(
      { ...params, options: { referenceImage: 'ref', outputField: 'clip' } },
      {
        items: [binaryItem({ ref: { text: 'REF', mimeType: 'image/png', fileName: 'ref.png' } })],
        handler: (request) =>
          request.method === 'POST'
            ? { body: { id: 'v2', status: 'queued' } }
            : request.url.endsWith('/content')
              ? { body: bytes('X') }
              : { body: { id: 'v2', status: 'completed' } },
      },
    );
    expect(fake.requests[0]!.bodyType).toBe('multipart');
    const reference = (fake.requests[0]!.body as Record<string, any>).input_reference;
    expect(reference).toMatchObject({ fileName: 'ref.png', mimeType: 'image/png' });
    expect(Buffer.from(reference.data).toString()).toBe('REF');
  });

  it('fails with the reason when the job fails', async () => {
    const { result } = await runOpenAi(params, {
      handler: (request) =>
        request.method === 'POST'
          ? { body: { id: 'v3', status: 'queued' } }
          : { body: { id: 'v3', status: 'failed', error: { message: 'Blocked by moderation' } } },
    });
    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('The video failed: Blocked by moderation');
  });

  it('stops waiting after the Wait Timeout', async () => {
    videoPoll.intervalMs = 1;
    const { result, fake } = await runOpenAi(
      { ...params, options: { waitTimeout: 0.05 } },
      {
        handler: (request) =>
          request.method === 'POST'
            ? { body: { id: 'v4', status: 'queued' } }
            : { body: { id: 'v4', status: 'in_progress' } },
      },
    );
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('The video was not ready after 0.05 seconds');
    expect(fake.requests.some((r) => r.url.endsWith('/content'))).toBe(false);
  });
});

describe('credentials and hosts', () => {
  it('sends every request to the credential host with the key and never a partner header', async () => {
    const { fake } = await runOpenAi({ resource: 'conversation', operation: 'get', conversationId: 'c1' }, { handler: () => ({ body: {} }) });
    for (const request of fake.requests) {
      expect(new URL(request.url).host).toBe('openai.test');
      expect(request.headers?.authorization).toBe(`Bearer ${KEY}`);
      expect(JSON.stringify(request.headers).toLowerCase()).not.toContain('openai-platform');
    }
  });

  it('puts an id with a slash in the path as one segment', async () => {
    const { fake } = await runOpenAi(
      { resource: 'conversation', operation: 'get', conversationId: 'a/b?x=1' },
      { handler: () => ({ body: {} }) },
    );
    expect(fake.requests[0]!.url).toBe(`${BASE}/conversations/a%2Fb%3Fx%3D1`);
  });
});
