/**
 * A hand-written MCP server over Streamable HTTP on 127.0.0.1 for the Assistant's MCP tests (P5-72, lane
 * L9). No MCP SDK: it answers JSON-RPC over POST (`initialize`, `notifications/initialized`, `tools/list`,
 * `tools/call`), hands out a session id on `initialize`, ends a session on DELETE and counts the sessions
 * that are open, so a test can prove the Assistant closes what it opens.
 *
 * Tests set a tool's `call` to script a result (text, an error, an injection) and read `requests` /
 * `calls` to see what arrived (headers included, so a bearer can be checked). `/redirect` answers 307 to
 * `redirectTo`, for the "no credential across a redirect" test.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeMcpContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface FakeMcpCallResult {
  content: FakeMcpContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** the result of a call; a string is one text part */
  call?(args: Record<string, unknown>): FakeMcpCallResult | string;
}

export interface FakeMcpOptions {
  tools?: FakeMcpTool[];
  /** when set, every MCP request must carry `Authorization: Bearer <bearer>`, else 401 */
  bearer?: string;
  /** when set, every MCP request must carry this header (name lower case) with this value, else 401 */
  header?: { name: string; value: string };
}

export interface FakeMcpRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface FakeMcpServer {
  /** `http://127.0.0.1:<port>/mcp` */
  url: string;
  port: number;
  /** the tools the server lists (change them between calls) */
  tools: FakeMcpTool[];
  /** every request, in order */
  requests: FakeMcpRequest[];
  /** every `tools/call`: the tool, its arguments and the Authorization header it came with */
  calls: Array<{ name: string; args: Record<string, unknown>; authorization: string | undefined }>;
  /** sessions opened by `initialize` and not yet ended by DELETE */
  readonly openSessions: number;
  /** all sessions ever opened */
  readonly sessionsOpened: number;
  /** where `/redirect` sends the client (307) */
  redirectTo: string | undefined;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startFakeMcpServer(options: FakeMcpOptions = {}): Promise<FakeMcpServer> {
  const sessions = new Set<string>();
  let sessionsOpened = 0;
  const state: FakeMcpServer = {
    url: '',
    port: 0,
    tools: [...(options.tools ?? [])],
    requests: [],
    calls: [],
    get openSessions() {
      return sessions.size;
    },
    get sessionsOpened() {
      return sessionsOpened;
    },
    redirectTo: undefined,
    close: async () => {},
  };

  const server: Server = createServer(async (request, response) => {
    const body = await readBody(request);
    const path = (request.url ?? '/').split('?')[0];
    state.requests.push({ method: request.method ?? 'GET', path, headers: request.headers, body });

    if (path === '/redirect') {
      response.writeHead(307, { location: state.redirectTo ?? '/mcp' });
      response.end();
      return;
    }
    if (options.bearer !== undefined && request.headers.authorization !== `Bearer ${options.bearer}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (options.header && request.headers[options.header.name] !== options.header.value) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (request.method === 'DELETE') {
      const id = String(request.headers['mcp-session-id'] ?? '');
      sessions.delete(id);
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return;
    }

    const message = body as { id?: number | string; method?: string; params?: Record<string, unknown> };
    const reply = (result: unknown, headers: Record<string, string> = {}) => {
      response.writeHead(200, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };

    if (message?.id === undefined) {
      // a notification
      response.writeHead(202);
      response.end();
      return;
    }
    switch (message.method) {
      case 'initialize': {
        const id = randomUUID();
        sessions.add(id);
        sessionsOpened += 1;
        reply(
          {
            protocolVersion: String(message.params?.protocolVersion ?? '2025-11-25'),
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-mcp', version: '1.0.0' },
          },
          { 'mcp-session-id': id },
        );
        return;
      }
      case 'tools/list':
        reply({
          tools: state.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          })),
        });
        return;
      case 'tools/call': {
        const name = String(message.params?.name ?? '');
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        state.calls.push({ name, args, authorization: request.headers.authorization });
        const tool = state.tools.find((candidate) => candidate.name === name);
        if (!tool) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32602, message: 'Unknown tool' },
            }),
          );
          return;
        }
        const out = tool.call ? tool.call(args) : `called ${name}`;
        reply(typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out);
        return;
      }
      default:
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        );
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  state.url = `http://127.0.0.1:${state.port}/mcp`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}
