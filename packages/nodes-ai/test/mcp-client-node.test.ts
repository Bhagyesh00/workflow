/** P5-16: the MCP Client node: one tool call per item over an in-process MCP server on 127.0.0.1. */
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { DataObject, Item, LoadOptionsContext } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpClientNode } from '../src/nodes/tools/McpClient.node';
import { node, run, services } from './harness';

// 1x1 transparent PNG, a recorded fixture
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const TOOLS = [
  {
    name: 'add',
    description: 'Add numbers',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', title: 'First' },
        b: { type: 'integer' },
        label: { type: 'string' },
        flag: { type: 'boolean' },
        mode: { type: 'string', enum: ['fast', 'slow'] },
        tags: { type: 'array' },
        extra: { type: 'object' },
      },
      required: ['a', 'b'],
    },
  },
  { name: 'picture', description: 'Draw', inputSchema: { type: 'object', properties: {} } },
  { name: 'boom', description: 'Fails with text', inputSchema: { type: 'object', properties: {} } },
  { name: 'silent', description: 'Fails without text', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Never answers', inputSchema: { type: 'object', properties: {} } },
];

interface Call {
  name: string;
  args: DataObject;
}

describe('MCP Client node (P5-16)', () => {
  let server: http.Server;
  let endpoint: string;
  const sockets = new Set<Socket>();
  const calls: Call[] = [];
  let initializes = 0;
  let closes = 0;

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => resolve(body));
    });
  }

  function callResult(name: string, args: DataObject): unknown {
    if (name === 'add') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ sum: Number(args.a) + Number(args.b) }) }],
        structuredContent: { sum: Number(args.a) + Number(args.b) },
      };
    }
    if (name === 'picture') {
      return {
        content: [
          { type: 'text', text: 'plain words' },
          { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
          { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
        ],
      };
    }
    if (name === 'boom') return { content: [{ type: 'text', text: 'it broke' }], isError: true };
    return { content: [], isError: true };
  }

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      if (req.method === 'DELETE') {
        closes++;
        res.writeHead(204).end();
        return;
      }
      const message = JSON.parse((await readBody(req)) || '{}');
      if (!('id' in message)) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (message.method === 'initialize') {
        initializes++;
        res.setHeader('mcp-session-id', 'sess-1');
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '1' },
        };
      } else if (message.method === 'tools/list') {
        result = { tools: TOOLS };
      } else if (message.method === 'tools/call') {
        const { name, arguments: args } = message.params;
        calls.push({ name, args });
        if (name === 'slow') return; // never answers
        result = callResult(name, args);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    calls.length = 0;
    initializes = 0;
    closes = 0;
  });

  const rl = (value: string) => ({ __rl: true, mode: 'id', value });
  const mapped = (value: DataObject) => ({
    mappingMode: 'defineBelow',
    value,
    matchingColumns: [],
    schema: [],
    attemptToConvertTypes: false,
    convertFieldsToString: false,
  });

  async function runClient(
    parameters: DataObject,
    items: Item[] = [{ json: {} }],
    extra: Record<string, unknown> = {},
  ) {
    const r = await run(
      [
        node('Start', 'test.trigger'),
        node('MCP', 'ai.mcpClient', { endpointUrl: endpoint, authentication: 'none', ...parameters }, extra),
      ],
      { Start: { main: [[{ node: 'MCP', type: 'main', index: 0 }]] } },
      { triggerItems: items, services: services() },
    );
    return r;
  }

  function loadCtx(current: Record<string, unknown>): LoadOptionsContext {
    const http = services().http;
    return {
      getCurrentNodeParameter: (name: string) => current[name],
      helpers: { httpRequest: (o: unknown) => http.request(o as never) },
      getCredentials: async () => ({}),
    } as unknown as LoadOptionsContext;
  }

  it('calls the tool with mapped arguments and returns its output', async () => {
    const r = await runClient({
      tool: rl('add'),
      inputMode: 'manual',
      toolParameters: mapped({ a: 2, b: 5 }),
    });
    expect(r.status).toBe('success');
    expect(calls).toEqual([{ name: 'add', args: { a: 2, b: 5 } }]);
    // text is parsed as JSON when it parses
    expect(r.output('MCP')).toEqual([{ content: [{ sum: 7 }], structuredContent: { sum: 7 } }]);
  });

  it('opens one session for all items and calls the tool once per item', async () => {
    const r = await runClient(
      {
        tool: rl('add'),
        inputMode: 'manual',
        toolParameters: mapped({ a: '={{ $json.a }}', b: 1 }),
      },
      [{ json: { a: 1 } }, { json: { a: 2 } }, { json: { a: 3 } }],
    );
    expect(r.status).toBe('success');
    expect(initializes).toBe(1);
    expect(calls.map((c) => c.args.a)).toEqual([1, 2, 3]);
    expect(r.output('MCP').map((o) => (o.structuredContent as { sum: number }).sum)).toEqual([2, 3, 4]);
    expect(closes).toBe(1);
  });

  it('builds mapper fields from the JSON Schema of the tool', async () => {
    const fields = await McpClientNode.methods?.resourceMapping?.getToolFields(
      loadCtx({
        endpointUrl: endpoint,
        authentication: 'none',
        serverTransport: 'httpStreamable',
        tool: rl('add'),
      }),
    );
    expect(fields?.fields.map((f) => [f.id, f.type, f.required])).toEqual([
      ['a', 'number', true],
      ['b', 'number', true],
      ['label', 'string', false],
      ['flag', 'boolean', false],
      ['mode', 'options', false],
      ['tags', 'array', false],
      ['extra', 'object', false],
    ]);
    expect(fields?.fields[0].displayName).toBe('First');
    expect(fields?.fields.find((f) => f.id === 'mode')?.options?.map((o) => o.value)).toEqual([
      'fast',
      'slow',
    ]);
    const none = await McpClientNode.methods?.resourceMapping?.getToolFields(
      loadCtx({ endpointUrl: endpoint, tool: rl('picture') }),
    );
    expect(none?.fields).toEqual([]);
    expect(none?.emptyFieldsNotice).toBeTruthy();
    const nothing = await McpClientNode.methods?.resourceMapping?.getToolFields(
      loadCtx({ endpointUrl: endpoint, tool: rl('') }),
    );
    expect(nothing?.fields).toEqual([]);
  });

  it('lists the tools of the server for the tool locator, with a filter', async () => {
    const ctx = loadCtx({ endpointUrl: endpoint, authentication: 'none' });
    const all = await McpClientNode.methods?.listSearch?.searchTools(ctx);
    expect(all?.results.map((t) => t.value)).toEqual(['add', 'picture', 'boom', 'silent', 'slow']);
    const some = await McpClientNode.methods?.listSearch?.searchTools(ctx, 'PIC');
    expect(some?.results).toEqual([{ name: 'picture', value: 'picture' }]);
  });

  it('converts text typed into typed fields by the tool schema', async () => {
    const r = await runClient({
      tool: rl('add'),
      inputMode: 'manual',
      toolParameters: {
        ...mapped({ a: '3', b: '4', flag: 'true', tags: '["x","y"]', label: '', skipped: undefined }),
        schema: [
          { id: 'a', type: 'number', required: true },
          { id: 'b', type: 'number', required: true },
          { id: 'flag', type: 'boolean' },
          { id: 'tags', type: 'array' },
          { id: 'label', type: 'string' },
        ],
      },
    });
    expect(r.status).toBe('success');
    expect(calls[0].args).toEqual({ a: 3, b: 4, flag: true, tags: ['x', 'y'], label: '' });
  });

  it('takes all arguments from a JSON object in JSON mode', async () => {
    const r = await runClient({ tool: rl('add'), inputMode: 'json', jsonInput: '{"a": 10, "b": 20}' });
    expect(r.status).toBe('success');
    expect(calls[0]).toEqual({ name: 'add', args: { a: 10, b: 20 } });
    expect(r.output('MCP')[0].structuredContent).toEqual({ sum: 30 });

    const bad = await runClient({ tool: rl('add'), inputMode: 'json', jsonInput: '{nope' });
    expect(bad.status).toBe('error');
    expect(bad.error?.message).toMatch(/not valid JSON/);
    const array = await runClient({ tool: rl('add'), inputMode: 'json', jsonInput: '[1]' });
    expect(array.error?.message).toMatch(/must be an object/);
    expect(calls).toHaveLength(1);
  });

  it('puts images and audio into data_<n> binary from a recorded image', async () => {
    const r = await runClient({ tool: rl('picture'), inputMode: 'json', jsonInput: '{}' });
    expect(r.status).toBe('success');
    const item = r.runData.MCP.at(-1).data.main[0][0] as Item;
    expect(Object.keys(item.binary ?? {})).toEqual(['data_0', 'data_1']);
    expect(item.binary?.data_0.mimeType).toBe('image/png');
    expect(item.binary?.data_0.fileName).toBe('data_0.png');
    expect(item.binary?.data_1.mimeType).toBe('audio/wav');
    expect(item.binary?.data_1.fileName).toBe('data_1.wav');
    expect(
      Buffer.from(item.binary?.data_0.data ?? '', 'base64')
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    // only the text stays in content
    expect(item.json.content).toEqual(['plain words']);
  });

  it('keeps images and audio in content when Convert to Binary is off', async () => {
    const r = await runClient({
      tool: rl('picture'),
      inputMode: 'json',
      jsonInput: '{}',
      options: { convertToBinary: false },
    });
    const item = r.runData.MCP.at(-1).data.main[0][0] as Item;
    expect(item.binary).toBeUndefined();
    expect((item.json.content as DataObject[]).map((c) => (typeof c === 'string' ? c : c.type))).toEqual([
      'plain words',
      'image',
      'audio',
    ]);
  });

  it('throws the text of a tool that returns isError, or a fixed text without one', async () => {
    const boom = await runClient({ tool: rl('boom'), inputMode: 'json', jsonInput: '{}' });
    expect(boom.status).toBe('error');
    expect(boom.error?.message).toBe('it broke');
    const silent = await runClient({ tool: rl('silent'), inputMode: 'json', jsonInput: '{}' });
    expect(silent.error?.message).toBe('Tool "silent" returned an error');
  });

  it('continues on fail with { error: { message, issues } } for the failed items only', async () => {
    const r = await runClient(
      {
        tool: rl('boom'),
        inputMode: 'json',
        jsonInput: '{}',
      },
      [{ json: {} }, { json: {} }],
      { onError: 'continueRegularOutput' },
    );
    expect(r.status).toBe('success');
    expect(r.output('MCP')).toEqual([
      { error: { message: 'it broke', issues: [] } },
      { error: { message: 'it broke', issues: [] } },
    ]);
    const items = r.runData.MCP.at(-1).data.main[0] as Item[];
    expect(items.map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  // as n8n: the connection is not an item's failure, so continue on fail does not make error items of it; the
  // engine's continue on fail answers for the whole node
  it('fails the whole node when the server cannot be reached, also with continue on fail', async () => {
    const r = await run(
      [
        node('Start', 'test.trigger'),
        node(
          'MCP',
          'ai.mcpClient',
          { endpointUrl: 'http://127.0.0.1:1/mcp', tool: rl('add'), inputMode: 'json', jsonInput: '{}' },
          { onError: 'continueRegularOutput' },
        ),
      ],
      { Start: { main: [[{ node: 'MCP', type: 'main', index: 0 }]] } },
      { triggerItems: [{ json: {} }], services: services() },
    );
    expect(r.status).toBe('success');
    expect(r.output('MCP')).toEqual([{ error: 'Could not connect to your MCP server' }]);
    const items = r.runData.MCP.at(-1).data.main[0] as Item[];
    expect(items[0].error?.description).toMatch(/fetch failed|ECONNREFUSED/);
  });

  it('stops with an error when no tool is chosen', async () => {
    const r = await runClient({ tool: rl(''), inputMode: 'json', jsonInput: '{}' });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Choose a tool');
  });

  it('times out after options.timeout and closes the session', async () => {
    const started = Date.now();
    const r = await runClient({
      tool: rl('slow'),
      inputMode: 'json',
      jsonInput: '{}',
      options: { timeout: 400 },
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/time/i);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(closes).toBe(1);
  });

  it('describes the node: MCP Client properties first, no tool variant', () => {
    const d = McpClientNode.description;
    expect(d.properties.slice(0, 3).map((p) => p.name)).toEqual([
      'serverTransport',
      'endpointUrl',
      'authentication',
    ]);
    expect(d.usableAsTool).toBeUndefined();
    const options = d.properties.find((p) => p.name === 'options')?.options as Array<{
      name: string;
      default: unknown;
    }>;
    expect(options.map((o) => [o.name, o.default])).toEqual([
      ['convertToBinary', true],
      ['timeout', 60_000],
    ]);
    expect(d.properties.find((p) => p.name === 'toolParameters')?.type).toBe('resourceMapper');
  });
});
