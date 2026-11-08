/**
 * Model Context Protocol wire contracts shared by the MCP Server Trigger, the workspace MCP server
 * and the MCP Client nodes: JSON-RPC 2.0 shapes, protocol revisions, error codes and the helpers
 * that read and answer one message. Isomorphic: no Node API, no SDK types.
 */
import type { JsonSchema } from './ai-types';
import type { DataObject } from './interfaces';

/** the revision this server speaks first (2026: no `initialize`, `server/discover`, per-request `_meta`) */
export const MCP_LATEST_REVISION = '2026-07-28';

/** older revisions still answered (stateless `initialize` fallback), newest first */
export const MCP_LEGACY_REVISIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

/** JSON-RPC and MCP error codes; `HEADER_MISMATCH` is the 2026 routing header check */
export const MCP_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HEADER_MISMATCH: -32020,
} as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: DataObject;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: DataObject;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** one answer: `result` on success, `error` on failure (never both) */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcErrorObject;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: DataObject;
}

/** a `tools/call` result as the server sends it (content array kept, not flattened to text) */
export interface McpCallResult {
  content: Array<DataObject & { type: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** one parsed POST body */
export type McpMessage =
  | { kind: 'request'; message: JsonRpcRequest }
  | { kind: 'notification'; message: JsonRpcNotification }
  | { kind: 'response' }
  | { kind: 'invalid'; id: string | number | null; code: number; text: string };

/** who the server is, for `initialize` and `server/discover` */
export interface McpServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

/** request headers as Fastify and Node give them (names lower-cased) */
export type McpRequestHeaders = Record<string, string | string[] | undefined>;

/** the `_meta` key of a 2026 request's protocol revision */
export const MCP_PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';

/** the `_meta` key under which a 2026 result names the server */
export const MCP_SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';

/**
 * The webhook name the server calls the MCP Server Trigger with to answer `tools/list`: the context's sub-nodes
 * then get the base item of the same request (`{ body, headers, user? }`), the item a tool sees at a call. The node
 * authenticates under this name like under any other; no route serves it.
 */
export const MCP_TOOLS_LIST_HOOK = 'mcpToolsList';

/** 2026 results whose answer a client may cache (they carry `ttlMs` and `cacheScope`) */
const CACHEABLE_METHODS: readonly string[] = ['tools/list', 'server/discover'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is JsonRpcId =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

const invalid = (
  id: JsonRpcId | null,
  text: string,
  code: number = MCP_ERRORS.INVALID_REQUEST,
): McpMessage => ({
  kind: 'invalid',
  id,
  code,
  text,
});

/** Reads one POST body. An array (batch) is `invalid` -32600; a body with `result` or `error` is a `response`. */
export function parseMcpMessage(body: unknown): McpMessage {
  // batching left the protocol in 2025-06-18; an unbounded batch is also a resource risk
  if (Array.isArray(body)) return invalid(null, 'Batch requests are not supported');
  if (!isObject(body)) return invalid(null, 'Invalid Request: the body must be a JSON-RPC message');
  const id = isId(body.id) ? body.id : null;
  if (body.jsonrpc !== '2.0') return invalid(id, 'Invalid Request: jsonrpc must be "2.0"');
  const answers = 'result' in body || 'error' in body;
  if (answers) {
    if ('method' in body) return invalid(id, 'Invalid Request: a message is either a request or a response');
    return { kind: 'response' };
  }
  if (typeof body.method !== 'string' || !body.method)
    return invalid(id, 'Invalid Request: method is required');
  if (body.params !== undefined && !isObject(body.params)) {
    return invalid(id, 'Invalid Request: params must be an object');
  }
  const params = body.params === undefined ? {} : { params: body.params as DataObject };
  if (!('id' in body) || body.id === undefined) {
    return { kind: 'notification', message: { jsonrpc: '2.0', method: body.method, ...params } };
  }
  if (id === null) return invalid(null, 'Invalid Request: id must be a string or a number');
  return { kind: 'request', message: { jsonrpc: '2.0', id, method: body.method, ...params } };
}

/** The revision to answer with: the requested one when supported, else `MCP_LATEST_REVISION`. */
export function negotiateMcpVersion(requested: unknown): string {
  if (typeof requested !== 'string') return MCP_LATEST_REVISION;
  if (requested === MCP_LATEST_REVISION || MCP_LEGACY_REVISIONS.includes(requested)) return requested;
  return MCP_LATEST_REVISION;
}

export function mcpResult(id: JsonRpcId | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function mcpError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** the `initialize` result (2025 revisions): protocol version, capabilities `tools`, server info, instructions */
export function mcpInitializeResult(input: McpServerInfo & { protocolVersion: string }): DataObject {
  return {
    protocolVersion: input.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: input.name, version: input.version },
    ...(input.instructions ? { instructions: String(input.instructions) } : {}),
  };
}

/** the `server/discover` result (2026 revision): supported versions, capabilities, server info, instructions */
export function mcpDiscoverResult(input: McpServerInfo): DataObject {
  return {
    resultType: 'complete',
    ttlMs: 0,
    cacheScope: 'private',
    supportedVersions: [MCP_LATEST_REVISION, ...MCP_LEGACY_REVISIONS],
    capabilities: { tools: {} },
    ...(input.instructions ? { instructions: String(input.instructions) } : {}),
    _meta: { [MCP_SERVER_INFO_META]: { name: input.name, version: input.version } },
  };
}

/** the revision a 2026 request names in its `_meta` envelope, if any */
export function mcpEnvelopeVersion(message: JsonRpcRequest | JsonRpcNotification): string | undefined {
  const meta = message.params?._meta;
  const version = isObject(meta) ? meta[MCP_PROTOCOL_VERSION_META] : undefined;
  return typeof version === 'string' ? version : undefined;
}

/** A 2026 request: `server/discover`, or a request whose envelope names the 2026 revision (no session). */
export function isModernMcpRequest(message: JsonRpcRequest | JsonRpcNotification): boolean {
  return message.method === 'server/discover' || mcpEnvelopeVersion(message) === MCP_LATEST_REVISION;
}

/** A result as the 2026 revision sends it: `resultType: 'complete'`, plus cache hints on cacheable lists. */
export function mcpCompleteResult(method: string, result: DataObject): DataObject {
  return {
    ...result,
    resultType: 'complete',
    ...(CACHEABLE_METHODS.includes(method) ? { ttlMs: 0, cacheScope: 'private' } : {}),
  };
}

const firstHeader = (headers: McpRequestHeaders, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const BASE64_PREFIX = '=?base64?';
const BASE64_SUFFIX = '?=';

/** an `Mcp-Name` value: plain, or UTF-8 in base64 between `=?base64?` and `?=` */
function decodeHeaderValue(value: string): string | undefined {
  if (!value.startsWith(BASE64_PREFIX) || !value.endsWith(BASE64_SUFFIX)) return value;
  try {
    const binary = atob(value.slice(BASE64_PREFIX.length, value.length - BASE64_SUFFIX.length));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * 2026 routing headers: `mcp-method` must equal the body's method and `mcp-name` the tool name of a
 * `tools/call`; null when they match, else `{ code: MCP_ERRORS.HEADER_MISMATCH, text }`. A 2026 request must
 * send them; on a 2025 request they are checked only when present.
 */
export function checkMcpRoutingHeaders(
  headers: McpRequestHeaders,
  message: JsonRpcRequest,
): { code: number; text: string } | null {
  const required = isModernMcpRequest(message);
  const method = firstHeader(headers, 'mcp-method');
  if ((method !== undefined || required) && method !== message.method) {
    return { code: MCP_ERRORS.HEADER_MISMATCH, text: 'The Mcp-Method header does not match the request' };
  }
  if (message.method !== 'tools/call') return null;
  const name = firstHeader(headers, 'mcp-name');
  if (name === undefined && !required) return null;
  if (name === undefined || decodeHeaderValue(name) !== message.params?.name) {
    return { code: MCP_ERRORS.HEADER_MISMATCH, text: 'The Mcp-Name header does not match the request' };
  }
  return null;
}

/** A tool's value as an MCP result: a string as is, anything else as JSON text. */
export function mcpResultFromValue(value: unknown): McpCallResult {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value === undefined) text = '';
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return { content: [{ type: 'text', text }] };
}

/** A failed tool call: one text part `<toolName>: <message>` and `isError: true`. */
export function mcpErrorResult(toolName: string, message: string): McpCallResult {
  return { content: [{ type: 'text', text: `${toolName}: ${message}` }], isError: true };
}
