/**
 * P5-32 Anthropic vendor node: one recorded call per operation (message, image and document analyze,
 * file upload/get/list/delete, prompt generate/improve/templatize), a tool turn, a pause_turn continuation,
 * the Files API id form, server tools and the beta headers. Replies are fixtures written from the Anthropic
 * API reference; they prove the request we send.
 */
import { NodeTypes } from '@workflow/core';
import type { AiTool, DataObject, Item, NodeType } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodes } from '../src';
import { AnthropicNode } from '../src/nodes/vendors/anthropic/Anthropic.node';
import { ANTHROPIC_API_VERSION } from '../src/providers/anthropic';
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

const KEY = 'sk-ant-test-key-0123456789abcdef';
const BASE = 'http://anthropic.test';
const FILES_BETA = 'files-api-2025-04-14';

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

const messageReply = (text: string, extra: DataObject = {}): FakeReply => ({
  body: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
    ...extra,
  },
});

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

async function runAnthropic(params: DataObject, options: RunOptions = {}) {
  const fake = new FakeHttpClient(options.handler ?? (() => messageReply('ok')));
  const list = [
    node('Trigger', 'test.trigger'),
    node('Anthropic', 'ai.anthropic', params, {
      credentials: { anthropicApi: { id: 'c', name: 'c' } },
      ...(options.onError ? { onError: options.onError } : {}),
    }),
    ...(options.tool ? [node('Tool', options.tool)] : []),
  ];
  const result = await run(
    list,
    connect(['Trigger', 'Anthropic'], ...(options.tool ? [['Tool', 'Anthropic', 'ai_tool'] as Link] : [])),
    {
      nodeTypes: types,
      triggerItems: options.items,
      services: services({
        nodeTypes: types,
        creds: { anthropicApi: { apiKey: KEY, baseUrl: BASE } },
        http: fake,
      }),
    },
  );
  return { result, fake, out: result.output('Anthropic') };
}

const model = (value = 'claude-sonnet-5-5') => ({ __rl: true, mode: 'id', value });
const message = (content: string, role = 'user') => ({ messages: { values: [{ role, content }] } });
const text = (params: DataObject = {}) => ({
  resource: 'text',
  operation: 'message',
  modelId: model(),
  ...message('Hello'),
  ...params,
});

/** a GET of a media link answers bytes, anything else the message reply */
const mediaThenMessage =
  (mime: string, data = 'X'): FakeHandler =>
  (request) =>
    request.method === 'GET' ? { body: bytes(data), headers: { 'content-type': mime } } : messageReply('ok');

beforeEach(() => {
  calls.length = 0;
});

describe('node shell', () => {
  it('is usable as a tool and has the five resources', () => {
    expect(AnthropicNode.description.usableAsTool).toBe(true);
    const resource = AnthropicNode.description.properties.find((p) => p.name === 'resource');
    expect((resource?.options as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'text',
      'image',
      'document',
      'file',
      'prompt',
    ]);
  });

  it('puts the Tools port on Message a Model only once Hide Tools is Show', () => {
    const body = String(AnthropicNode.description.inputs).slice(3, -2);
    const evaluate = (p: DataObject) => new Function('$parameter', `return ${body}`)(p) as unknown[];
    expect(evaluate({ resource: 'text', operation: 'message', hideTools: 'hide' })).toEqual(['main']);
    expect(evaluate({ resource: 'text', operation: 'message', hideTools: 'show' })).toHaveLength(2);
    expect(evaluate({ resource: 'file', operation: 'list', hideTools: 'show' })).toEqual(['main']);
  });

  it('lists models and files for the pickers', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = {
      getCredentials: async () => ({ baseUrl: BASE }),
      helpers: {
        httpRequestWithAuthentication: async (
          _type: string,
          request: { url: string; headers?: DataObject },
        ) => {
          seen.push(request);
          return request.url.endsWith('/v1/models')
            ? {
                data: [
                  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
                  { id: 'claude-haiku-4-5' },
                ],
              }
            : {
                data: [
                  { id: 'file_1', filename: 'a.txt' },
                  { id: 'file_2', filename: 'b.pdf' },
                ],
              };
        },
      },
    };
    const models = await AnthropicNode.methods!.listSearch!.modelSearch!(ctx as never);
    expect(models.results.map((r) => r.value)).toEqual(['claude-sonnet-5-5', 'claude-haiku-4-5']);
    const sonnet = await AnthropicNode.methods!.listSearch!.modelSearch!(ctx as never, 'sonnet');
    expect(sonnet.results.map((r) => r.value)).toEqual(['claude-sonnet-5-5']);
    const files = await AnthropicNode.methods!.listSearch!.fileSearch!(ctx as never, 'pdf');
    expect(files.results.map((r) => r.value)).toEqual(['file_2']);
    expect((seen.at(-1)!.headers as DataObject)['anthropic-beta']).toBe(FILES_BETA);
  });
});

