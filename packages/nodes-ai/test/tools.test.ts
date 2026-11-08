import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';
import type { DataObject, Item, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  calculate,
  fillJsonBody,
  fillUrl,
  findPlaceholders,
  optimizeResponse,
  originPlaceholders,
  wrapToolCode,
} from '../src/nodes/tools/tools.nodes';
import { clearMemoryVectorStores } from '../src/nodes/vector-stores/vector-stores.nodes';
import { sharedResourceCount } from '../src/shared/shared-resource';
import {
  connect,
  type Link,
  modelRequests,
  node,
  reply,
  run,
  scriptModel,
  services,
  toolCalls,
} from './harness';

/** Agent driven by a scripted model, with the given tool nodes attached. */
async function agentWith(
  tools: WorkflowNode[],
  script: Parameters<typeof scriptModel>[1],
  options: { services?: ReturnType<typeof services>; extraNodes?: WorkflowNode[]; extraLinks?: Link[] } = {},
) {
  const requests = scriptModel('Model', script);
  const r = await run(
    [
      node('Trigger', 'test.trigger'),
      node('Agent', 'ai.agent', {
        promptType: 'define',
        text: 'go',
        options: { returnIntermediateSteps: true },
      }),
      node('Model', 'test.fakeChatModel'),
      ...tools,
      ...(options.extraNodes ?? []),
    ],
    connect(
      ['Trigger', 'Agent'],
      ['Model', 'Agent', 'ai_languageModel'],
      ...tools.map((t): Link => [t.name, 'Agent', 'ai_tool']),
      ...(options.extraLinks ?? []),
    ),
    { services: options.services },
  );
  const steps = (r.output('Agent')[0]?.intermediateSteps ?? []) as Array<{
    observation: string;
    action: DataObject;
  }>;
  return { r, requests, steps };
}

beforeEach(() => modelRequests.clear());

describe('Calculator', () => {
  it('evaluates arithmetic and math functions', () => {
    expect(calculate('2^10 + sqrt(16)')).toBe(1028);
    expect(calculate('(12.5 * 4) / 2')).toBe(25);
    expect(calculate('Math.max(3, 9) % 4')).toBe(1);
    expect(calculate('1.5e3 - PI * 0')).toBe(1500);
    expect(calculate('-(2 + 3)')).toBe(-5);
  });

  it('rejects anything that is not arithmetic', () => {
    for (const input of [
      'process.exit()',
      'constructor',
      '"a".length',
      'x = 1',
      '[1,2]',
      '(1).constructor',
      'globalThis',
      '`1`',
      '2 .toString()',
      '',
    ]) {
      expect(() => calculate(input), input).toThrow();
    }
  });
});

describe('Code tool', () => {
  it('runs sandboxed code with the query as data', async () => {
    const { r, steps } = await agentWith(
      [
        node('Upper', 'ai.toolCode', {
          toolDescription: 'Uppercases text',
          jsCode: 'return query.toUpperCase() + "!";',
        }),
      ],
      [toolCalls(['Upper', { query: 'hello "world"' }]), 'done'],
    );
    expect(r.status).toBe('success');
    expect(steps[0].observation).toBe('HELLO "WORLD"!');
  });

  it('passes structured arguments when an input schema is set', async () => {
    const { requests, steps } = await agentWith(
      [
        node('Sum', 'ai.toolCode', {
          toolDescription: 'Adds numbers',
          jsCode: 'return { total: query.a + query.b };',
          specifyInputSchema: true,
          schemaType: 'fromJson',
          jsonSchemaExample: '{"a": 1, "b": 2}',
        }),
      ],
      [toolCalls(['Sum', { a: 2, b: 40 }]), 'done'],
    );
    expect(requests[0].tools?.[0]).toMatchObject({
      name: 'Sum',
      description: 'Adds numbers',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    });
    expect(steps[0].observation).toBe('{"total":42}');
  });

  it('wraps input as a JSON literal, so it can never become code', () => {
    const input = '"); process.exit(1); ("';
    expect(wrapToolCode('return query;', input)).toContain(JSON.stringify(JSON.stringify(input)));
  });

  it('reports code errors to the model', async () => {
    const { steps } = await agentWith(
      [node('Broken', 'ai.toolCode', { toolDescription: 'x', jsCode: 'throw new Error("tool exploded")' })],
      [toolCalls(['Broken', { query: 'q' }]), 'done'],
    );
    expect(steps[0].observation).toBe('Error: tool exploded');
  });
});

