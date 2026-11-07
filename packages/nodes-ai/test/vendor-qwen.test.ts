/**
 * P5-35 Qwen Cloud node: one recorded call per operation on FakeHttpClient (bodies written from the
 * DashScope API docs), a tool turn, async tasks pending then done, a failed task's text, and no credential
 * header on the media host.
 */
import { NodeTypes } from '@workflow/core';
import type { AiTool, DataObject, Item, LoadOptionsContext, NodeType } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { AlibabaCloudNode } from '../src/nodes/vendors/alibaba/AlibabaCloud.node';
import { pollTiming, qwenListSearch } from '../src/nodes/vendors/alibaba/text';
import {
  connect,
  type FakeHandler,
  FakeHttpClient,
  type Link,
  node,
  run,
  services,
  testNodes,
} from './harness';

const KEY = 'sk-qwentestkey0123456789abcdef';
const HOST = 'http://qwen.test';
const MEDIA = 'http://media.test';

const calls: DataObject[] = [];
const toolNode: NodeType = {
  description: {
    name: 'test.qwenLookup',
    displayName: 'Lookup',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Lookup' },
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
      invoke: async (args) => {
        calls.push(args);
        return `found ${String(args.q)}`;
      },
    };
    return { response: tool };
  },
};
const types = new NodeTypes([...nodes, ...testNodes, toolNode]);

const answer = (text: string, extra: DataObject = {}) => ({
  body: {
    output: { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] },
    usage: { input_tokens: 4, output_tokens: 2 },
    request_id: 'r1',
    ...extra,
  },
});

const multimodalAnswer = (text: string) => ({
  body: {
    output: { choices: [{ message: { role: 'assistant', content: [{ text }] }, finish_reason: 'stop' }] },
    usage: { input_tokens: 9, output_tokens: 3 },
  },
});

const taskCreated = (id = 'task-1') => ({
  body: { output: { task_id: id, task_status: 'PENDING' }, request_id: 'r2' },
});
const taskState = (output: DataObject) => ({ body: { output, request_id: 'r3' } });

const b64 = (text: string) => Buffer.from(text).toString('base64');
const bin = (text: string, mimeType: string, fileName?: string) => ({
  data: b64(text),
  mimeType,
  fileName,
  fileSize: text.length,
});

async function qwen(
  params: DataObject,
  options: {
    handler?: FakeHandler;
    items?: Item[];
    tool?: boolean;
    onError?: 'continueRegularOutput';
    creds?: DataObject;
  } = {},
) {
  const fake = new FakeHttpClient(options.handler ?? (() => answer('ok')));
  const links: Link[] = [['Trigger', 'Qwen']];
  if (options.tool) links.push(['Tool', 'Qwen', 'ai_tool']);
  const result = await run(
    [
      node('Trigger', 'test.trigger'),
      node('Qwen', 'ai.alibabaCloud', params, {
        credentials: { alibabaCloudApi: { id: 'c', name: 'c' } },
        ...(options.onError ? { onError: options.onError } : {}),
      }),
      ...(options.tool ? [node('Tool', 'test.qwenLookup')] : []),
    ],
    connect(...links),
    {
      nodeTypes: types,
      triggerItems: options.items,
      services: services({
        nodeTypes: types,
        creds: { alibabaCloudApi: { apiKey: KEY, url: HOST, ...(options.creds ?? {}) } },
        http: fake,
      }),
    },
  );
  const runs = result.runData.Qwen ?? [];
  const items = (runs[runs.length - 1]?.data?.main?.[0] ?? []) as Item[];
  return { result, fake, out: result.output('Qwen'), items };
}

const msg = (content: string, extra: DataObject = {}) => ({
  messages: { values: [{ role: 'user', content, ...extra }] },
});

