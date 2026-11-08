/** P5-17: MCP client transports (Streamable HTTP, SSE), Multiple Headers, redirect rule, texts, invokeRaw. */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { HttpClient } from '@workflow/core';
import type { DataObject, NodeType } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpClientToolNode } from '../src/nodes/tools/McpClientTool.node';
import { MCP_PROTOCOL_VERSION } from '../src/shared/mcp-client';
import {
  createMcpConnection,
  isMcpAuthFailure,
  type McpConnectionInput,
  mcpConnectFailure,
} from '../src/shared/mcp-connect';
import { MCP_CLIENT_PROPERTIES } from '../src/shared/mcp-description';
import { MAX_SSE_EVENT_CHARS, resolveSseEndpoint } from '../src/shared/mcp-sse';
import { sharedResourceCount } from '../src/shared/shared-resource';

interface Logged {
  method: string;
  path: string;
  host?: string;
  rpc?: string;
  headers: Record<string, string | string[] | undefined>;
  protocol?: string;
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  { name: 'boom', description: 'Fails', inputSchema: { type: 'object', properties: {} } },
];

describe('MCP client transports (P5-17)', () => {
  let server: http.Server;
  let port: number;
  let endpoint: string;
  const log: Logged[] = [];
  let answerVersion: string | undefined;
  let endpointEvent: string | undefined;
  let status: number | undefined;
  /** set when the server sees the oversized event stream closed */
  let hugeClosed = false;
  const streams: ServerResponse[] = [];
  const sockets = new Set<Socket>();

  function result(message: { method: string; params?: DataObject }): unknown {
    if (message.method === 'initialize') {
      return {
        protocolVersion: answerVersion ?? (message.params?.protocolVersion as string),
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1' },
      };
    }
    if (message.method === 'tools/list') return { tools: TOOLS };
    if (message.method === 'tools/call') {
      const params = message.params as { name: string; arguments: { text?: string } };
      return params.name === 'boom'
        ? { content: [{ type: 'text', text: 'it broke' }], isError: true }
        : {
            content: [
              { type: 'text', text: `echo ${params.arguments.text ?? ''}` },
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            ],
            structuredContent: { ok: true },
          };
    }
    return {};
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => resolve(body));
    });
  }

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const body = req.method === 'POST' ? await readBody(req) : '';
      const message = body ? JSON.parse(body) : undefined;
      log.push({
        method: req.method ?? '',
        path: url.pathname,
        host: req.headers.host,
        rpc: message?.method,
        headers: req.headers,
        protocol: req.headers['mcp-protocol-version'] as string | undefined,
      });
      if (url.pathname === '/redir') {
        res.writeHead(307, { location: `http://localhost:${port}/mcp` }).end();
        return;
      }
      if (status) {
        res.writeHead(status).end();
        return;
      }
      if (url.pathname === '/huge' && req.method === 'GET') {
        // one event that never ends: 11 chunks of 1 MB with no blank line
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.on('close', () => {
          hugeClosed = true;
        });
        res.write('event: message\ndata: ');
        const chunk = 'x'.repeat(1024 * 1024);
        for (let i = 0; i < 11 && !res.destroyed; i++) {
          if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
        }
        return;
      }
      if (url.pathname === '/sse' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: endpoint\ndata: ${endpointEvent ?? '/messages?session=s1'}\n\n`);
        streams.push(res);
        return;
      }
      if (url.pathname === '/messages' && req.method === 'POST') {
        res.writeHead(202).end('Accepted');
        if (message && 'id' in message) {
          const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: result(message) });
          // a notification first, to prove replies are matched by id
          const progress = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} });
          streams.at(-1)?.write(`event: message\ndata: ${progress}\n\n`);
          streams.at(-1)?.write(`event: message\ndata: ${payload}\n\n`);
        }
        return;
      }
      if (url.pathname === '/mcp' && req.method === 'POST') {
        if (!message || !('id' in message)) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: result(message) }));
        return;
      }
      res.writeHead(404).end();
    });
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    for (const s of streams) s.end();
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    log.length = 0;
    answerVersion = undefined;
    endpointEvent = undefined;
    status = undefined;
  });
  afterEach(() => {
    for (const s of streams.splice(0)) s.end();
  });

  const client = new HttpClient({ ssrf: { allow: ['127.0.0.1', 'localhost', '::1'] } });
  type Req = Parameters<HttpClient['request']>[0];
  function ctxWith(creds: Record<string, DataObject> = {}) {
    return {
      helpers: {
        httpRequest: (o: Req) => client.request(o),
        httpRequestWithAuthentication: async (type: string, o: Req) => {
          const token = String(creds[type]?.accessToken ?? '');
          return client.request({ ...o, headers: { ...o.headers, authorization: `Bearer ${token}` } });
        },
      },
      getCredentials: async (type: string) => creds[type] ?? {},
    } as unknown as Parameters<typeof createMcpConnection>[0];
  }
  const input = (over: Partial<McpConnectionInput> = {}): McpConnectionInput => ({
    endpointUrl: `${endpoint}/mcp`,
    serverTransport: 'httpStreamable',
    authentication: 'none',
    timeoutMs: 5000,
    ...over,
  });

  it('sends the newer protocol version and accepts an older answer', async () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2025-11-25');
    answerVersion = '2025-03-26';
    const c = await createMcpConnection(ctxWith(), input());
    await c.listTools();
    expect(log.find((l) => l.rpc === 'initialize')).toBeDefined();
    // later requests carry the version the server answered
    expect(log.find((l) => l.rpc === 'tools/list')?.protocol).toBe('2025-03-26');
    await c.close();
  });

  it('lists and calls tools over SSE, replies matched by id', async () => {
    const c = await createMcpConnection(
      ctxWith(),
      input({ endpointUrl: `${endpoint}/sse`, serverTransport: 'sse' }),
    );
    expect((await c.listTools()).map((t) => t.name)).toEqual(['echo', 'boom']);
    const r = await c.callTool('echo', { text: 'hi' });
    expect(r.content?.[0]).toEqual({ type: 'text', text: 'echo hi' });
    expect(log.filter((l) => l.method === 'GET' && l.path === '/sse')).toHaveLength(1);
    expect(log.filter((l) => l.path === '/messages').map((l) => l.rpc)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]);
    await c.close();
  });

  it('refuses an endpoint event that names another origin', async () => {
    endpointEvent = 'http://localhost:1/steal';
    await expect(
      createMcpConnection(ctxWith(), input({ endpointUrl: `${endpoint}/sse`, serverTransport: 'sse' })),
    ).rejects.toThrow(/another origin/);
    expect(log.some((l) => l.path === '/steal')).toBe(false);
    expect(log.some((l) => l.method === 'POST')).toBe(false);
    // the origin rule itself: a relative path is fine, another port or scheme is not
    expect(resolveSseEndpoint('/m?a=1', `${endpoint}/sse`)).toBe(`${endpoint}/m?a=1`);
    expect(resolveSseEndpoint(`http://127.0.0.1:${port + 1}/m`, `${endpoint}/sse`)).toBeUndefined();
    expect(resolveSseEndpoint(`https://127.0.0.1:${port}/m`, `${endpoint}/sse`)).toBeUndefined();
  });

  it('sends every Multiple Headers row, on both transports', async () => {
    const creds = {
      httpMultipleHeadersAuth: {
        headers: {
          values: [
            { name: 'X-Api-Key', value: 'k1' },
            { name: 'X-Tenant', value: 'acme' },
            { name: ' ', value: 'skipped' },
          ],
        },
      },
    };
    for (const [path, serverTransport] of [
      ['mcp', 'httpStreamable'],
      ['sse', 'sse'],
    ] as const) {
      log.length = 0;
      const c = await createMcpConnection(
        ctxWith(creds),
        input({ endpointUrl: `${endpoint}/${path}`, serverTransport, authentication: 'multipleHeadersAuth' }),
      );
      await c.listTools();
      await c.close();
      const sent = log.filter((l) => l.method !== 'DELETE');
      expect(sent.length).toBeGreaterThan(2);
      for (const l of sent) {
        expect(l.headers['x-api-key']).toBe('k1');
        expect(l.headers['x-tenant']).toBe('acme');
      }
    }
  });

  it('refuses a 307 to another host with a header credential, follows it with none', async () => {
    const creds = { httpHeaderAuth: { name: 'X-Key', value: 'secret' } };
    await expect(
      createMcpConnection(
        ctxWith(creds),
        input({ endpointUrl: `${endpoint}/redir`, authentication: 'headerAuth' }),
      ),
    ).rejects.toThrow();
    expect(log.some((l) => l.host === `localhost:${port}`)).toBe(false);

    log.length = 0;
    const c = await createMcpConnection(ctxWith(), input({ endpointUrl: `${endpoint}/redir` }));
    await c.listTools();
    await c.close();
    expect(log.some((l) => l.host === `localhost:${port}` && l.rpc === 'initialize')).toBe(true);
  });

  it('applies the MCP OAuth2 credential through the authenticated request helper', async () => {
    const creds = { mcpOAuth2Api: { accessToken: 'tok-1' } };
    const c = await createMcpConnection(ctxWith(creds), input({ authentication: 'mcpOAuth2Api' }));
    await c.listTools();
    await c.close();
    const posts = log.filter((l) => l.method === 'POST');
    expect(posts.length).toBeGreaterThan(2);
    expect(posts.every((l) => l.headers.authorization === 'Bearer tok-1')).toBe(true);
  });

  it("gives n8n's connection, authentication and URL texts, with the reason as the description", async () => {
    status = 401;
    const bad = await createMcpConnection(ctxWith(), input()).catch((e) => e);
    expect(isMcpAuthFailure(bad)).toBe(true);
    expect(mcpConnectFailure(bad)).toEqual({
      message: 'Could not connect to your MCP server. Authentication failed.',
      description: expect.stringMatching(/401/),
    });
    status = undefined;
    expect(mcpConnectFailure(new Error('connect ECONNREFUSED'))).toEqual({
      message: 'Could not connect to your MCP server',
      description: 'connect ECONNREFUSED',
    });
    // a message that names the status counts, as in n8n
    expect(isMcpAuthFailure(new Error('Request failed with status code 403'))).toBe(true);
    expect(isMcpAuthFailure(new Error('connect ECONNREFUSED 127.0.0.1:4013'))).toBe(false);
    const url = await createMcpConnection(ctxWith(), input({ endpointUrl: 'ftp://example.com/mcp' })).catch(
      (e) => e,
    );
    expect(mcpConnectFailure(url).message).toBe(
      'Could not connect to your MCP server. The provided URL is invalid.',
    );
    // an event stream the server refuses is the same failure
    status = 403;
    const sse = await createMcpConnection(
      ctxWith(),
      input({ endpointUrl: `${endpoint}/sse`, serverTransport: 'sse' }),
    ).catch((x) => x);
    expect(mcpConnectFailure(sse).message).toBe(
      'Could not connect to your MCP server. Authentication failed.',
    );
  });

  it('closes an SSE connection whose event grows past the size cap', async () => {
    expect(MAX_SSE_EVENT_CHARS).toBe(10 * 1024 * 1024);
    hugeClosed = false;
    await expect(
      createMcpConnection(ctxWith(), input({ endpointUrl: `${endpoint}/huge`, serverTransport: 'sse' })),
    ).rejects.toThrow(
      "Couldn't read the MCP event stream: one event is over 10 MB, so the connection was closed",
    );
    await vi.waitFor(() => expect(hugeClosed).toBe(true));
  });

  it('offers the two transports, SSE marked deprecated, and the five authentications', () => {
    const transport = MCP_CLIENT_PROPERTIES.find((p) => p.name === 'serverTransport');
    expect(transport?.default).toBe('httpStreamable');
    const options = transport?.options as Array<{ name: string; value: string }>;
    expect(options.map((o) => [o.value, o.name])).toEqual([
      ['httpStreamable', 'HTTP Streamable'],
      ['sse', 'Server Sent Events (Deprecated)'],
    ]);
    const auth = MCP_CLIENT_PROPERTIES.find((p) => p.name === 'authentication');
    expect(((auth?.options ?? []) as Array<{ value: string }>).map((o) => o.value)).toEqual([
      'none',
      'bearerAuth',
      'headerAuth',
      'multipleHeadersAuth',
      'mcpOAuth2Api',
    ]);
  });

  it('invokeRaw keeps the content array, invoke gives the flat text', async () => {
    const params: Record<string, unknown> = {
      endpointUrl: `${endpoint}/sse`,
      serverTransport: 'sse',
      authentication: 'none',
      include: 'all',
      options: {},
    };
    const ctx = {
      ...ctxWith(),
      getNodeParameter: (name: string, _i: number, fallback?: unknown) => params[name] ?? fallback,
      getNode: () => ({ name: 'MCP' }),
      getTenantId: () => 't1',
      getExecutionId: () => 'e-raw',
      logSubNodeRun: () => {},
    };
    const supply = (McpClientToolNode as NodeType).supplyData as (c: unknown, i: number) => Promise<any>;
    const { response, closeFunction } = await supply(ctx, 0);
    const echo = response.find((t: { name: string }) => t.name === 'echo');
    const raw = await echo.invokeRaw({ text: 'x' });
    expect(raw.content).toEqual([
      { type: 'text', text: 'echo x' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
    expect(raw.structuredContent).toEqual({ ok: true });
    expect(await echo.invoke({ text: 'y' })).toBe('echo y\n[image image/png]');
    const boom = response.find((t: { name: string }) => t.name === 'boom');
    expect((await boom.invokeRaw({})).isError).toBe(true);
    await expect(boom.invoke({})).rejects.toThrow('it broke');
    await closeFunction();
    expect(sharedResourceCount()).toBe(0);
  });

  it("stops with n8n's text when no tool is left to offer, and closes the session", async () => {
    const params: Record<string, unknown> = {
      endpointUrl: `${endpoint}/mcp`,
      serverTransport: 'httpStreamable',
      authentication: 'none',
      include: 'selected',
      includeTools: ['missing'],
      options: {},
    };
    const ctx = {
      ...ctxWith(),
      getNodeParameter: (name: string, _i: number, fallback?: unknown) => params[name] ?? fallback,
      getNode: () => ({ name: 'MCP' }),
      getTenantId: () => 't1',
      getExecutionId: () => 'e-none',
      logSubNodeRun: () => {},
    };
    const supply = (McpClientToolNode as NodeType).supplyData as (c: unknown, i: number) => Promise<unknown>;
    await expect(supply(ctx, 0)).rejects.toThrow('MCP Server returned no tools');
    expect(sharedResourceCount()).toBe(0);
  });
});