describe('HTTP Request tool', () => {
  let server: http.Server;
  let base: string;
  const received: Array<{
    method?: string;
    url?: string;
    headers: IncomingMessage['headers'];
    body: string;
  }> = [];

  beforeAll(async () => {
    server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url?.startsWith('/html')) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(
            '<html><head><style>p{}</style><script>evil()</script></head><body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>',
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            city: 'Paris',
            temperature: 21,
            internal: 'secret-ish',
            echo: body ? JSON.parse(body) : null,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    received.length = 0;
  });

  const allowLocal = () => services({ http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }) });

  it('fills placeholders in path, query, headers and body, and builds the schema', async () => {
    const tool = node('Weather', 'ai.toolHttpRequest', {
      toolDescription: 'Gets the weather',
      method: 'POST',
      url: `${base}/cities/{city}/weather`,
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'units', value: '{units}' }] },
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'X-Trace', value: 'agent-{city}' }] },
      sendBody: true,
      bodyContentType: 'json',
      jsonBody: '{"days": "{days}", "note": "for {city}"}',
      placeholderDefinitions: {
        values: [
          { name: 'city', description: 'City name', type: 'string' },
          { name: 'days', description: 'Forecast days', type: 'number' },
        ],
      },
      optimizeResponse: true,
      optimizeOptions: { fieldsToInclude: 'selected', fields: 'city, temperature, echo' },
    });
    const { r, requests, steps } = await agentWith(
      [tool],
      [toolCalls(['Weather', { city: 'São Paulo/1', units: 'metric', days: 3 }]), 'done'],
      { services: allowLocal() },
    );
    expect(r.status).toBe('success');
    expect(requests[0].tools?.[0].parameters).toEqual({
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
        units: { type: 'string' },
        days: { type: 'number', description: 'Forecast days' },
      },
      required: ['city', 'units', 'days'],
    });
    expect(received[0].method).toBe('POST');
    expect(received[0].url).toBe('/cities/S%C3%A3o%20Paulo%2F1/weather?units=metric');
    expect(received[0].headers['x-trace']).toBe('agent-São Paulo/1');
    expect(JSON.parse(received[0].body)).toEqual({ days: 3, note: 'for São Paulo/1' });
    expect(JSON.parse(steps[0].observation)).toEqual({
      city: 'Paris',
      temperature: 21,
      echo: { days: 3, note: 'for São Paulo/1' },
    });
  });

  it('sends header-auth credentials and extracts text from HTML', async () => {
    const tool = node(
      'Page',
      'ai.toolHttpRequest',
      {
        toolDescription: 'Reads a page',
        url: `${base}/html/{slug}`,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        optimizeResponse: true,
        optimizeOptions: { responseType: 'html' },
      },
      { credentials: { httpHeaderAuth: { id: 'c', name: 'h' } } },
    );
    const svc = services({
      http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }),
      creds: { httpHeaderAuth: { name: 'X-Api-Key', value: 'k-123' } },
    });
    const { steps } = await agentWith([tool], [toolCalls(['Page', { slug: 'home' }]), 'done'], {
      services: svc,
    });
    expect(received[0].headers['x-api-key']).toBe('k-123');
    expect(steps[0].observation).toBe('Title\nHello & welcome');
  });

  it('is subject to the SSRF policy', async () => {
    const tool = node('Local', 'ai.toolHttpRequest', { toolDescription: 'x', url: `${base}/data` });
    const { steps } = await agentWith([tool], [toolCalls(['Local', {}]), 'done'], {
      services: services({ http: new HttpClient() }),
    });
    expect(steps[0].observation).toMatch(/^Error: .*blocked/);
    expect(received).toHaveLength(0);
  });

  it('never lets the model choose the host when credentials are sent', async () => {
    const tool = node(
      'Exfil',
      'ai.toolHttpRequest',
      {
        toolDescription: 'x',
        url: 'https://{host}/collect',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpBearerAuth',
      },
      { credentials: { httpBearerAuth: { id: 'c', name: 'b' } } },
    );
    const { r } = await agentWith([tool], ['unused']);
    expect(r.status).toBe('error');
    expect(r.error?.message).toContain('cannot choose the host');
  });

  it('placeholder helpers', () => {
    expect(findPlaceholders('a/{x}/{y}', '{x}', undefined)).toEqual(['x', 'y']);
    expect(originPlaceholders('https://{sub}.example.com:{port}/p/{id}')).toEqual(['sub', 'port']);
    expect(originPlaceholders('{url}')).toEqual(['url']);
    expect(fillUrl('https://api.test/{a}?q={b}', { a: 'x y', b: '&' })).toBe('https://api.test/x%20y?q=%26');
    expect(
      fillJsonBody('{"n": "{n}", "s": "say {s}", "o": "{o}"}', { n: 5, s: 'hi "you"', o: { k: [1] } }),
    ).toEqual({
      n: 5,
      s: 'say hi "you"',
      o: { k: [1] },
    });
    expect(optimizeResponse({ a: 1, b: 2 }, { fieldsToInclude: 'except', fields: 'b' })).toBe('{"a":1}');
    expect(optimizeResponse('x'.repeat(500), { responseType: 'text', maxLength: 100 })).toHaveLength(101);
  });
});