describe('text.message', () => {
  it('sends the messages to /v1/messages with the key and our API version', async () => {
    const { fake, out } = await runAnthropic(text());
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    expect(request.url).toBe(`${BASE}/v1/messages`);
    expect(request.method).toBe('POST');
    expect(request.headers?.['x-api-key']).toBe(KEY);
    expect(request.headers?.['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect(request.headers?.['anthropic-beta']).toBeUndefined();
    for (const name of Object.keys(request.headers ?? {})) expect(name.toLowerCase()).not.toContain('n8n');
    expect(request.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    });
    expect(out[0]).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('returns the whole reply with Simplify Output off, and a merged response on request', async () => {
    const { out } = await runAnthropic(text({ simplify: false, options: { includeMergedResponse: true } }), {
      handler: () =>
        messageReply('', {
          content: [
            { type: 'text', text: 'one ' },
            { type: 'text', text: 'two' },
          ],
        }),
    });
    expect(out[0]).toMatchObject({ id: 'msg_1', stop_reason: 'end_turn', merged_response: 'one two' });
    expect(Array.isArray(out[0]!.content)).toBe(true);
  });

  it('keeps earlier messages, the system message, max tokens and prompt caching', async () => {
    const { fake } = await runAnthropic(
      text({
        messages: {
          values: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'answer' },
            { role: 'user', content: 'second' },
          ],
        },
        options: { system: 'Be brief', maxTokens: 200, promptCaching: true },
      }),
    );
    const body = fake.requests[0]!.body as DataObject;
    expect(body.system).toBe('Be brief');
    expect(body.max_tokens).toBe(200);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('sends a PDF and an image attachment as blocks', async () => {
    const both = {
      json: {},
      binary: {
        ...binaryItem({ doc: { text: 'PDFDATA', mimeType: 'application/pdf', fileName: 'a.pdf' } }).binary,
        ...binaryItem({ pic: { text: 'PNGDATA', mimeType: 'image/png', fileName: 'p.png' } }).binary,
      },
    };
    const { fake } = await runAnthropic(
      text({ messages: { values: [{ role: 'user', content: 'read', attachmentFields: 'doc, pic' }] } }),
      { items: [both] },
    );
    const content = (fake.requests[0]!.body as any).messages[0].content as Array<DataObject>;
    expect(content.map((b) => b.type)).toEqual(['text', 'document', 'image']);
    expect(content[1]).toMatchObject({
      source: { type: 'base64', media_type: 'application/pdf', data: b64('PDFDATA') },
    });
    expect(content[2]).toMatchObject({ source: { type: 'base64', media_type: 'image/png' } });
  });

  it('sends top P and top K only on a model that takes them, and then on the older API version', async () => {
    const older = await runAnthropic(
      text({ modelId: model('claude-sonnet-4-5'), options: { topP: 0.5, topK: 20 } }),
    );
    expect(older.fake.requests[0]!.headers?.['anthropic-version']).toBe('2023-06-01');
    expect(older.fake.requests[0]!.body).toMatchObject({ top_p: 0.5, top_k: 20 });
    const current = await runAnthropic(text({ options: { topP: 0.5, topK: 20 } }));
    const body = current.fake.requests[0]!.body as DataObject;
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(current.fake.requests[0]!.headers?.['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect(body.temperature).toBeUndefined();
  });

  it('adds web search with its limits and code execution with the beta header', async () => {
    const { fake } = await runAnthropic(
      text({
        options: {
          webSearch: true,
          webSearchMaxUses: 3,
          allowedDomains: 'example.com, docs.example.org',
          codeExecution: true,
        },
      }),
    );
    const request = fake.requests[0]!;
    expect((request.body as DataObject).tools).toEqual([
      { type: 'code_execution_20250522', name: 'code_execution' },
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3,
        allowed_domains: ['example.com', 'docs.example.org'],
      },
    ]);
    expect(request.headers?.['anthropic-beta']).toBe('code-execution-2025-05-22');
  });

  it('sends blocked domains, and refuses allowed and blocked together before any call', async () => {
    const blocked = await runAnthropic(text({ options: { webSearch: true, blockedDomains: 'bad.example' } }));
    expect(((blocked.fake.requests[0]!.body as any).tools[0] as DataObject).blocked_domains).toEqual([
      'bad.example',
    ]);
    const both = await runAnthropic(
      text({ options: { webSearch: true, allowedDomains: 'a.example', blockedDomains: 'b.example' } }),
    );
    expect(both.result.status).toBe('error');
    expect(both.result.error?.message).toContain('allowed domains or blocked domains');
    expect(both.fake.requests).toHaveLength(0);
  });

  it('sends no tool and does not refuse a waiting tool while Hide Tools is Hide', async () => {
    const { fake, result } = await runAnthropic(text({ hideTools: 'hide' }), { tool: 'test.waitTool' });
    expect(result.status).toBe('success');
    expect(fake.requests).toHaveLength(1);
    expect((fake.requests[0]!.body as DataObject).tools).toBeUndefined();
  });

  it('runs a tool turn: tool_use, the tool, then the answer', async () => {
    const { fake, out } = await runAnthropic(text({ hideTools: 'show' }), {
      tool: 'test.lookupTool',
      handler: (_request, index) =>
        index === 0
          ? messageReply('', {
              content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'cats' } }],
              stop_reason: 'tool_use',
            })
          : messageReply('Found cats'),
    });
    expect(calls).toEqual([{ q: 'cats' }]);
    expect(fake.requests).toHaveLength(2);
    const first = fake.requests[0]!.body as DataObject;
    expect((first.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['lookup']);
    const second = (fake.requests[1]!.body as any).messages as Array<{ role: string; content: DataObject[] }>;
    expect(second.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found cats' }],
    });
    expect(second.at(-2)!.content[0]).toMatchObject({ type: 'tool_use', id: 'toolu_1' });
    expect(out[0]).toEqual({ content: [{ type: 'text', text: 'Found cats' }] });
  });

  it('continues on pause_turn by sending the paused blocks back, and returns one merged reply', async () => {
    const paused = [
      { type: 'text', text: 'Searching. ' },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
    ];
    const { fake, out } = await runAnthropic(
      text({ simplify: false, options: { webSearch: true, includeMergedResponse: true } }),
      {
        handler: (_request, index) =>
          index === 0
            ? messageReply('', {
                content: paused,
                stop_reason: 'pause_turn',
                usage: { input_tokens: 10, output_tokens: 4 },
              })
            : messageReply('Result.', { usage: { input_tokens: 20, output_tokens: 6 } }),
      },
    );
    expect(fake.requests).toHaveLength(2);
    const second = (fake.requests[1]!.body as any).messages as Array<{ role: string; content: DataObject[] }>;
    expect(second.at(-1)).toEqual({ role: 'assistant', content: paused });
    expect((fake.requests[1]!.body as DataObject).tools).toEqual(
      (fake.requests[0]!.body as DataObject).tools,
    );
    expect(out[0]!.content).toEqual([...paused, { type: 'text', text: 'Result.' }]);
    expect(out[0]!.usage).toEqual({ input_tokens: 30, output_tokens: 10 });
    expect(out[0]!.merged_response).toBe('Searching. Result.');
  });

  it('sends the blocks of every paused round once, in one assistant message', async () => {
    const first = [
      { type: 'text', text: 'One. ' },
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'a' } },
    ];
    const second = [
      { type: 'text', text: 'Two. ' },
      { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'b' } },
    ];
    const { fake, out } = await runAnthropic(text({ simplify: false, options: { webSearch: true } }), {
      handler: (_request, index) =>
        index === 0
          ? messageReply('', { content: first, stop_reason: 'pause_turn' })
          : index === 1
            ? messageReply('', { content: second, stop_reason: 'pause_turn' })
            : messageReply('Done.'),
    });
    expect(fake.requests).toHaveLength(3);
    const third = (fake.requests[2]!.body as any).messages as Array<{ role: string; content: DataObject[] }>;
    expect(third.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(third[1]!.content).toEqual([...first, ...second]);
    expect(out[0]!.content).toEqual([...first, ...second, { type: 'text', text: 'Done.' }]);
  });

  it('stops a reply that keeps pausing at Max Tool Calls Iterations', async () => {
    const { fake, result } = await runAnthropic(
      text({ options: { webSearch: true, maxToolsIterations: 2 } }),
      {
        handler: () =>
          messageReply('', { content: [{ type: 'text', text: '.' }], stop_reason: 'pause_turn' }),
      },
    );
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('paused 2 times');
    expect(fake.requests).toHaveLength(3);
  });

  it('refuses a tool that waits before anything is sent', async () => {
    const { fake, result } = await runAnthropic(text({ hideTools: 'show' }), { tool: 'test.waitTool' });
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('Nodes that wait for an answer cannot be used as tools');
    expect(fake.requests).toHaveLength(0);
  });

  it('gives {error} for a failed item when continue on fail is on, without the key', async () => {
    const { out } = await runAnthropic(text(), {
      onError: 'continueRegularOutput',
      handler: () => ({
        status: 500,
        body: { type: 'error', error: { type: 'api_error', message: `bad ${KEY}` } },
      }),
    });
    expect(out[0]!.error).toBeTypeOf('string');
    expect(String(out[0]!.error)).not.toContain(KEY);
  });
});