const header = (request: { headers?: Record<string, unknown> }, name: string): unknown => {
  const found = Object.entries(request.headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return found?.[1];
};

beforeEach(() => {
  calls.length = 0;
  pollTiming.imageIntervalMs = 5;
  pollTiming.videoIntervalMs = 5;
});
afterEach(() => {
  pollTiming.imageIntervalMs = 3000;
  pollTiming.videoIntervalMs = 10_000;
  pollTiming.imageTimeoutMs = 5 * 60 * 1000;
  pollTiming.videoTimeoutMs = 20 * 60 * 1000;
});

describe('node shape', () => {
  it('has the resources, the Tools input only for Message a Model, and the pickers', () => {
    const description = AlibabaCloudNode.description;
    expect(description.name).toBe('ai.alibabaCloud');
    expect(description.credentials?.[0]?.name).toBe('alibabaCloudApi');
    const resource = description.properties.find((p) => p.name === 'resource') as any;
    expect(resource.options.map((o: any) => o.value)).toEqual(['text', 'image', 'video']);
    const inputs = String(description.inputs).slice(3, -2);
    const evaluate = (resource: string, operation: string) =>
      new Function('$parameter', `return ${inputs}`)({ resource, operation }) as unknown[];
    expect(evaluate('text', 'message')).toHaveLength(2);
    expect(evaluate('image', 'generate')).toEqual(['main']);
    expect(evaluate('video', 'textToVideo')).toEqual(['main']);
    expect(Object.keys(AlibabaCloudNode.methods?.listSearch ?? {}).sort()).toEqual([
      'textModels',
      'visionModels',
    ]);
  });

  it('lists chat and vision models from the compatible-mode list', async () => {
    const ctx = {
      getCredentials: async () => ({ apiKey: KEY, url: HOST }),
      helpers: {
        httpRequestWithAuthentication: async (_type: string, request: { url: string }) => {
          expect(request.url).toBe(`${HOST}/compatible-mode/v1/models`);
          return {
            data: [
              { id: 'qwen3-max' },
              { id: 'qwen-plus' },
              { id: 'qwen3-vl-flash' },
              { id: 'text-embedding-v4' },
              { id: 'qwen-image-plus' },
            ],
          };
        },
      },
    } as unknown as LoadOptionsContext;
    const values = async (method: string, filter?: string) =>
      (await qwenListSearch[method]!(ctx, filter)).results.map((r) => r.value);
    expect(await values('textModels')).toEqual(['qwen3-max', 'qwen-plus']);
    expect(await values('textModels', 'PLUS')).toEqual(['qwen-plus']);
    expect(await values('visionModels')).toEqual(['qwen3-vl-flash']);
  });
});

describe('text.message', () => {
  it('sends the native call with the key, the workspace header and the options', async () => {
    const { fake, out } = await qwen(
      {
        resource: 'text',
        operation: 'message',
        modelId: { __rl: true, mode: 'list', value: 'qwen3-max' },
        messages: {
          values: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'second' },
            { role: 'user', content: 'third' },
          ],
        },
        options: {
          system: 'be brief',
          temperature: 0.3,
          maxTokens: 50,
          topK: 40,
          topP: 0.8,
          repetitionPenalty: 1.2,
          seed: 7,
          stop: 'END, STOP',
          enableSearch: true,
        },
      },
      { handler: () => answer('hello'), creds: { workspaceId: ' ws-9 ' } },
    );
    expect(out[0]).toEqual({ content: 'hello' });
    const req = fake.requests[0]!;
    expect(req.url).toBe(`${HOST}/api/v1/services/aigc/text-generation/generation`);
    expect(req.method).toBe('POST');
    expect(header(req, 'authorization')).toBe(`Bearer ${KEY}`);
    expect(header(req, 'x-dashscope-workspace')).toBe('ws-9');
    const body = req.body as any;
    expect(body.model).toBe('qwen3-max');
    expect(body.input.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]);
    expect(body.parameters).toMatchObject({
      result_format: 'message',
      temperature: 0.3,
      max_tokens: 50,
      top_k: 40,
      top_p: 0.8,
      repetition_penalty: 1.2,
      seed: 7,
      stop: ['END', 'STOP'],
      enable_search: true,
    });
    expect(body.parameters.tools).toBeUndefined();
  });

  it('sends no workspace header when the credential has none', async () => {
    const { fake } = await qwen({ resource: 'text', operation: 'message', ...msg('hi') });
    expect(header(fake.requests[0]!, 'x-dashscope-workspace')).toBeUndefined();
  });

  it('gives {content, model, usage, fullResponse} with Simplify off, as n8n does', async () => {
    const { out } = await qwen({ resource: 'text', operation: 'message', ...msg('hi'), simplify: false });
    expect(out[0]).toMatchObject({
      content: 'ok',
      model: 'qwen3.5-flash',
      usage: { input_tokens: 4, output_tokens: 2 },
      fullResponse: { request_id: 'r1' },
    });
    expect((out[0] as any).mergedResponse).toBeUndefined();
    const simple = await qwen({ resource: 'text', operation: 'message', ...msg('hi') });
    expect(simple.out[0]).toEqual({ content: 'ok' });
  });

  it('has the n8n options, defaults and ranges', () => {
    const props = AlibabaCloudNode.description.properties as any[];
    const options = props.find(
      (p) => p.name === 'options' && p.displayOptions?.show?.resource?.[0] === 'text',
    );
    const byName = (name: string) => options.options.find((o: any) => o.name === name);
    expect(byName('topK')).toMatchObject({ default: 50, typeOptions: { minValue: 1, maxValue: 100 } });
    expect(byName('topP')).toMatchObject({ default: 0.9, typeOptions: { minValue: 0, maxValue: 1 } });
    expect(byName('repetitionPenalty')).toMatchObject({
      default: 1.1,
      typeOptions: { minValue: 1, maxValue: 2 },
    });
    expect(byName('temperature')).toMatchObject({ default: 1, typeOptions: { minValue: 0, maxValue: 2 } });
    expect(byName('system')).toBeTruthy();
    const model = props.find((p) => p.name === 'modelId' && p.displayOptions?.show?.resource?.[0] === 'text');
    expect(model.default.value).toBe('qwen3.5-flash');
    const messages = props.find((p) => p.name === 'messages');
    const roles = messages.options[0].values
      .find((v: any) => v.name === 'role')
      .options.map((o: any) => o.value);
    expect(roles).toEqual(['user', 'assistant']);
  });

  it('runs a connected tool and sends its result back', async () => {
    const { fake, out } = await qwen(
      { resource: 'text', operation: 'message', ...msg('find x') },
      {
        tool: true,
        handler: (_req, index) =>
          index === 0
            ? {
                body: {
                  output: {
                    choices: [
                      {
                        message: {
                          role: 'assistant',
                          content: '',
                          tool_calls: [
                            {
                              id: 'call_1',
                              type: 'function',
                              function: { name: 'lookup', arguments: '{"q":"x"}' },
                            },
                          ],
                        },
                        finish_reason: 'tool_calls',
                      },
                    ],
                  },
                  usage: { input_tokens: 5, output_tokens: 3 },
                },
              }
            : answer('it is found'),
      },
    );
    expect(out[0]).toEqual({ content: 'it is found' });
    expect(calls).toEqual([{ q: 'x' }]);
    const first = fake.requests[0]!.body as any;
    expect(first.parameters.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Looks a value up',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    });
    const second = (fake.requests[1]!.body as any).input.messages;
    expect(second[second.length - 2].tool_calls[0]).toMatchObject({
      id: 'call_1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":"x"}' },
    });
    expect(second[second.length - 1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'found x',
    });
  });

  it('refuses a tool that waits before any request', async () => {
    const waiting: NodeType = {
      ...toolNode,
      description: { ...toolNode.description, name: 'test.qwenWait' },
      async supplyData(...args) {
        const made = await toolNode.supplyData!(...args);
        return { response: { ...(made.response as AiTool), canWait: true } };
      },
    };
    const withWait = new NodeTypes([...nodes, ...testNodes, waiting]);
    const fake = new FakeHttpClient(() => answer('x'));
    const result = await run(
      [
        node('Trigger', 'test.trigger'),
        node(
          'Qwen',
          'ai.alibabaCloud',
          { resource: 'text', operation: 'message', ...msg('hi') },
          { credentials: { alibabaCloudApi: { id: 'c', name: 'c' } } },
        ),
        node('Tool', 'test.qwenWait'),
      ],
      connect(['Trigger', 'Qwen'], ['Tool', 'Qwen', 'ai_tool']),
      {
        nodeTypes: withWait,
        services: services({
          nodeTypes: withWait,
          creds: { alibabaCloudApi: { apiKey: KEY, url: HOST } },
          http: fake,
        }),
      },
    );
    expect(result.status).toBe('error');
    expect(JSON.stringify(result.error)).toContain('cannot be used as tools');
    expect(fake.requests).toHaveLength(0);
  });

  it('gives {error} with continue-on-fail, with the key redacted', async () => {
    const { items, result } = await qwen(
      { resource: 'text', operation: 'message', ...msg('hi') },
      {
        onError: 'continueRegularOutput',
        handler: () => ({
          status: 401,
          body: { code: 'InvalidApiKey', message: `Invalid API-key provided: Bearer ${KEY}` },
        }),
      },
    );
    expect(result.status).toBe('success');
    const text = String((items[0]!.json as any).error);
    expect(text).toBeTruthy();
    expect(text).not.toContain(KEY);
  });
});