describe('Call Workflow tool', () => {
  it('runs the sub-workflow with the model arguments as the item', async () => {
    const calls: Array<{ source: unknown; items: Item[] }> = [];
    const svc = services({
      executeSubWorkflow: async ({ source, items }) => {
        calls.push({ source, items });
        return {
          executionId: 'sub-1',
          data: [[{ json: { response: `Order ${items[0].json.orderId} shipped` } }]],
        };
      },
    });
    const { steps } = await agentWith(
      [
        node('Order status', 'ai.toolWorkflow', {
          toolDescription: 'Looks up an order',
          workflowId: 'wf-orders',
          specifyInputSchema: true,
          jsonSchemaExample: '{"orderId": "A1"}',
        }),
      ],
      [toolCalls(['Order_status', { orderId: 'B7' }]), 'done'],
      { services: svc },
    );
    expect(calls).toEqual([
      { source: { source: 'database', workflowId: 'wf-orders' }, items: [{ json: { orderId: 'B7' } }] },
    ]);
    expect(steps[0].observation).toBe('Order B7 shipped');
  });
});

describe('Think tool', () => {
  it('returns the thought', async () => {
    const { steps } = await agentWith(
      [node('Think', 'ai.toolThink')],
      [toolCalls(['Think', { thought: 'plan: a, b' }]), 'ok'],
    );
    expect(steps[0].observation).toBe('plan: a, b');
  });
});

describe('Vector store tool', () => {
  beforeEach(() => clearMemoryVectorStores());

  it('answers from the most similar documents', async () => {
    // fill the in-memory store first
    const insert = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Store', 'ai.vectorStoreInMemory', { mode: 'insert', memoryKey: 'kb' }),
        node('Loader', 'ai.documentDefaultDataLoader', {
          jsonMode: 'expressionData',
          jsonData: '={{ $json.text }}',
        }),
        node('Embeddings', 'test.fakeEmbeddings'),
      ],
      connect(
        ['Trigger', 'Store'],
        ['Loader', 'Store', 'ai_document'],
        ['Embeddings', 'Store', 'ai_embedding'],
      ),
      { triggerItems: [{ json: { text: 'Cats are pets' } }, { json: { text: 'Cars have an engine' } }] },
    );
    expect(insert.status).toBe('success');

    scriptModel('QA model', ['A cat is a pet.']);
    const { r, steps } = await agentWith(
      [node('Knowledge', 'ai.toolVectorStore', { toolDescription: 'Pet facts', topK: 1 })],
      [toolCalls(['Knowledge', { query: 'what is a cat' }]), 'done'],
      {
        extraNodes: [
          node('Store', 'ai.vectorStoreInMemory', { mode: 'retrieve', memoryKey: 'kb' }),
          node('Embeddings', 'test.fakeEmbeddings'),
          node('QA model', 'test.fakeChatModel'),
        ],
        extraLinks: [
          ['Store', 'Knowledge', 'ai_vectorStore'],
          ['Embeddings', 'Store', 'ai_embedding'],
          ['QA model', 'Knowledge', 'ai_languageModel'],
        ],
      },
    );
    expect(r.status).toBe('success');
    expect(steps[0].observation).toBe('A cat is a pet.');
    const qa = modelRequests.get('QA model')![0].messages;
    expect(qa[0].content).toContain('Cats are pets');
    expect(qa[0].content).not.toContain('engine');
    expect(qa[1]).toEqual({ role: 'user', content: 'what is a cat' });
  });
});