describe('image.analyze and document.analyze', () => {
  const image = (params: DataObject = {}) => ({
    resource: 'image',
    operation: 'analyze',
    modelId: model(),
    text: 'What is this?',
    inputType: 'url',
    url: 'http://img.test/cat.png',
    ...params,
  });

  it('downloads a URL and sends it as a base64 image block', async () => {
    const { fake, out } = await runAnthropic(image(), {
      handler: (request) =>
        request.method === 'GET'
          ? { body: bytes('PNGBYTES'), headers: { 'content-type': 'image/png' } }
          : messageReply('A cat'),
    });
    expect(fake.requests[0]).toMatchObject({ method: 'GET', url: 'http://img.test/cat.png' });
    expect(fake.requests[0]!.headers?.['x-api-key']).toBeUndefined();
    const request = fake.requests[1]!;
    expect(request.url).toBe(`${BASE}/v1/messages`);
    expect(request.headers?.['anthropic-beta']).toBeUndefined();
    expect((request.body as any).messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64('PNGBYTES') } },
      { type: 'text', text: 'What is this?' },
    ]);
    expect(out[0]).toEqual({ content: [{ type: 'text', text: 'A cat' }] });
  });

  it('sends a binary field, with a max tokens option and Simplify off', async () => {
    const { fake, out } = await runAnthropic(
      image({ inputType: 'binary', binaryPropertyName: 'pic', simplify: false, options: { maxTokens: 50 } }),
      { items: [binaryItem({ pic: { text: 'JPG', mimeType: 'image/jpeg', fileName: 'p.jpg' } })] },
    );
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.body).toMatchObject({ max_tokens: 50 });
    expect((fake.requests[0]!.body as any).messages[0].content[0].source.media_type).toBe('image/jpeg');
    expect(out[0]).toMatchObject({ id: 'msg_1', stop_reason: 'end_turn' });
  });

  it('refuses a file that is no image Claude reads', async () => {
    const { fake, result } = await runAnthropic(image({ inputType: 'binary', binaryPropertyName: 'x' }), {
      items: [binaryItem({ x: { text: 'T', mimeType: 'application/pdf' } })],
    });
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('is not an image Claude reads');
    expect(fake.requests).toHaveLength(0);
  });

  it('sends a PDF as a document block and a text file as a text document', async () => {
    const doc = {
      resource: 'document',
      operation: 'analyze',
      modelId: model(),
      text: 'Summarize',
      inputType: 'binary',
      binaryPropertyName: 'data',
    };
    const pdf = await runAnthropic(doc, {
      items: [binaryItem({ data: { text: 'PDF', mimeType: 'application/pdf', fileName: 'a.pdf' } })],
    });
    expect((pdf.fake.requests[0]!.body as any).messages[0].content[0]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: b64('PDF') },
    });
    const txt = await runAnthropic(doc, {
      items: [binaryItem({ data: { text: 'plain words', mimeType: 'text/plain', fileName: 'a.txt' } })],
    });
    expect((txt.fake.requests[0]!.body as any).messages[0].content[0]).toEqual({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: 'plain words' },
    });
  });

  it('uses <base>/v1/files/<id> as a Files API id, with no download and the beta header', async () => {
    const { fake } = await runAnthropic({
      resource: 'document',
      operation: 'analyze',
      modelId: model(),
      text: 'Summarize',
      inputType: 'url',
      url: `${BASE}/v1/files/file_abc-123`,
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.headers?.['anthropic-beta']).toBe(FILES_BETA);
    expect((fake.requests[0]!.body as any).messages[0].content[0]).toEqual({
      type: 'document',
      source: { type: 'file', file_id: 'file_abc-123' },
    });
  });

  it('does not take a link on another host or with a path after the id as a Files API id', async () => {
    const other = await runAnthropic(image({ url: 'http://other.test/v1/files/file_1' }), {
      handler: mediaThenMessage('image/png'),
    });
    expect(other.fake.requests[0]).toMatchObject({ method: 'GET', url: 'http://other.test/v1/files/file_1' });
    const deeper = await runAnthropic(image({ url: `${BASE}/v1/files/file_1/content` }), {
      handler: mediaThenMessage('image/png'),
    });
    expect(deeper.fake.requests[0]).toMatchObject({ method: 'GET' });
  });
});

