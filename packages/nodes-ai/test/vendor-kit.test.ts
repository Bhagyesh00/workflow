/**
 * P5-30 vendor kit: a test vendor node built from the kit sends messages, reads binary fields, polls,
 * downloads media without leaking a key, runs a connected tool and keeps secrets out of errors.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient, NodeTypes } from '@workflow/core';
import type {
  AiChatModel,
  AiTool,
  DataObject,
  ExecuteContext,
  Item,
  LoadOptionsContext,
  NodeType,
} from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodes } from '../src';
import { downloadMedia, vendorError, vendorRequest } from '../src/nodes/vendors/shared/api';
import { fileToItem, readBinaryFields, readInputFile } from '../src/nodes/vendors/shared/binary';
import {
  eachVendorItem,
  maxToolIterationsOption,
  messagesProperty,
  readVendorMessages,
  simplifyProperty,
  toChatMessages,
} from '../src/nodes/vendors/shared/messages';
import { modelListSearch } from '../src/nodes/vendors/shared/model-lists';
import { pollUntil } from '../src/nodes/vendors/shared/poll';
import { runVendorChat, vendorToolsInput } from '../src/nodes/vendors/shared/tool-loop';
import type { ChatAdapter } from '../src/shared/chat-model';
import { connect, type FakeHandler, FakeHttpClient, type Link, node, run, services, testNodes } from './harness';

const KEY = 'AIzaSyTESTKEY0123456789abcdefghijklmnop';
const VENDOR = 'http://vendor.test';

/** the vendor's wire format in this test: one JSON reply with text and an optional tool call */
const adapter: ChatAdapter = {
  provider: 'testvendor',
  model: 'tv-1',
  credentialType: 'googleGeminiApi',
  capabilities: { structuredOutput: false, structuredOutputWithTools: false },
  buildRequest: (request) => ({
    url: `${VENDOR}/v1/chat`,
    method: 'POST',
    body: {
      messages: request.messages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((p) => (p.type === 'text' ? p.text : p.type)),
        ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      })),
      tools: request.tools?.map((t) => t.name),
    },
  }),
  parseResponse: (body: any) => ({
    message: {
      role: 'assistant',
      content: body.text ?? '',
      ...(body.call ? { toolCalls: [{ id: 'c1', name: body.call.name, arguments: body.call.args }] } : {}),
    },
    usage: { inputTokens: 3, outputTokens: 2 },
    stopReason: body.call ? 'tool_calls' : 'end',
  }),
};

const pending = { n: 0 };

const given: AiChatModel = {
  kind: 'chatModel',
  provider: 'given',
  model: 'g-1',
  chat: async () => ({ message: { role: 'assistant', content: 'from the given model' } }),
};

const str = (ctx: ExecuteContext, name: string, i: number) => String(ctx.getNodeParameter(name, i, ''));