// ---------------------------------------------------------------------------------------------
// MCP client against an in-process MCP-style server
// ---------------------------------------------------------------------------------------------

describe('MCP Client tool', () => {
  let server: http.Server;
  let endpoint: string;
  const log: Array<{ method: string; rpc?: string; session?: string; auth?: string; protocol?: string }> = [];
  let sse = false;
  let expireNextCall = false;

  const tools = [
    {
      name: 'get_time',
      description: 'Current time in a zone',
      inputSchema: { type: 'object', properties: { zone: { type: 'string' } }, required: ['zone'] },
    },
    { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
    { name: 'secret.admin', description: 'Excluded tool', inputSchema: { type: 'object', properties: {} } },
  ];

  beforeAll(async () => {
    let sessions = 0;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const session = req.headers['mcp-session-id'] as string | undefined;
        if (req.method === 'DELETE') {
          log.push({ method: 'DELETE', session });
          res.writeHead(204).end();
          return;
        }
        const message = JSON.parse(body);
        log.push({
          method: req.method!,
          rpc: message.method,
          session,
          auth: req.headers.authorization as string | undefined,
          protocol: req.headers['mcp-protocol-version'] as string | undefined,
        });
        if (
          message.method !== 'initialize' &&
          expireNextCall &&
          message.method !== 'notifications/initialized'
        ) {
          expireNextCall = false;
          res.writeHead(404).end();
          return;
        }
        if (!('id' in message)) {
          res.writeHead(202).end();
          return;
        }
        let result: unknown;
        const headers: Record<string, string> = {};
        if (message.method === 'initialize') {
          headers['mcp-session-id'] = `session-${++sessions}`;
          result = {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'test', version: '1' },
          };
        } else if (message.method === 'tools/list') {
          // two pages to exercise the cursor
          result = message.params?.cursor
            ? { tools: tools.slice(1) }
            : { tools: tools.slice(0, 1), nextCursor: 'p2' };
        } else if (message.method === 'tools/call') {
          const { name, arguments: args } = message.params;
          result =
            name === 'fail'
              ? { content: [{ type: 'text', text: 'database offline' }], isError: true }
              : { content: [{ type: 'text', text: `12:00 in ${args.zone}` }] };
        }
        const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        if (sse) {
          res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
          res.end(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\nevent: message\ndata: ${payload}\n\n`,
          );
        } else {
          res.writeHead(200, { 'content-type': 'application/json', ...headers });
          res.end(payload);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    log.length = 0;
    sse = false;
    expireNextCall = false;
  });

  const mcpNode = (params: DataObject = {}, extra: Partial<WorkflowNode> = {}) =>
    node(
      'MCP',
      'ai.mcpClientTool',
      { endpointUrl: endpoint, include: 'except', excludeTools: ['secret.admin'], ...params },
      extra,
    );

  for (const mode of ['json', 'sse'] as const) {
    it(`lists and calls tools (${mode} responses)`, async () => {
      sse = mode === 'sse';
      const { r, requests, steps } = await agentWith(
        [mcpNode()],
        [toolCalls(['get_time', { zone: 'UTC' }], ['fail', {}]), 'It is noon.'],
        { services: services({ http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }) }) },
      );
      expect(r.status).toBe('success');
      expect(requests[0].tools?.map((t) => t.name)).toEqual(['get_time', 'fail']);
      expect(requests[0].tools?.[0]).toMatchObject({
        description: 'Current time in a zone',
        parameters: tools[0].inputSchema,
      });
      expect(steps.map((s) => s.observation)).toEqual(['12:00 in UTC', 'Error: database offline']);
      expect(log.map((l) => l.rpc ?? l.method)).toEqual([
        'initialize',
        'notifications/initialized',
        'tools/list',
        'tools/list',
        'tools/call',
        'tools/call',
        'DELETE',
      ]);
      // the session id is sent after initialize, the protocol version after negotiation
      expect(log[0].session).toBeUndefined();
      expect(
        log.slice(1).every((l) => l.session === log[1].session && l.session?.startsWith('session-')),
      ).toBe(true);
      expect(log[2].protocol).toBe('2025-06-18');
    });
  }

  it('includes only selected tools and sends bearer credentials', async () => {
    const { requests } = await agentWith(
      [
        mcpNode(
          { include: 'selected', includeTools: ['fail'], authentication: 'bearerAuth' },
          { credentials: { httpBearerAuth: { id: 'b', name: 'b' } } },
        ),
      ],
      ['nothing to do'],
      {
        services: services({
          http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }),
          creds: { httpBearerAuth: { token: 'mcp-token' } },
        }),
      },
    );
    expect(requests[0].tools?.map((t) => t.name)).toEqual(['fail']);
    expect(log[0].auth).toBe('Bearer mcp-token');
  });

  it('re-initializes an expired session once', async () => {
    const { steps } = await agentWith([mcpNode()], [toolCalls(['get_time', { zone: 'CET' }]), 'ok'], {
      services: services({ http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }) }),
    });
    expect(steps[0].observation).toBe('12:00 in CET');
    expireNextCall = true;
    log.length = 0;
    const second = await agentWith([mcpNode()], [toolCalls(['get_time', { zone: 'EST' }]), 'ok'], {
      services: services({ http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }) }),
    });
    expect(second.r.status).toBe('success');
    // tools/list hit the expired session (404) and the client initialized a new one
    expect(log.map((l) => l.rpc ?? l.method).slice(0, 5)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'initialize',
      'notifications/initialized',
    ]);
  });

  it('shares one session across the items of an execution', async () => {
    scriptModel('Model', (request) =>
      request.messages.at(-1)?.role === 'tool' ? reply('done') : toolCalls(['get_time', { zone: 'UTC' }]),
    );
    const r = await run(
      [
        node('Trigger', 'test.trigger'),
        node('Agent', 'ai.agent', { promptType: 'define', text: '={{ $json.q }}' }),
        node('Model', 'test.fakeChatModel'),
        mcpNode(),
      ],
      connect(['Trigger', 'Agent'], ['Model', 'Agent', 'ai_languageModel'], ['MCP', 'Agent', 'ai_tool']),
      {
        triggerItems: [{ json: { q: 'a' } }, { json: { q: 'b' } }, { json: { q: 'c' } }],
        services: services({ http: new HttpClient({ ssrf: { allow: ['127.0.0.1'] } }) }),
      },
    );
    expect(r.output('Agent')).toHaveLength(3);
    const calls = log.map((l) => l.rpc ?? l.method);
    expect(calls.filter((c) => c === 'initialize')).toHaveLength(1);
    expect(calls.filter((c) => c === 'tools/call')).toHaveLength(3);
    expect(calls.at(-1)).toBe('DELETE');
    expect(sharedResourceCount()).toBe(0);
  });

  it('is blocked by the SSRF policy without an allow-list entry', async () => {
    const { r } = await agentWith([mcpNode()], ['x'], { services: services({ http: new HttpClient() }) });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Could not connect to your MCP server');
    expect(r.error?.description).toMatch(/blocked/);
    expect(log).toHaveLength(0);
  });
});