describe('file', () => {
  it('uploads a binary field with the beta header and a file name', async () => {
    const { fake, out } = await runAnthropic(
      { resource: 'file', operation: 'upload', options: { fileName: 'renamed.pdf' } },
      {
        items: [binaryItem({ data: { text: 'DOC', mimeType: 'application/pdf', fileName: 'doc.pdf' } })],
        handler: () => ({ body: { id: 'file_1', type: 'file', filename: 'renamed.pdf' } }),
      },
    );
    const request = fake.requests[0]!;
    expect(request).toMatchObject({ url: `${BASE}/v1/files`, method: 'POST', bodyType: 'multipart' });
    expect(request.headers?.['anthropic-beta']).toBe(FILES_BETA);
    expect(request.headers?.['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect((request.body as any).file).toMatchObject({
      fileName: 'renamed.pdf',
      mimeType: 'application/pdf',
    });
    expect(out[0]).toMatchObject({ id: 'file_1' });
  });

  it('uploads from a URL and keeps the name of the link', async () => {
    const { fake } = await runAnthropic(
      { resource: 'file', operation: 'upload', inputType: 'url', url: 'http://files.test/a/report.pdf' },
      {
        handler: (request) =>
          request.method === 'GET'
            ? { body: bytes('PDF'), headers: { 'content-type': 'application/pdf' } }
            : { body: { id: 'file_2' } },
      },
    );
    expect(fake.requests[0]).toMatchObject({ method: 'GET', url: 'http://files.test/a/report.pdf' });
    expect((fake.requests[1]!.body as any).file.fileName).toBe('report.pdf');
  });

  it('gets file metadata', async () => {
    const { fake, out } = await runAnthropic(
      { resource: 'file', operation: 'get', fileId: { __rl: true, mode: 'id', value: 'file_9' } },
      { handler: () => ({ body: { id: 'file_9', filename: 'x.txt', size_bytes: 3 } }) },
    );
    expect(fake.requests[0]).toMatchObject({ url: `${BASE}/v1/files/file_9`, method: 'GET' });
    expect(fake.requests[0]!.headers?.['anthropic-beta']).toBe(FILES_BETA);
    expect(out[0]).toMatchObject({ id: 'file_9', size_bytes: 3 });
  });

  it('lists files page by page with Return All', async () => {
    const { fake, out } = await runAnthropic(
      { resource: 'file', operation: 'list', returnAll: true },
      {
        handler: (_request, index) =>
          index === 0
            ? { body: { data: [{ id: 'file_1' }, { id: 'file_2' }], has_more: true, last_id: 'file_2' } }
            : { body: { data: [{ id: 'file_3' }], has_more: false, last_id: 'file_3' } },
      },
    );
    expect(fake.requests[0]).toMatchObject({ url: `${BASE}/v1/files`, method: 'GET', qs: { limit: 1000 } });
    expect(fake.requests[1]!.qs).toMatchObject({ after_id: 'file_2' });
    expect(out.map((o) => o.id)).toEqual(['file_1', 'file_2', 'file_3']);
  });

  it('lists up to a limit', async () => {
    const { fake, out } = await runAnthropic(
      { resource: 'file', operation: 'list', returnAll: false, limit: 2 },
      {
        handler: () => ({
          body: {
            data: [{ id: 'file_1' }, { id: 'file_2' }, { id: 'file_3' }],
            has_more: true,
            last_id: 'file_3',
          },
        }),
      },
    );
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.qs).toMatchObject({ limit: 2 });
    expect(out).toHaveLength(2);
  });

  it('deletes a file', async () => {
    const { fake, out } = await runAnthropic(
      { resource: 'file', operation: 'deleteFile', fileId: { __rl: true, mode: 'id', value: 'file_7' } },
      { handler: () => ({ body: { id: 'file_7', type: 'file_deleted' } }) },
    );
    expect(fake.requests[0]).toMatchObject({ url: `${BASE}/v1/files/file_7`, method: 'DELETE' });
    expect(fake.requests[0]!.headers?.['anthropic-beta']).toBe(FILES_BETA);
    expect(out[0]).toMatchObject({ type: 'file_deleted' });
  });
});