const testVendorNode: NodeType = {
  description: {
    name: 'test.vendor',
    displayName: 'Test Vendor',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Vendor' },
    inputs: vendorToolsInput(`$parameter.op === 'chat'`),
    outputs: ['main'],
    credentials: [{ name: 'googleGeminiApi', required: true }],
    properties: [
      { displayName: 'Op', name: 'op', type: 'string', default: 'chat' },
      { displayName: 'Arg', name: 'arg', type: 'string', default: '' },
      { displayName: 'Arg 2', name: 'arg2', type: 'string', default: '' },
      { displayName: 'Use Given Model', name: 'useGiven', type: 'boolean', default: false },
      { displayName: 'Hide Tools', name: 'hideTools', type: 'string', default: 'show' },
      messagesProperty({ roles: ['user', 'assistant'], attachments: true }),
      simplifyProperty(),
      maxToolIterationsOption,
    ],
  },
  async execute(ctx) {
    return eachVendorItem(ctx, async (i): Promise<Item | Item[]> => {
      const op = str(ctx, 'op', i);
      switch (op) {
        case 'chat': {
          const messages = toChatMessages(await readVendorMessages(ctx, i));
          const result = await runVendorChat(ctx, i, adapter, {
            messages,
            system: 'be brief',
            maxIterations: Number(ctx.getNodeParameter('maxToolsIterations', i, 15)),
            useTools: ctx.getNodeParameter('hideTools', i, 'show') === 'show',
            ...(ctx.getNodeParameter('useGiven', i, false) ? { model: given } : {}),
          });
          return {
            json: {
              text: result.text,
              raw: (result.raw ?? null) as DataObject,
              usage: result.usage as unknown as DataObject,
              steps: result.steps.length,
            },
          };
        }
        case 'fields': {
          const files = await readBinaryFields(ctx, i, str(ctx, 'arg', i));
          return {
            json: {
              files: files.map((f) => ({
                mimeType: f.mimeType,
                fileName: f.fileName ?? null,
                text: Buffer.from(f.bytes).toString('utf8'),
              })),
            },
          };
        }
        case 'poll': {
          const value = await pollUntil(
            () => vendorRequest<{ state: string }>(ctx, 'googleGeminiApi', i, { url: `${VENDOR}/job` }),
            (v) => v.state === 'done',
            {
              intervalMs: 5,
              timeoutMs: Number(str(ctx, 'arg', i) || 1000),
              timeoutText: 'The job took too long',
            },
          );
          return { json: { state: value.state } };
        }
        case 'media': {
          const file = await downloadMedia(ctx, i, str(ctx, 'arg', i), {
            credentialType: 'googleGeminiApi',
            authHost: str(ctx, 'arg2', i) || undefined,
          });
          return fileToItem(ctx, i, { bytes: file.bytes, mimeType: file.mimeType ?? 'x/y' }, 'data', {
            size: file.bytes.byteLength,
            mimeType: file.mimeType ?? null,
          });
        }
        case 'input': {
          const file = await readInputFile(
            ctx,
            i,
            str(ctx, 'arg', i).startsWith('http')
              ? { inputType: 'url', url: str(ctx, 'arg', i) }
              : { inputType: 'binary', binaryField: str(ctx, 'arg', i) },
          );
          return {
            json: {
              mimeType: file.mimeType,
              fileName: file.fileName ?? null,
              text: Buffer.from(file.bytes).toString('utf8'),
            },
          };
        }
        case 'fail':
          return vendorRequest(ctx, 'googleGeminiApi', i, { url: `${VENDOR}/fail` });
        default:
          throw new Error(`unknown op ${op}`);
      }
    });
  },
};

