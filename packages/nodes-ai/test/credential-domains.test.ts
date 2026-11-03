/**
 * P2-10 allowed domains per credential on the AI surfaces: the HTTP Request Tool (generic and predefined
 * credentials, the credential read by hand), the MCP Client Tool (read by hand), and a chat model whose
 * credential carries the base URL.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';
import type { DataObject, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withGenericAuth } from '../src/nodes/tools/tools.nodes';
import {
  connect,
  FakeHttpClient,
  type Link,
  modelRequests,
  node,
  run,
  scriptModel,
  sequence,
  services,
  toolCalls,
} from './harness';

interface Hit {
  url: string;
  headers: http.IncomingMessage['headers'];
  body: string;
}

async function listen(
  host: string,
  handler: (req: http.IncomingMessage, res: http.ServerResponse, hit: Hit) => void,
) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const hit = { url: req.url ?? '', headers: req.headers, body };
      hits.push(hit);
      handler(req, res, hit);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    hits,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type Listener = Awaited<ReturnType<typeof listen>>;
let first: Listener; // 127.0.0.1
let second: Listener; // 127.0.0.2
let mcp: Listener; // 127.0.0.1, an MCP server

const clients = () => new HttpClient({ ssrf: { allow: ['127.0.0.1', '127.0.0.2'] } });

beforeAll(async () => {
  second = await listen('127.0.0.2', (_req, res) => res.end('SECOND'));
  first = await listen('127.0.0.1', (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `${second.url}/landed` });
      return res.end();
    }
    res.end('FIRST');
  });
  mcp = await listen('127.0.0.1', (req, res, hit) => {
    const message = hit.body ? JSON.parse(hit.body) : {};
    if (req.method === 'DELETE') return void res.writeHead(204).end();
    if (!('id' in message)) return void res.writeHead(202).end();
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 't', version: '1' },
          }
        : message.method === 'tools/list'
          ? {
              tools: [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: {} } }],
            }
          : { content: [{ type: 'text', text: 'pong' }] };
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
});
afterAll(async () => {
  await Promise.all([first.close(), second.close(), mcp.close()]);
});
beforeEach(() => {
  for (const l of [first, second, mcp]) l.hits.length = 0;
  modelRequests.clear();
});

const restricted = (allowedDomains: string, extra: DataObject = {}): DataObject => ({
  allowedHttpRequestDomains: 'domains',
  allowedDomains,
  ...extra,
});

/** an agent driven by a scripted model with the given tool nodes */
async function agentWith(
  tools: WorkflowNode[],
  script: Parameters<typeof scriptModel>[1],
  creds: Record<string, DataObject>,
) {
  scriptModel('Model', script);
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
    ],
    connect(
      ['Trigger', 'Agent'],
      ['Model', 'Agent', 'ai_languageModel'],
      ...tools.map((t): Link => [t.name, 'Agent', 'ai_tool']),
    ),
    { services: services({ creds, http: clients() }) },
  );
  const steps = (r.output('Agent')[0]?.intermediateSteps ?? []) as Array<{ observation: string }>;
  return { r, steps };
}