describe('prompt', () => {
  const PROMPT_BETA = 'prompt-tools-2025-04-02';
  const promptReply: FakeReply = {
    body: {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Better prompt' }] }],
      system: '',
      usage: {},
    },
  };

  it('generates a prompt from a task', async () => {
    const { fake, out } = await runAnthropic(
      {
        resource: 'prompt',
        operation: 'generate',
        task: 'Summarize emails',
        options: { targetModel: 'claude-sonnet-5-5' },
      },
      { handler: () => promptReply },
    );
    const request = fake.requests[0]!;
    expect(request).toMatchObject({ url: `${BASE}/v1/experimental/generate_prompt`, method: 'POST' });
    expect(request.headers?.['anthropic-beta']).toBe(PROMPT_BETA);
    expect(request.body).toEqual({ task: 'Summarize emails', target_model: 'claude-sonnet-5-5' });
    expect(out[0]).toMatchObject({ messages: [{ role: 'user' }] });
  });

  it('improves a prompt with feedback and a system message', async () => {
    const { fake } = await runAnthropic(
      {
        resource: 'prompt',
        operation: 'improve',
        ...message('Summarize this'),
        feedback: 'Make it shorter',
        options: { system: 'You are terse' },
      },
      { handler: () => promptReply },
    );
    expect(fake.requests[0]).toMatchObject({ url: `${BASE}/v1/experimental/improve_prompt` });
    expect(fake.requests[0]!.body).toEqual({
      messages: [{ role: 'user', content: 'Summarize this' }],
      feedback: 'Make it shorter',
      system: 'You are terse',
    });
  });

  it('templatizes a prompt', async () => {
    const { fake, out } = await runAnthropic(
      { resource: 'prompt', operation: 'templatize', ...message('Translate "cat" to French') },
      {
        handler: () => ({
          body: {
            messages: [{ role: 'user', content: 'Translate {{WORD}}' }],
            system: '',
            variable_values: { WORD: '"cat"' },
          },
        }),
      },
    );
    expect(fake.requests[0]).toMatchObject({ url: `${BASE}/v1/experimental/templatize_prompt` });
    expect(fake.requests[0]!.headers?.['anthropic-beta']).toBe(PROMPT_BETA);
    expect(fake.requests[0]!.body).toEqual({
      messages: [{ role: 'user', content: 'Translate "cat" to French' }],
    });
    expect(out[0]).toMatchObject({ variable_values: { WORD: '"cat"' } });
  });

  it('refuses an empty task before any call', async () => {
    const { fake, result } = await runAnthropic({ resource: 'prompt', operation: 'generate', task: ' ' });
    expect(result.status).toBe('error');
    expect(fake.requests).toHaveLength(0);
  });
});
