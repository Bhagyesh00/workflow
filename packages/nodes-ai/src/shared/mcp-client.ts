/**
 * Model Context Protocol client over the Streamable HTTP transport, built on the node HTTP
 * helper (SSRF guard included): JSON-RPC 2.0 requests are POSTed to one endpoint, and the
 * server answers with `application/json` or a `text/event-stream` carrying the response.
 * The server may assign a session (`Mcp-Session-Id`), which is sent on every later request;
 * an expired session (404) is re-initialized once.
 */
import type { DataObject, HttpFullResponse, HttpRequestOptions } from '@workflow/workflow';
import { sseJson } from './sse';
import { truncate } from './utils';

/** what we ask for; the version the server answers is used from then on (older servers are accepted) */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: DataObject;
  /** the server's tool annotations (for example `readOnlyHint`), as `McpToolDescriptor`: untrusted hints */
  annotations?: DataObject;
}

export interface McpToolResult {
  content?: Array<DataObject & { type: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export type McpTransport = (request: HttpRequestOptions) => Promise<HttpFullResponse<string>>;

function isPlainObject(value: unknown): value is DataObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    /** the HTTP status when the server refused the request itself */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export class McpClient {
  private sessionId?: string;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private initialized = false;
  private nextId = 1;
  serverInfo?: DataObject;

  constructor(
    private readonly transport: McpTransport,
    private readonly endpoint: string,
    private readonly extraHeaders: Record<string, string> = {},
    private readonly timeoutMs = 60_000,
    /** ends what the transport holds open (the SSE stream); runs on `close` */
    private readonly onClose?: () => Promise<void>,
  ) {}

  async connect(): Promise<void> {
    this.initialized = false;
    this.sessionId = undefined;
    const result = (await this.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'workflow-platform', version: '0.1.0' },
      },
      false,
    )) as DataObject;
    if (typeof result?.protocolVersion === 'string') this.protocolVersion = result.protocolVersion;
    this.serverInfo = result?.serverInfo as DataObject | undefined;
    this.initialized = true;
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = (await this.request('tools/list', cursor ? { cursor } : {})) as {
        tools?: McpTool[];
        nextCursor?: string;
      };
      for (const tool of result?.tools ?? []) {
        if (!tool || typeof tool.name !== 'string') continue;
        // annotations are kept only as a plain object, so readers never meet another shape
        const { annotations, ...rest } = tool;
        tools.push(isPlainObject(annotations) ? { ...rest, annotations } : rest);
      }
      if (!result?.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: DataObject): Promise<McpToolResult> {
    return ((await this.request('tools/call', { name, arguments: args })) ?? {}) as McpToolResult;
  }

  /** end the session; servers may not support explicit termination (405), which is fine */
  async close(): Promise<void> {
    try {
      await this.endSession();
    } finally {
      await this.onClose?.().catch(() => undefined);
    }
  }

  private async endSession(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.transport({
        url: this.endpoint,
        method: 'DELETE',
        headers: this.headers(),
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        responseType: 'text',
        timeout: 5000,
      });
    } catch {
      /* best effort */
    }
    this.sessionId = undefined;
  }

  private headers(): Record<string, string> {
    return {
      ...this.extraHeaders,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.initialized ? { 'mcp-protocol-version': this.protocolVersion } : {}),
    };
  }

  private post(message: DataObject): Promise<HttpFullResponse<string>> {
    return this.transport({
      url: this.endpoint,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(message),
      bodyType: 'raw',
      responseType: 'text',
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      timeout: this.timeoutMs,
    });
  }

  private async notify(method: string, params?: DataObject): Promise<void> {
    const response = await this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    if (response.statusCode >= 400) {
      throw new McpError(
        `MCP server rejected ${method} with HTTP ${response.statusCode}`,
        undefined,
        response.statusCode,
      );
    }
  }

  private async request(method: string, params: DataObject, retryOnExpiredSession = true): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method, params });
    const assigned = header(response, 'mcp-session-id');
    if (assigned) this.sessionId = assigned;
    if (response.statusCode === 404 && this.sessionId && retryOnExpiredSession && method !== 'initialize') {
      await this.connect();
      return this.request(method, params, false);
    }
    if (response.statusCode >= 400) {
      throw new McpError(
        `MCP server answered ${method} with HTTP ${response.statusCode}${
          response.body ? `: ${truncate(String(response.body), 300)}` : ''
        }`,
        undefined,
        response.statusCode,
      );
    }
    const message = findResponse(response, id);
    if (!message) throw new McpError(`MCP server sent no response to ${method}`);
    if (message.error) {
      const error = message.error as { code?: number; message?: string };
      throw new McpError(
        `MCP error ${error.code ?? ''}: ${error.message ?? 'unknown error'}`.trim(),
        error.code,
      );
    }
    return message.result;
  }
}

function header(response: HttpFullResponse<string>, name: string): string | undefined {
  const entry = Object.entries(response.headers ?? {}).find(([k]) => k.toLowerCase() === name);
  return entry?.[1];
}

function findResponse(response: HttpFullResponse<string>, id: number): DataObject | undefined {
  const contentType = header(response, 'content-type') ?? '';
  const body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? '');
  const candidates: unknown[] = [];
  if (/text\/event-stream/i.test(contentType)) {
    for (const event of sseJson(body))
      candidates.push(...(Array.isArray(event.json) ? event.json : [event.json]));
  } else if (body.trim()) {
    try {
      const parsed = JSON.parse(body);
      candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      throw new McpError(`MCP server returned invalid JSON: ${truncate(body, 200)}`);
    }
  }
  return candidates.find(
    (m): m is DataObject =>
      Boolean(m) &&
      typeof m === 'object' &&
      (m as DataObject).id === id &&
      ('result' in (m as DataObject) || 'error' in (m as DataObject)),
  );
}

/** Text the model sees for a tool result; image and binary parts are summarized. */
export function mcpResultText(result: McpToolResult): string {
  const parts = (result.content ?? []).map((c) => {
    if (c.type === 'text') return String(c.text ?? '');
    if (c.type === 'resource') {
      const resource = (c.resource ?? {}) as DataObject;
      return typeof resource.text === 'string' ? resource.text : `[resource ${String(resource.uri ?? '')}]`;
    }
    if (c.type === 'resource_link') return `[resource ${String(c.uri ?? '')}]`;
    if (c.type === 'image' || c.type === 'audio') return `[${c.type} ${String(c.mimeType ?? '')}]`;
    return JSON.stringify(c);
  });
  if (!parts.length && result.structuredContent !== undefined)
    return JSON.stringify(result.structuredContent);
  return parts.join('\n');
}