describe('image.analyze', () => {
  it('sends image links and the question to the multimodal endpoint', async () => {
    const { fake, out } = await qwen(
      {
        resource: 'image',
        operation: 'analyze',
        modelId: 'qwen3-vl-flash',
        question: 'what is this',
        inputType: 'url',
        imageUrl: 'http://img.test/a.png, http://img.test/b.png',
        visionOptions: { maxTokens: 300, temperature: 0.2 },
      },
      { handler: () => multimodalAnswer('a cat') },
    );
    expect(out[0]).toEqual({ content: 'a cat' });
    const req = fake.requests[0]!;
    expect(req.url).toBe(`${HOST}/api/v1/services/aigc/multimodal-generation/generation`);
    expect(req.body).toEqual({
      model: 'qwen3-vl-flash',
      input: {
        messages: [
          {
            role: 'user',
            content: [
              { image: 'http://img.test/a.png' },
              { image: 'http://img.test/b.png' },
              { text: 'what is this' },
            ],
          },
        ],
      },
      parameters: { temperature: 0.2, max_tokens: 300 },
    });
    expect(fake.requests).toHaveLength(1);
  });

  it('sends binary fields inline', async () => {
    const { fake, out } = await qwen(
      { resource: 'image', operation: 'analyze', inputType: 'binary', binaryPropertyName: 'data' },
      {
        items: [{ json: {}, binary: { data: bin('AAA', 'image/png') } }],
        handler: () => multimodalAnswer('a dog'),
      },
    );
    expect(out[0]).toEqual({ content: 'a dog' });
    const content = (fake.requests[0]!.body as any).input.messages[0].content;
    expect(content[0]).toEqual({ image: `data:image/png;base64,${b64('AAA')}` });
    expect(content[1]).toEqual({ text: "What's in this image?" });
  });

  it('gives {content, model, usage, fullResponse} with Simplify off', async () => {
    const { out } = await qwen(
      {
        resource: 'image',
        operation: 'analyze',
        modelId: 'qwen3-vl-plus',
        question: 'q',
        inputType: 'url',
        imageUrl: 'http://img.test/a.png',
        simplify: false,
      },
      { handler: () => multimodalAnswer('a cat') },
    );
    expect(out[0]).toMatchObject({
      content: 'a cat',
      model: 'qwen3-vl-plus',
      usage: { input_tokens: 9, output_tokens: 3 },
    });
    expect((out[0] as any).fullResponse.output.choices).toHaveLength(1);
  });

  it('refuses a link that is not http', async () => {
    const { result, fake } = await qwen({
      resource: 'image',
      operation: 'analyze',
      inputType: 'url',
      imageUrl: 'file:///etc/passwd',
    });
    expect(result.status).toBe('error');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('image.generate', () => {
  const wanDone = (url: string, extra: DataObject = {}) =>
    taskState({
      task_status: 'SUCCEEDED',
      choices: [{ message: { content: [{ image: url }] } }],
      ...extra,
    });

  it('creates a Wan 2.6 task, polls pending then done, and downloads the image with no key', async () => {
    let polls = 0;
    const { fake, items } = await qwen(
      {
        resource: 'image',
        operation: 'generate',
        modelId: 'wan2.6-t2i',
        prompt: 'a red fox',
        imageOptions: { size: '1104*1472', promptExtend: true },
      },
      {
        handler: (req) => {
          if (req.url.startsWith(MEDIA)) {
            return { body: Buffer.from('PNGDATA'), headers: { 'content-type': 'image/png' } };
          }
          if (req.method === 'POST') return taskCreated();
          polls++;
          return polls === 1
            ? taskState({ task_id: 'task-1', task_status: 'RUNNING' })
            : {
                body: {
                  output: {
                    task_id: 'task-1',
                    task_status: 'SUCCEEDED',
                    choices: [{ message: { content: [{ image: `${MEDIA}/fox.png` }] } }],
                  },
                  usage: { image_count: 1 },
                },
              };
        },
      },
    );
    const create = fake.requests[0]!;
    expect(create.url).toBe(`${HOST}/api/v1/services/aigc/image-generation/generation`);
    expect(header(create, 'x-dashscope-async')).toBe('enable');
    expect(header(create, 'authorization')).toBe(`Bearer ${KEY}`);
    expect(create.body).toEqual({
      model: 'wan2.6-t2i',
      input: { messages: [{ role: 'user', content: [{ text: 'a red fox' }] }] },
      parameters: { prompt_extend: true, n: 1, size: '1104*1472' },
    });
    const pollRequests = fake.requests.filter((r) => r.url === `${HOST}/api/v1/tasks/task-1`);
    expect(pollRequests).toHaveLength(2);
    expect(header(pollRequests[0]!, 'x-dashscope-async')).toBeUndefined();
    const media = fake.requests.find((r) => r.url.startsWith(MEDIA))!;
    expect(header(media, 'authorization')).toBeUndefined();
    expect(header(media, 'x-dashscope-workspace')).toBeUndefined();
    expect(JSON.stringify(media.headers ?? {})).not.toContain(KEY);
    expect(items).toHaveLength(1);
    expect(items[0]!.json).toEqual({
      model: 'wan2.6-t2i',
      imageUrl: `${MEDIA}/fox.png`,
      usage: { image_count: 1 },
    });
    expect(items[0]!.binary?.data?.mimeType).toBe('image/png');
    expect(items[0]!.binary?.data?.fileName).toBe('image.png');
  });

  it('has the n8n models, Download Image on top and Prompt Extend off by default', () => {
    const props = AlibabaCloudNode.description.properties as any[];
    const shownFor = (p: any, op: string) => p.displayOptions?.show?.operation?.includes(op);
    const model = props.find((p) => p.name === 'modelId' && p.type === 'options' && shownFor(p, 'generate'));
    expect(model.options.map((o: any) => o.value)).toEqual([
      'qwen-image',
      'qwen-image-max',
      'qwen-image-plus',
      'wan2.6-image',
      'wan2.6-t2i',
      'z-image-turbo',
    ]);
    expect(model.default).toBe('z-image-turbo');
    expect(props.find((p) => p.name === 'downloadImage' && shownFor(p, 'generate')).default).toBe(true);
    const options = props.find((p) => p.name === 'imageOptions');
    expect(options.options.find((o: any) => o.name === 'promptExtend').default).toBe(false);
    const sizes = options.options.filter((o: any) => o.name === 'size');
    expect(sizes.map((o: any) => o.options.map((x: any) => x.value))).toEqual([
      ['1024*1024', '720*1280', '1280*720'],
      ['1104*1472', '1280*1280', '1472*1104', '1696*960', '960*1696'],
      ['1104*1472', '1328*1328', '1472*1104', '1664*928', '928*1664'],
    ]);
  });

  it('returns only the link with Download Image off', async () => {
    const { fake, out } = await qwen(
      {
        resource: 'image',
        operation: 'generate',
        modelId: 'wan2.6-t2i',
        prompt: 'p',
        downloadImage: false,
      },
      {
        handler: (req) => (req.method === 'POST' ? taskCreated() : wanDone(`${MEDIA}/a.png`)),
      },
    );
    expect(out[0]).toEqual({ model: 'wan2.6-t2i', imageUrl: `${MEDIA}/a.png` });
    expect(fake.requests.some((r) => r.url.startsWith(MEDIA))).toBe(false);
  });

  it('sends the reference images of Wan 2.6 Image inside the message', async () => {
    const { fake } = await qwen(
      {
        resource: 'image',
        operation: 'generate',
        modelId: 'wan2.6-image',
        prompt: 'make it night',
        referenceImages: {
          values: [
            { inputType: 'url', imageUrl: 'http://img.test/day.png' },
            { inputType: 'binary', binaryPropertyName: 'data' },
          ],
        },
        downloadImage: false,
      },
      {
        items: [{ json: {}, binary: { data: bin('BBB', 'image/jpeg') } }],
        handler: (req) => (req.method === 'POST' ? taskCreated() : wanDone(`${MEDIA}/n.png`)),
      },
    );
    const create = fake.requests[0]!;
    expect(create.url).toBe(`${HOST}/api/v1/services/aigc/image-generation/generation`);
    expect((create.body as any).input.messages[0].content).toEqual([
      { text: 'make it night' },
      { image: 'http://img.test/day.png' },
      { image: `data:image/jpeg;base64,${b64('BBB')}` },
    ]);
  });

  it('needs one to four reference images for Wan 2.6 Image', async () => {
    const none = await qwen({
      resource: 'image',
      operation: 'generate',
      modelId: 'wan2.6-image',
      prompt: 'p',
      referenceImages: { values: [{ inputType: 'url', imageUrl: '' }] },
    });
    expect(none.result.status).toBe('error');
    expect(JSON.stringify(none.result.error)).toContain('Add 1 to 4 reference images');
    expect(none.fake.requests).toHaveLength(0);
    const five = await qwen({
      resource: 'image',
      operation: 'generate',
      modelId: 'wan2.6-image',
      prompt: 'p',
      referenceImages: {
        values: Array.from({ length: 5 }, (_, i) => ({
          inputType: 'url',
          imageUrl: `http://img.test/${i}.png`,
        })),
      },
    });
    expect(five.result.status).toBe('error');
    expect(five.fake.requests).toHaveLength(0);
  });

  it('runs Qwen Image on the sync endpoint with no task', async () => {
    const { fake, items } = await qwen(
      {
        resource: 'image',
        operation: 'generate',
        modelId: 'qwen-image-plus',
        prompt: 'a lake',
        imageOptions: { size: '1328*1328' },
      },
      {
        handler: (req) =>
          req.url.startsWith(MEDIA)
            ? { body: Buffer.from('JPG'), headers: { 'content-type': 'image/jpeg' } }
            : {
                body: {
                  output: {
                    choices: [{ message: { role: 'assistant', content: [{ image: `${MEDIA}/lake.jpg` }] } }],
                  },
                  usage: { width: 1328, height: 1328, image_count: 1 },
                },
              },
      },
    );
    const create = fake.requests[0]!;
    expect(create.url).toBe(`${HOST}/api/v1/services/aigc/multimodal-generation/generation`);
    expect(header(create, 'x-dashscope-async')).toBeUndefined();
    expect((create.body as any).input.messages[0].content).toEqual([{ text: 'a lake' }]);
    expect((create.body as any).parameters).toEqual({ prompt_extend: false, size: '1328*1328' });
    expect(items[0]!.json).toEqual({
      model: 'qwen-image-plus',
      imageUrl: `${MEDIA}/lake.jpg`,
      usage: { width: 1328, height: 1328, image_count: 1 },
    });
    expect(items[0]!.binary?.data?.fileName).toBe('image.jpg');
    expect(header(fake.requests[1]!, 'authorization')).toBeUndefined();
  });

  it('runs Z-Image Turbo on the sync endpoint by default', async () => {
    const { fake, out } = await qwen(
      { resource: 'image', operation: 'generate', prompt: 'a cat', downloadImage: false },
      {
        handler: () => ({
          body: { output: { choices: [{ message: { content: [{ image: `${MEDIA}/c.png` }] } }] } },
        }),
      },
    );
    expect(fake.requests[0]!.url).toBe(`${HOST}/api/v1/services/aigc/multimodal-generation/generation`);
    expect((fake.requests[0]!.body as any).model).toBe('z-image-turbo');
    expect((fake.requests[0]!.body as any).parameters).toEqual({ prompt_extend: false });
    expect(out[0]).toEqual({ model: 'z-image-turbo', imageUrl: `${MEDIA}/c.png` });
  });

  it('turns a failed task into the vendor text, without the key', async () => {
    const { result } = await qwen(
      { resource: 'image', operation: 'generate', modelId: 'wan2.6-t2i', prompt: 'p' },
      {
        handler: (req) =>
          req.method === 'POST'
            ? taskCreated()
            : taskState({
                task_status: 'FAILED',
                code: 'DataInspectionFailed',
                message: `Input data may contain inappropriate content. Bearer ${KEY}`,
              }),
      },
    );
    expect(result.status).toBe('error');
    const text = JSON.stringify(result.error);
    expect(text).toContain(
      'The image task failed: DataInspectionFailed: Input data may contain inappropriate content',
    );
    expect(text).not.toContain(KEY);
  });

  it('stops with a timeout text when the task never ends', async () => {
    pollTiming.imageTimeoutMs = 40;
    const { result } = await qwen(
      { resource: 'image', operation: 'generate', modelId: 'wan2.6-t2i', prompt: 'p' },
      {
        handler: (req) => (req.method === 'POST' ? taskCreated() : taskState({ task_status: 'RUNNING' })),
      },
    );
    expect(result.status).toBe('error');
    expect(JSON.stringify(result.error)).toContain('The image was not ready in time');
  });

  it('refuses a bad size, an empty prompt and a task id with path characters', async () => {
    const badSize = await qwen({
      resource: 'image',
      operation: 'generate',
      modelId: 'wan2.6-t2i',
      prompt: 'p',
      imageOptions: { size: '10x10' },
    });
    expect(badSize.result.status).toBe('error');
    expect(badSize.fake.requests).toHaveLength(0);
    const empty = await qwen({ resource: 'image', operation: 'generate', prompt: '  ' });
    expect(empty.result.status).toBe('error');
    const badTask = await qwen(
      { resource: 'image', operation: 'generate', modelId: 'wan2.6-t2i', prompt: 'p' },
      { handler: () => taskCreated('../../admin') },
    );
    expect(badTask.result.status).toBe('error');
    expect(badTask.fake.requests).toHaveLength(1);
  });
});

describe('video', () => {
  const finished = (extra: DataObject = {}) =>
    taskState({ task_status: 'SUCCEEDED', video_url: `${MEDIA}/clip.mp4`, ...extra });

  it('textToVideo creates a task, polls, and downloads the video with no key', async () => {
    let polls = 0;
    const { fake, items } = await qwen(
      {
        resource: 'video',
        operation: 'textToVideo',
        modelId: 'wan2.6-t2v',
        prompt: 'waves',
        resolution: '720P',
        duration: 6,
        shotType: 'multi',
        videoOptions: { promptExtend: true, audio: false },
      },
      {
        handler: (req) => {
          if (req.url.startsWith(MEDIA)) {
            return { body: Buffer.from('MP4'), headers: { 'content-type': 'video/mp4' } };
          }
          if (req.method === 'POST') return taskCreated('v1');
          polls++;
          return polls === 1 ? taskState({ task_status: 'PENDING' }) : finished();
        },
      },
    );
    const create = fake.requests[0]!;
    expect(create.url).toBe(`${HOST}/api/v1/services/aigc/video-generation/video-synthesis`);
    expect(header(create, 'x-dashscope-async')).toBe('enable');
    expect(create.body).toEqual({
      model: 'wan2.6-t2v',
      input: { prompt: 'waves' },
      parameters: {
        resolution: '720P',
        duration: 6,
        shot_type: 'multi',
        prompt_extend: true,
        audio: false,
      },
    });
    expect(fake.requests.filter((r) => r.url === `${HOST}/api/v1/tasks/v1`)).toHaveLength(2);
    const media = fake.requests.find((r) => r.url.startsWith(MEDIA))!;
    expect(header(media, 'authorization')).toBeUndefined();
    expect(JSON.stringify(media.headers ?? {})).not.toContain(KEY);
    expect(items[0]!.json).toEqual({ videoUrl: `${MEDIA}/clip.mp4` });
    expect(items[0]!.binary?.data?.mimeType).toBe('video/mp4');
  });

  it('imageToVideo sends the image link, or the binary field inline, and the audio', async () => {
    const handler: FakeHandler = (req) => (req.method === 'POST' ? taskCreated('v2') : finished());
    const link = await qwen(
      {
        resource: 'video',
        operation: 'imageToVideo',
        modelId: 'wan2.6-i2v',
        prompt: 'zoom in',
        inputType: 'url',
        imgUrl: 'http://img.test/start.png',
        downloadVideo: false,
        imageToVideoOptions: { audioInputType: 'url', audioUrl: 'http://img.test/song.mp3' },
      },
      { handler },
    );
    expect((link.fake.requests[0]!.body as any).input).toEqual({
      prompt: 'zoom in',
      img_url: 'http://img.test/start.png',
      audio_url: 'http://img.test/song.mp3',
    });
    expect(link.out[0]).toEqual({ videoUrl: `${MEDIA}/clip.mp4` });
    expect(link.fake.requests.some((r) => r.url.startsWith(MEDIA))).toBe(false);

    const inline = await qwen(
      {
        resource: 'video',
        operation: 'imageToVideo',
        prompt: 'pan',
        inputType: 'binary',
        binaryPropertyName: 'data',
        downloadVideo: false,
        imageToVideoOptions: { audioInputType: 'binary', audioBinaryPropertyName: 'sound' },
      },
      {
        handler,
        items: [{ json: {}, binary: { data: bin('IMG', 'image/png'), sound: bin('SND', 'audio/mpeg') } }],
      },
    );
    const input = (inline.fake.requests[0]!.body as any).input;
    expect(input.img_url).toBe(`data:image/png;base64,${b64('IMG')}`);
    expect(input.audio_url).toBe(`data:audio/mpeg;base64,${b64('SND')}`);
    expect((inline.fake.requests[0]!.body as any).model).toBe('wan2.6-i2v-flash');
  });

  it('gives the full output with Simplify off and has the n8n defaults', async () => {
    const { out, fake } = await qwen(
      {
        resource: 'video',
        operation: 'textToVideo',
        prompt: 'p',
        downloadVideo: false,
        simplify: false,
      },
      {
        handler: (req) =>
          req.method === 'POST'
            ? taskCreated('v5')
            : {
                body: {
                  output: {
                    task_status: 'SUCCEEDED',
                    video_url: `${MEDIA}/clip.mp4`,
                    submit_time: '2026-11-07 10:00:00.000',
                    end_time: '2026-11-07 10:03:00.000',
                  },
                  usage: { duration: 5, video_count: 1 },
                },
              },
      },
    );
    expect(out[0]).toEqual({
      videoUrl: `${MEDIA}/clip.mp4`,
      model: 'wan2.6-t2v',
      taskId: 'v5',
      usage: { duration: 5, video_count: 1 },
      taskStatus: 'SUCCEEDED',
      submitTime: '2026-11-07 10:00:00.000',
      endTime: '2026-11-07 10:03:00.000',
    });
    // resolution, duration and shot type come from the top-level parameters, with the n8n defaults
    expect((fake.requests[0]!.body as any).parameters).toEqual({
      resolution: '1080P',
      duration: 5,
      shot_type: 'single',
    });
    const props = AlibabaCloudNode.description.properties as any[];
    const models = (op: string) =>
      props.find((p) => p.name === 'modelId' && p.displayOptions?.show?.operation?.includes(op));
    expect(models('textToVideo').options.map((o: any) => o.value)).toEqual(['wan2.6-t2v']);
    expect(models('imageToVideo').options.map((o: any) => o.value)).toEqual([
      'wan2.6-i2v-flash',
      'wan2.6-i2v',
    ]);
    expect(models('imageToVideo').default).toBe('wan2.6-i2v-flash');
    const resolution = props.find(
      (p) => p.name === 'resolution' && p.displayOptions?.show?.operation?.includes('textToVideo'),
    );
    expect(resolution.options.map((o: any) => o.value)).toEqual(['720P', '1080P']);
    const videoOptions = props.find((p) => p.name === 'videoOptions');
    expect(videoOptions.options.find((o: any) => o.name === 'promptExtend').default).toBe(false);
  });

  it('turns a failed video task into its text', async () => {
    const { result } = await qwen(
      { resource: 'video', operation: 'textToVideo', modelId: 'wan2.6-t2v', prompt: 'p' },
      {
        handler: (req) =>
          req.method === 'POST'
            ? taskCreated('v3')
            : taskState({ task_status: 'FAILED', code: 'InternalError', message: 'Render failed' }),
      },
    );
    expect(result.status).toBe('error');
    expect(JSON.stringify(result.error)).toContain('The video task failed: InternalError: Render failed');
  });

  it('errors when a finished task has no video link', async () => {
    const { result } = await qwen(
      { resource: 'video', operation: 'textToVideo', modelId: 'wan2.6-t2v', prompt: 'p' },
      {
        handler: (req) =>
          req.method === 'POST' ? taskCreated('v4') : taskState({ task_status: 'SUCCEEDED' }),
      },
    );
    expect(result.status).toBe('error');
    expect(JSON.stringify(result.error)).toContain('returned no video');
  });
});