describe('HTTP Request Tool', () => {
  const tool = (params: DataObject, credentialType: string) =>
    node(
      'Fetch',
      'ai.toolHttpRequest',
      { toolDescription: 'Fetches', ...params },
      { credentials: { [credentialType]: { id: 'c', name: 'c' } } },
    );
  const generic = (url: string) =>
    tool(
      { url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
      'httpHeaderAuth',
    );
  const KEY = { name: 'X-Api-Key', value: 'k-9' };
  const call = (t: WorkflowNode, creds: DataObject, type = 'httpHeaderAuth') =>
    agentWith([t], [toolCalls(['Fetch', {}]), 'done'], { [type]: creds });

  it('refuses another domain with zero requests (generic credential, read by hand)', async () => {
    const { steps } = await call(generic(`${first.url}/data`), { ...KEY, ...restricted('example.com') });
    expect(steps[0].observation).toMatch(/Domain not allowed/);
    expect(first.hits).toHaveLength(0);
  });

  it('sends to a listed domain, with the credential', async () => {
    const { steps } = await call(generic(`${first.url}/data`), { ...KEY, ...restricted('127.0.0.1') });
    expect(steps[0].observation).toBe('FIRST');
    expect(first.hits[0].headers['x-api-key']).toBe('k-9');
  });

  it('"all" and a credential without the fields change nothing', async () => {
    for (const creds of [KEY, { ...KEY, allowedHttpRequestDomains: 'all' }]) {
      first.hits.length = 0;
      const { steps } = await call(generic(`${first.url}/data`), creds);
      expect(steps[0].observation).toBe('FIRST');
      expect(first.hits).toHaveLength(1);
    }
    // a redirect to another host is followed as before
    const { steps } = await call(generic(`${first.url}/redirect`), KEY);
    expect(steps[0].observation).toBe('SECOND');
  });

  it('"none" refuses the credential in this tool', async () => {
    const { steps } = await call(generic(`${first.url}/data`), { ...KEY, allowedHttpRequestDomains: 'none' });
    expect(steps[0].observation).toMatch(/prevent use within an HTTP Request or GraphQL node/);
    expect(first.hits).toHaveLength(0);
  });

  it('refuses a redirect to another domain: the second server sees nothing', async () => {
    const { steps } = await call(generic(`${first.url}/redirect`), { ...KEY, ...restricted('127.0.0.1') });
    expect(steps[0].observation).toMatch(/Domain not allowed/);
    expect(first.hits).toHaveLength(1);
    expect(second.hits).toHaveLength(0);
  });

  it('applies to basic and bearer credentials too', async () => {
    for (const [type, creds] of [
      ['httpBasicAuth', { user: 'u', password: 'p' }],
      ['httpBearerAuth', { token: 't' }],
    ] as const) {
      const t = tool(
        { url: `${first.url}/data`, authentication: 'genericCredentialType', genericAuthType: type },
        type,
      );
      const { steps } = await call(t, { ...creds, ...restricted('example.com') }, type);
      expect(steps[0].observation).toMatch(/Domain not allowed/);
    }
    expect(first.hits).toHaveLength(0);
  });

  it('holds a predefined credential type to its list, and to "none" (the URL is typed by the user)', async () => {
    const predefined = tool(
      {
        url: `${first.url}/data`,
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'openAiApi',
      },
      'openAiApi',
    );
    const key = { apiKey: 'sk-1' };
    const blocked = await call(predefined, { ...key, ...restricted('example.com') }, 'openAiApi');
    expect(blocked.steps[0].observation).toMatch(/Domain not allowed/);
    const none = await call(predefined, { ...key, allowedHttpRequestDomains: 'none' }, 'openAiApi');
    expect(none.steps[0].observation).toMatch(/prevent use within an HTTP Request or GraphQL node/);
    expect(first.hits).toHaveLength(0);
    const allowed = await call(predefined, { ...key, ...restricted('127.0.0.1') }, 'openAiApi');
    expect(allowed.steps[0].observation).toBe('FIRST');
    expect(first.hits[0].headers.authorization).toBe('Bearer sk-1');
  });

  it('withGenericAuth puts the list on the request itself', async () => {
    const ctx = {
      getCredentials: async () => ({ token: 't', ...restricted('a.com, *.b.com') }),
    } as never;
    const request = await withGenericAuth(ctx, 'httpBearerAuth', { url: 'https://a.com/x' }, 0);
    expect(request.allowedDomains).toEqual(['a.com', '*.b.com']);
    expect(request.credentialScope).toBe('userUrl');
    expect(request.headers?.authorization).toBe('Bearer t');
    // nothing is signed for a URL outside the list
    await expect(withGenericAuth(ctx, 'httpBearerAuth', { url: 'https://evil.test/x' }, 0)).rejects.toThrow(
      /Domain not allowed/,
    );
    const plain = await withGenericAuth(
      { getCredentials: async () => ({ token: 't' }) } as never,
      'httpBearerAuth',
      { url: 'https://evil.test/x' },
      0,
    );
    expect('allowedDomains' in plain).toBe(false);
  });
});

describe('MCP Client Tool', () => {
  const mcpNode = (endpoint: string, authentication = 'bearerAuth') =>
    node(
      'MCP',
      'ai.mcpClientTool',
      { endpointUrl: endpoint, authentication },
      { credentials: { httpBearerAuth: { id: 'b', name: 'b' }, httpHeaderAuth: { id: 'h', name: 'h' } } },
    );
  const connectTo = (endpoint: string, creds: Record<string, DataObject>, authentication?: string) =>
    agentWith([mcpNode(endpoint, authentication)], ['nothing to do'], creds);

  it('refuses an endpoint outside the list with zero requests at the server', async () => {
    const { r } = await connectTo(`${mcp.url}/mcp`, {
      httpBearerAuth: { token: 'T', ...restricted('example.com') },
    });
    expect(r.status).toBe('error');
    expect(String(r.error?.message)).toContain('Domain not allowed');
    expect(mcp.hits).toHaveLength(0);
  });

  it('connects to a listed endpoint and sends the bearer token', async () => {
    const { r } = await connectTo(`${mcp.url}/mcp`, {
      httpBearerAuth: { token: 'T', ...restricted('127.0.0.1') },
    });
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(mcp.hits.length).toBeGreaterThan(0);
    expect(mcp.hits[0].headers.authorization).toBe('Bearer T');
  });

  it('"all" and a credential without the fields change nothing', async () => {
    for (const creds of [{ token: 'T' }, { token: 'T', allowedHttpRequestDomains: 'all' }]) {
      mcp.hits.length = 0;
      const { r } = await connectTo(`${mcp.url}/mcp`, { httpBearerAuth: creds });
      expect(r.status).toBe('success');
      expect(mcp.hits.length).toBeGreaterThan(0);
    }
  });

  it('"none" refuses the credential here (the endpoint is typed by the user), for header auth too', async () => {
    const bearer = await connectTo(`${mcp.url}/mcp`, {
      httpBearerAuth: { token: 'T', allowedHttpRequestDomains: 'none' },
    });
    expect(bearer.r.status).toBe('error');
    expect(String(bearer.r.error?.message)).toContain('prevent use within an HTTP Request or GraphQL node');
    const header = await connectTo(
      `${mcp.url}/mcp`,
      { httpHeaderAuth: { name: 'X-Key', value: 'v', ...restricted('example.com') } },
      'headerAuth',
    );
    expect(header.r.status).toBe('error');
    expect(String(header.r.error?.message)).toContain('Domain not allowed');
    expect(mcp.hits).toHaveLength(0);
  });

  it('without a credential nothing is restricted', async () => {
    const { r } = await connectTo(`${mcp.url}/mcp`, {}, 'none');
    expect(r.status).toBe('success');
  });
});

describe('a chat model whose credential carries the base URL', () => {
  const model = (): WorkflowNode => ({
    ...node('OpenAI', 'ai.lmChatOpenAi', {}),
    credentials: { openAiApi: { id: 'c', name: 'c' } },
  });
  const ask = (creds: DataObject) => {
    const fake = new FakeHttpClient(
      sequence({
        body: {
          model: 'm',
          choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        },
      }),
    );
    const m = model();
    return run(
      [node('Trigger', 'test.trigger'), node('Agent', 'ai.agent', { promptType: 'define', text: 'q' }), m],
      connect(['Trigger', 'Agent'], [m.name, 'Agent', 'ai_languageModel']),
      { services: services({ creds: { openAiApi: creds }, http: fake }) },
    ).then((r) => ({ r, fake }));
  };

  it('refuses a base URL outside the credential list: no request is made', async () => {
    const { r, fake } = await ask({
      apiKey: 'sk-test',
      baseUrl: 'https://evil.test/v1',
      ...restricted('api.openai.com'),
    });
    expect(r.status).toBe('error');
    expect(JSON.stringify(r.error)).toContain('Domain not allowed');
    expect(fake.requests).toHaveLength(0);
  });

  it('sends to a base URL inside the list, with the list on the request', async () => {
    const { r, fake } = await ask({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      ...restricted('api.openai.com'),
    });
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].allowedDomains).toEqual(['api.openai.com']);
  });

  it('"none" does not block a model node: its URL comes from the credential', async () => {
    const { r, fake } = await ask({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      allowedHttpRequestDomains: 'none',
    });
    expect(r.status, JSON.stringify(r.error)).toBe('success');
    expect(fake.requests).toHaveLength(1);
    expect('allowedDomains' in fake.requests[0]).toBe(false);
  });

  it('"all" changes nothing: no list on the request', async () => {
    const { r, fake } = await ask({ apiKey: 'sk-test', baseUrl: 'https://api.openai.com/v1' });
    expect(r.status).toBe('success');
    expect('allowedDomains' in fake.requests[0]).toBe(false);
  });
});