const toolNode = (name: string, canWait: boolean, calls: DataObject[]): NodeType => ({
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
  async supplyData(ctx) {
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

const toolCalls: DataObject[] = [];
const types = new NodeTypes([
  ...nodes,
  ...testNodes,
  testVendorNode,
  toolNode('test.lookupTool', false, toolCalls),
  toolNode('test.waitTool', true, toolCalls),
]);

const item = (binary: Record<string, { text: string; mimeType: string; fileName?: string }> = {}): Item => ({
  json: {},
  binary: Object.fromEntries(
    Object.entries(binary).map(([k, v]) => [
      k,
      {
        data: Buffer.from(v.text).toString('base64'),
        mimeType: v.mimeType,
        fileName: v.fileName,
        fileSize: v.text.length,
      },
    ]),
  ),
});

async function runVendor(
  params: DataObject,
  options: {
    handler?: FakeHandler;
    items?: Item[];
    tool?: 'test.lookupTool' | 'test.waitTool';
    onError?: 'continueRegularOutput';
    client?: HttpClient;
    limits?: DataObject;
    creds?: DataObject;
  } = {},
) {
  const fake = new FakeHttpClient(options.handler ?? (() => ({ body: { text: 'ok' } })));
  const nodesList = [
    node('Trigger', 'test.trigger'),
    node('Vendor', 'test.vendor', params, {
      credentials: { googleGeminiApi: { id: 'c', name: 'c' } },
      ...(options.onError ? { onError: options.onError } : {}),
    }),
    ...(options.tool ? [node('Tool', options.tool)] : []),
  ];
  const result = await run(
    nodesList,
    connect(['Trigger', 'Vendor'], ...(options.tool ? ([['Tool', 'Vendor', 'ai_tool'] satisfies Link] as Link[]) : [])),
    {
      nodeTypes: types,
      triggerItems: options.items,
      services: services({
        nodeTypes: types,
        creds: { googleGeminiApi: { apiKey: KEY, host: VENDOR, ...(options.creds ?? {}) } },
        http: options.client ?? fake,
        nodeLimits: options.limits as any,
      }),
    },
  );
  return { result, fake, out: result.output('Vendor') };
}

const msg = (content: string, role = 'user', extra: DataObject = {}) => ({
  messages: { values: [{ role, content, ...extra }] },
});

beforeEach(() => {
  toolCalls.length = 0;
  pending.n = 0;
});

describe('vendorToolsInput', () => {
  it('adds the Tools port while the condition holds', () => {
    const expression = vendorToolsInput(`$parameter.resource === 'text'`);
    expect(expression.startsWith('={{')).toBe(true);
    const body = expression.slice(3, -2);
    const evaluate = (resource: string) =>
      new Function('$parameter', `return ${body}`)({ resource }) as unknown[];
    expect(evaluate('text')).toEqual(['main', { type: 'ai_tool', displayName: 'Tools' }]);
    expect(evaluate('image')).toEqual(['main']);
  });
});

describe('messages', () => {
  it('sends the messages, the system text and the key', async () => {
    const { fake, out } = await runVendor({
      op: 'chat',
      messages: {
        values: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'second' },
          { role: 'user', content: 'third' },
        ],
      },
    });
    expect(out[0].text).toBe('ok');
    expect(out[0].usage).toMatchObject({ modelCalls: 1, toolCalls: 0 });
    expect(out[0].raw).toEqual({ text: 'ok' });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].headers?.['x-goog-api-key']).toBe(KEY);
    const sent = (fake.bodies[0] as any).messages;
    expect(sent.map((m: any) => [m.role, m.content])).toEqual([
      ['system', 'be brief'],
      ['user', 'first'],
      ['assistant', 'second'],
      ['user', 'third'],
    ]);
  });

  it('reads attachments from URLs and binary fields into the last message', async () => {
    const { fake, out } = await runVendor(
      {
        op: 'chat',
        ...msg('look', 'user', { attachmentUrls: 'http://files.test/a.png', attachmentFields: 'data, doc' }),
      },
      {
        items: [
          item({
            data: { text: 'IMG', mimeType: 'image/png' },
            doc: { text: 'hello', mimeType: 'text/plain', fileName: 'n.txt' },
          }),
        ],
        handler: (req) =>
          req.url.startsWith('http://files.test')
            ? { body: Buffer.from('REMOTE'), headers: { 'content-type': 'image/png' } }
            : { body: { text: 'seen' } },
      },
    );
    expect(out[0].text).toBe('seen');
    const chat = fake.requests.filter((r) => r.url.endsWith('/v1/chat'));
    expect((chat[0].body as any).messages[1].content).toEqual([
      'look\n\nFile: n.txt\nContent:\nhello',
      'image',
      'image',
    ]);
    // the file link went out with no credential
    const download = fake.requests.find((r) => r.url.startsWith('http://files.test'))!;
    expect(JSON.stringify(download.headers ?? {})).not.toContain(KEY);
  });

  it('caps all attachments of the item together, across URLs and messages', async () => {
    const remote = {
      handler: () => ({ body: Buffer.from('REMOTE'), headers: { 'content-type': 'image/png' } }),
    };
    // each file is under the 10 byte limit, two of them are not
    const urls = await runVendor(
      {
        op: 'chat',
        ...msg('look', 'user', { attachmentUrls: 'http://files.test/a.png, http://files.test/b.png' }),
      },
      { ...remote, limits: { maxPassthroughBinaryBytes: 10 } },
    );
    expect(urls.result.error?.message).toMatch(/The files total .* exceeds the .* MB limit/);
    expect(urls.fake.requests.filter((r) => r.url.endsWith('/v1/chat'))).toHaveLength(0);

    const items = [item({ data: { text: 'abcdef', mimeType: 'text/plain' } })];
    const messages = await runVendor(
      {
        op: 'chat',
        messages: {
          values: [
            { role: 'user', content: 'one', attachmentFields: 'data' },
            { role: 'assistant', content: 'two', attachmentFields: 'data' },
            { role: 'user', content: 'three' },
          ],
        },
      },
      { items, limits: { maxPassthroughBinaryBytes: 10 } },
    );
    expect(messages.result.error?.message).toMatch(/The files total .* exceeds the .* MB limit/);
    expect(messages.fake.requests).toHaveLength(0);

    // under the limit in total it still goes through
    const fine = await runVendor(
      { op: 'chat', ...msg('look', 'user', { attachmentUrls: 'http://files.test/a.png' }) },
      { ...remote, limits: { maxPassthroughBinaryBytes: 10 } },
    );
    expect(fine.result.status).toBe('success');
  });

  it('the Messages property lists the roles and the attachment fields', () => {
    const property = messagesProperty({ roles: ['user', 'model'], attachments: true }) as any;
    const values = property.options[0].values;
    expect(values[0].options.map((o: any) => o.value)).toEqual(['user', 'model']);
    expect(values.map((v: any) => v.name)).toEqual(['role', 'content', 'attachmentUrls', 'attachmentFields']);
    const plain = messagesProperty({ roles: ['user'] }) as any;
    expect(plain.options[0].values.map((v: any) => v.name)).toEqual(['role', 'content']);
    expect(simplifyProperty(false)).toMatchObject({ name: 'simplify', default: false });
    expect(simplifyProperty()).toMatchObject({ default: true });
    expect(maxToolIterationsOption).toMatchObject({ name: 'maxToolsIterations', default: 15 });
  });

  it('refuses a last message that is not from the user, with no request', async () => {
    const { result, fake } = await runVendor({ op: 'chat', ...msg('hi', 'assistant') });
    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/last message must be a user message/);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('binary fields', () => {
  it('reads two named fields in order, and "data" when none is named', async () => {
    const items = [
      item({
        data: { text: 'one', mimeType: 'text/plain', fileName: 'one.txt' },
        other: { text: 'two', mimeType: 'application/pdf' },
      }),
    ];
    const two = await runVendor({ op: 'fields', arg: 'other, data' }, { items });
    expect(two.out[0].files).toEqual([
      { mimeType: 'application/pdf', fileName: null, text: 'two' },
      { mimeType: 'text/plain', fileName: 'one.txt', text: 'one' },
    ]);
    const dflt = await runVendor({ op: 'fields', arg: '' }, { items });
    expect((dflt.out[0].files as unknown[]).length).toBe(1);
  });

  it('names a missing field', async () => {
    const { result } = await runVendor({ op: 'fields', arg: 'nope' }, { items: [item()] });
    expect(result.error?.message).toMatch(/no binary data in the field "nope"/);
  });

  it('refuses a file over the instance cap before any request', async () => {
    const items = [item({ data: { text: 'x'.repeat(50), mimeType: 'text/plain' } })];
    const { result, fake } = await runVendor(
      { op: 'chat', ...msg('hi', 'user', { attachmentFields: 'data' }) },
      { items, limits: { maxPassthroughBinaryBytes: 10 } },
    );
    expect(result.error?.message).toMatch(/exceeds the 0 MB limit|exceeds the .* MB limit/);
    expect(fake.requests).toHaveLength(0);
  });

  it('readInputFile reads a binary field, a URL, and refuses over the cap', async () => {
    const items = [item({ data: { text: 'bin', mimeType: 'image/png', fileName: 'p.png' } })];
    const binary = await runVendor({ op: 'input', arg: 'data' }, { items });
    expect(binary.out[0]).toEqual({ mimeType: 'image/png', fileName: 'p.png', text: 'bin' });

    const url = await runVendor(
      { op: 'input', arg: 'http://files.test/dir/pic.png' },
      {
        handler: () => ({ body: Buffer.from('REMOTE'), headers: { 'content-type': 'image/png; charset=x' } }),
      },
    );
    expect(url.out[0]).toEqual({ mimeType: 'image/png', fileName: 'pic.png', text: 'REMOTE' });
    // a link has no credential
    expect(JSON.stringify(url.fake.requests[0].headers ?? {})).not.toContain(KEY);

    // a malformed percent sequence in the name keeps the raw name instead of failing a finished download
    const bad = await runVendor(
      { op: 'input', arg: 'http://files.test/a%zz.pdf' },
      { handler: () => ({ body: Buffer.from('PDF'), headers: { 'content-type': 'application/pdf' } }) },
    );
    expect(bad.out[0]).toEqual({ mimeType: 'application/pdf', fileName: 'a%zz.pdf', text: 'PDF' });

    const big = await runVendor(
      { op: 'input', arg: 'http://files.test/big.bin' },
      {
        handler: () => ({ body: Buffer.from('x'.repeat(40)) }),
        limits: { maxPassthroughBinaryBytes: 10 },
      },
    );
    expect(big.result.error?.message).toMatch(/exceeds the limit of 10 bytes/);

    const bigBinary = await runVendor(
      { op: 'input', arg: 'data' },
      {
        items: [item({ data: { text: 'x'.repeat(40), mimeType: 'text/plain' } })],
        limits: { maxPassthroughBinaryBytes: 10 },
      },
    );
    expect(bigBinary.result.error?.message).toMatch(/exceeds the/);
  });

  it('fileToItem stores the bytes in the named field with the paired item', async () => {
    const { out, result } = await runVendor(
      { op: 'media', arg: 'http://files.test/v.mp4' },
      { handler: () => ({ body: Buffer.from('VIDEO'), headers: { 'content-type': 'video/mp4' } }) },
    );
    expect(out[0]).toEqual({ size: 5, mimeType: 'video/mp4' });
    const stored = (result.runData.Vendor[0].data.main[0][0] as Item).binary!.data;
    expect(Buffer.from(stored.data, 'base64').toString()).toBe('VIDEO');
    expect(stored.mimeType).toBe('video/mp4');
    expect((result.runData.Vendor[0].data.main[0][0] as Item).pairedItem).toEqual({ item: 0 });
  });
});

describe('polling', () => {
  it('polls pending, then done', async () => {
    const { out, fake } = await runVendor(
      { op: 'poll' },
      { handler: () => ({ body: { state: ++pending.n < 3 ? 'pending' : 'done' } }) },
    );
    expect(out[0]).toEqual({ state: 'done' });
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[0].headers?.['x-goog-api-key']).toBe(KEY);
  });

  it('times out with the given text', async () => {
    const { result } = await runVendor(
      { op: 'poll', arg: '40' },
      { handler: () => ({ body: { state: 'pending' } }) },
    );
    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('The job took too long');
  });

  describe('with fake timers', () => {
    afterEach(() => vi.useRealTimers());

    it('waits the interval between checks and fails after the timeout', async () => {
      vi.useFakeTimers();
      const check = vi.fn(async () => 'pending');
      const settled = pollUntil(check, (v) => v === 'done', {
        intervalMs: 1000,
        timeoutMs: 3500,
        timeoutText: 'late',
      });
      const caught = settled.catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(0);
      expect(check).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(check).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2500);
      expect(((await caught) as Error).message).toBe('late');
      expect(check).toHaveBeenCalledTimes(5);
    });

    it('stops when the signal aborts, without another check', async () => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const check = vi.fn(async () => 'pending');
      const caught = pollUntil(check, () => false, {
        intervalMs: 1000,
        timeoutMs: 60_000,
        signal: controller.signal,
        timeoutText: 'late',
      }).catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      const error = (await caught) as Error;
      expect(error.name).toBe('AbortError');
      await vi.advanceTimersByTimeAsync(5000);
      expect(check).toHaveBeenCalledTimes(1);
    });
  });

  it('does not check at all when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const check = vi.fn(async () => 'x');
    await expect(
      pollUntil(check, () => true, {
        intervalMs: 1,
        timeoutMs: 10,
        signal: controller.signal,
        timeoutText: 't',
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(check).not.toHaveBeenCalled();
  });
});

describe('downloadMedia', () => {
  it('sends the key only to the vendor host', async () => {
    const own = await runVendor(
      { op: 'media', arg: 'https://files.vendor.test/out.png', arg2: 'files.vendor.test' },
      { handler: () => ({ status: 200, body: Buffer.from('A'), headers: { 'content-type': 'image/png' } }) },
    );
    expect(own.fake.requests).toHaveLength(1);
    expect(own.fake.requests[0].headers?.['x-goog-api-key']).toBe(KEY);
    expect(own.fake.requests[0].followRedirects).toBe(false);

    const other = await runVendor(
      { op: 'media', arg: 'https://cdn.other.test/out.png', arg2: 'files.vendor.test' },
      { handler: () => ({ body: Buffer.from('B') }) },
    );
    expect(other.fake.requests).toHaveLength(1);
    expect(JSON.stringify(other.fake.requests[0].headers ?? {})).not.toContain(KEY);
    expect(other.fake.requests[0].followRedirects).not.toBe(false);

    // the same name in another case or as a sub-domain is not the vendor host
    const sub = await runVendor(
      { op: 'media', arg: 'https://evil.files.vendor.test/x', arg2: 'files.vendor.test' },
      { handler: () => ({ body: Buffer.from('C') }) },
    );
    expect(JSON.stringify(sub.fake.requests[0].headers ?? {})).not.toContain(KEY);
  });

  it('follows a redirect from the vendor host with a plain request and no key', async () => {
    const { fake, out } = await runVendor(
      { op: 'media', arg: 'https://files.vendor.test/out', arg2: 'files.vendor.test' },
      {
        handler: (req): ReturnType<FakeHandler> =>
          req.url === 'https://files.vendor.test/out'
            ? { status: 302, headers: { location: 'http://cdn.test/blob?sig=1' } }
            : { body: Buffer.from('BLOB'), headers: { 'content-type': 'video/mp4' } },
      },
    );
    expect(out[0]).toEqual({ size: 4, mimeType: 'video/mp4' });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0].headers?.['x-goog-api-key']).toBe(KEY);
    expect(JSON.stringify(fake.requests[1].headers ?? {})).not.toContain(KEY);
  });

  it('sends no key over plain http, even to the vendor host', async () => {
    const { fake, out } = await runVendor(
      { op: 'media', arg: 'http://files.vendor.test/out.png', arg2: 'files.vendor.test' },
      { handler: () => ({ body: Buffer.from('A'), headers: { 'content-type': 'image/png' } }) },
    );
    expect(out[0]).toEqual({ size: 1, mimeType: 'image/png' });
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests[0].headers ?? {})).not.toContain(KEY);
    expect(fake.requests[0].followRedirects).not.toBe(false);
  });

  it('refuses a link that is not http(s)', async () => {
    const { result, fake } = await runVendor({ op: 'media', arg: 'file:///etc/passwd' });
    expect(result.error?.message).toMatch(/must start with http/);
    expect(fake.requests).toHaveLength(0);
  });

  describe('on the real client', () => {
    interface Hit {
      url: string;
      headers: http.IncomingMessage['headers'];
    }
    const hits: Record<string, Hit[]> = { first: [], second: [] };
    let first: http.Server;
    let second: http.Server;
    let firstUrl = '';
    let secondUrl = '';
    const listen = (host: string, name: string, handler: http.RequestListener) =>
      new Promise<http.Server>((resolve) => {
        const server = http.createServer((req, res) => {
          hits[name].push({ url: req.url ?? '', headers: req.headers });
          handler(req, res);
        });
        server.listen(0, host, () => resolve(server));
      });

    beforeAll(async () => {
      second = await listen('127.0.0.2', 'second', (_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end('LANDED');
      });
      secondUrl = `http://127.0.0.2:${(second.address() as AddressInfo).port}`;
      first = await listen('127.0.0.1', 'first', (req, res) => {
        if (req.url === '/media') {
          res.writeHead(302, { location: `${secondUrl}/landed` });
          return res.end();
        }
        res.end('FIRST');
      });
      firstUrl = `http://127.0.0.1:${(first.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      for (const s of [first, second]) {
        s.closeAllConnections();
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    });
    beforeEach(() => {
      hits.first.length = 0;
      hits.second.length = 0;
    });

    const client = () => new HttpClient({ ssrf: { allow: ['127.0.0.1', '127.0.0.2'] } });

    it('a plain http link on the vendor host gets no key, and its redirect leaves the second host with none', async () => {
      const { out } = await runVendor(
        { op: 'media', arg: `${firstUrl}/media`, arg2: '127.0.0.1' },
        { client: client() },
      );
      expect(out[0]).toEqual({ size: 6, mimeType: 'image/png' });
      expect(hits.first).toHaveLength(1);
      expect(hits.first[0].headers['x-goog-api-key']).toBeUndefined();
      expect(hits.second).toHaveLength(1);
      expect(hits.second[0].url).toBe('/landed');
      expect(hits.second[0].headers['x-goog-api-key']).toBeUndefined();
    });

    it('a link on another host than authHost gets no key at all', async () => {
      await runVendor({ op: 'media', arg: `${secondUrl}/direct`, arg2: '127.0.0.1' }, { client: client() });
      expect(hits.second).toHaveLength(1);
      expect(hits.second[0].headers['x-goog-api-key']).toBeUndefined();
      expect(hits.first).toHaveLength(0);
    });
  });
});

describe('errors', () => {
  it('redacts a Bearer-shaped secret in a vendor error', async () => {
    const secret = 'Bearer abcdefghijklmnop1234567890';
    const { result, fake } = await runVendor(
      { op: 'fail' },
      {
        handler: () => ({
          status: 401,
          body: { error: { message: `bad auth ${secret} and ${KEY}`, code: 'invalid_api_key' } },
        }),
      },
    );
    expect(fake.requests).toHaveLength(1);
    const message = result.error?.message ?? '';
    expect(message).toContain('bad auth Bearer [redacted]');
    expect(message).not.toContain('abcdefghijklmnop1234567890');
    expect(message).not.toContain(KEY);
  });

  it('continue-on-fail gives { error } per item and keeps the other items', async () => {
    const { out, result } = await runVendor(
      { op: 'fail' },
      {
        onError: 'continueRegularOutput',
        items: [{ json: { n: 1 } }, { json: { n: 2 } }],
        handler: () => ({
          status: 500,
          body: { error: { message: 'down, key Bearer abcdefghijklmnop1234567890' } },
        }),
      },
    );
    expect(result.status).toBe('success');
    expect(out).toHaveLength(2);
    expect(out[0].error).toBe('down, key Bearer [redacted]');
    expect((result.runData.Vendor[0].data.main[0] as Item[]).map((i) => i.pairedItem)).toEqual([
      { item: 0 },
      { item: 1 },
    ]);
  });

  it('vendorError maps a vendor error code to a fixed text', async () => {
    const { result } = await runVendor(
      { op: 'fail' },
      {
        handler: () => ({
          status: 429,
          body: {
            error: {
              message: 'You exceeded your current quota, key sk-aaaaaaaaaaaaaaaaaaaaaaaa',
              code: 'insufficient_quota',
            },
          },
        }),
      },
    );
    // without a text table the vendor message stays, redacted
    expect(result.error?.message).toBe('You exceeded your current quota, key [redacted]');

    const ctx = { getNode: () => ({ name: 'Vendor' }), signal: undefined } as unknown as ExecuteContext;
    const api = new (await import('@workflow/workflow')).NodeApiError('Vendor', 'raw', {
      httpCode: 429,
      responseBody: { error: { code: 'insufficient_quota', message: 'raw' } },
    });
    const mapped = vendorError(ctx, api, 0, { insufficient_quota: 'Add credit to your account' });
    expect(mapped.message).toBe('Add credit to your account');
    expect((mapped as any).httpCode).toBe('429');
    expect(vendorError(ctx, api, 0).message).toBe('raw');
    // an abort is passed through
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(vendorError(ctx, abort, 0)).toBe(abort);
  });
});

describe('tool loop', () => {
  const call = (name: string, args: DataObject) => ({ call: { name, args } });

  it('runs a connected tool and sends its result back', async () => {
    const { out, fake } = await runVendor(
      { op: 'chat', ...msg('find x') },
      {
        tool: 'test.lookupTool',
        handler: (_req, index) => ({
          body: index === 0 ? call('lookup', { q: 'x' }) : { text: 'the answer' },
        }),
      },
    );
    expect(out[0].text).toBe('the answer');
    expect(out[0].steps).toBe(1);
    expect(toolCalls).toEqual([{ q: 'x' }]);
    expect(fake.requests).toHaveLength(2);
    expect((fake.bodies[0] as any).tools).toEqual(['lookup']);
    const second = (fake.bodies[1] as any).messages;
    expect(second.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(second[3].content).toBe('found x');
    expect(out[0].usage).toMatchObject({ modelCalls: 2, toolCalls: 1 });
    // the last reply is the raw one
    expect(out[0].raw).toEqual({ text: 'the answer' });
  });

  it('with no tool connected it is one call', async () => {
    const { fake } = await runVendor({ op: 'chat', ...msg('hi') });
    expect(fake.requests).toHaveLength(1);
    expect((fake.bodies[0] as any).tools).toBeUndefined();
  });

  it('stops at the model call limit', async () => {
    const { result, fake } = await runVendor(
      { op: 'chat', maxToolsIterations: 2, ...msg('loop') },
      { tool: 'test.lookupTool', handler: () => ({ body: call('lookup', { q: 'again' }) }) },
    );
    expect(result.error?.message).toMatch(/Max iterations \(2\) reached/);
    expect(fake.requests).toHaveLength(2);
  });

  it('refuses a tool that waits before the first request, and continue-on-fail does not skip the refusal', async () => {
    const refusal =
      'Nodes that wait for an answer cannot be used as tools of "Vendor". Move "lookup" to an Agent node.';
    const stopped = await runVendor({ op: 'chat', ...msg('hi') }, { tool: 'test.waitTool' });
    expect(stopped.result.status).toBe('error');
    expect(stopped.result.error?.message).toBe(refusal);
    expect(stopped.result.error?.code).toBe('VENDOR_WAIT_TOOL');
    expect(stopped.fake.requests).toHaveLength(0);

    // the kit's own loop rethrows it; only the node's own error setting turns it into an error item
    const items = await runVendor(
      { op: 'chat', ...msg('hi') },
      { tool: 'test.waitTool', onError: 'continueRegularOutput' },
    );
    expect(items.out).toEqual([{ error: refusal }]);
    expect(items.fake.requests).toHaveLength(0);
    expect(toolCalls).toHaveLength(0);
  });

  it('does not read or run a connected tool while the Tools input is hidden', async () => {
    const { out, fake } = await runVendor(
      { op: 'chat', hideTools: 'hide', ...msg('find x') },
      { tool: 'test.lookupTool' },
    );
    // the model is offered no tool, so nothing runs
    expect((fake.bodies[0] as any).tools).toBeUndefined();
    expect(toolCalls).toHaveLength(0);
    expect(out[0].text).toBe('ok');

    // a saved waiting tool behind a hidden input neither refuses nor stops the run
    const waiting = await runVendor(
      { op: 'chat', hideTools: 'hide', ...msg('hi') },
      { tool: 'test.waitTool' },
    );
    expect(waiting.result.status).toBe('success');
    expect(waiting.fake.requests).toHaveLength(1);
    expect((waiting.fake.bodies[0] as any).tools).toBeUndefined();
  });

  it('uses a given model, with no vendor request and no raw reply', async () => {
    const { out, fake } = await runVendor({ op: 'chat', useGiven: true, ...msg('hi') });
    expect(out[0].text).toBe('from the given model');
    expect(out[0].raw).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });
});

describe('modelListSearch', () => {
  const list = async () => [
    { id: 'gpt-4o', name: 'GPT 4o' },
    { id: 'gpt-4o-mini' },
    { id: 'text-embedding-3' },
    { id: 'gpt-4o' },
    { id: 'o3', name: 'Reasoning O3' },
  ];
  const ctx = {} as LoadOptionsContext;

  it('filters by the typed text on name and id, and keeps order without duplicates', async () => {
    const search = modelListSearch(list);
    expect((await search(ctx)).results.map((r) => r.value)).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
      'text-embedding-3',
      'o3',
    ]);
    expect((await search(ctx, ' MINI ')).results).toEqual([{ name: 'gpt-4o-mini', value: 'gpt-4o-mini' }]);
    expect((await search(ctx, 'reasoning')).results).toEqual([{ name: 'Reasoning O3', value: 'o3' }]);
    expect((await search(ctx, 'nothing')).results).toEqual([]);
  });

  it('drops the models keep refuses', async () => {
    const search = modelListSearch(list, (id) => id.startsWith('gpt'));
    expect((await search(ctx)).results.map((r) => r.value)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect((await search(ctx, 'o3')).results).toEqual([]);
  });
});
